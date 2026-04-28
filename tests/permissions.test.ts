import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Agent,
  AgentTool,
  AgentJobGetTool,
  AgentJobListTool,
  AgentJobStopTool,
  GlobTool,
  EnterWorktreeTool,
  SkillTool,
  clearAgents,
  clearAgentJobs,
  clearSkills,
  createAgentJob,
  getAgentJob,
  getRegisteredAgentDefinitions,
  listAgentJobs,
  registerAgents,
  registerSkill,
} from '../src/index.ts'
import type { CreateMessageParams, CreateMessageResponse, LLMProvider, SDKMessage, ToolDefinition } from '../src/index.ts'

class StubProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  calls: CreateMessageParams[] = []

  constructor(private readonly responses: Array<CreateMessageResponse | Error>) {}

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.calls.push(params)
    const response = this.responses.shift()
    if (response instanceof Error) {
      throw response
    }
    return response ?? textResponse('done')
  }
}

function textResponse(text: string): CreateMessageResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function toolUseResponse(input: unknown, name = 'capture'): CreateMessageResponse {
  return {
    content: [{ type: 'tool_use', id: 'tool-1', name, input }],
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function multiToolUseResponse(inputs: unknown[], name = 'capture'): CreateMessageResponse {
  return {
    content: inputs.map((input, index) => ({
      type: 'tool_use' as const,
      id: `tool-${index + 1}`,
      name,
      input,
    })),
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function captureTool(onInput?: (input: unknown) => void | Promise<void>, options: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: options.name || 'capture',
    description: 'Capture input for permission tests',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
    },
    call: async (input) => {
      await onInput?.(input)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify(input),
      }
    },
    ...options,
  }
}

async function collectEvents(agent: Agent, prompt = 'test permissions'): Promise<SDKMessage[]> {
  const events: SDKMessage[] = []
  for await (const event of agent.query(prompt)) {
    events.push(event)
  }
  return events
}

async function eventually(assertion: () => Promise<void>, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  let lastError: unknown

  while (Date.now() - start < timeoutMs) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  if (lastError) throw lastError
  throw new Error('eventually timed out')
}

test('default permission mode is trustedAutomation in init event', async () => {
  const agent = new Agent({ model: 'gpt-5.4', tools: [] })
  ;(agent as any).provider = new StubProvider([textResponse('ok')])

  try {
    const events = await collectEvents(agent)
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init')

    assert.ok(init)
    assert.equal(init.permission_mode, 'trustedAutomation')
  } finally {
    await agent.close()
  }
})

test('custom permission mode is reflected in init event', async () => {
  const agent = new Agent({ model: 'gpt-5.4', tools: [], permissionMode: 'acceptEdits' })
  ;(agent as any).provider = new StubProvider([textResponse('ok')])

  try {
    const events = await collectEvents(agent)
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init')

    assert.ok(init)
    assert.equal(init.permission_mode, 'acceptEdits')
  } finally {
    await agent.close()
  }
})

test('allowedTools filtering controls init tools', async () => {
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [captureTool(), { ...captureTool(), name: 'other' }],
    allowedTools: ['capture'],
  })
  ;(agent as any).provider = new StubProvider([textResponse('ok')])

  try {
    const events = await collectEvents(agent)
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init')

    assert.ok(init)
    assert.deepEqual(init.tools, ['capture'])
  } finally {
    await agent.close()
  }
})

test('default system prompt includes enabled tool prompt guidance', async () => {
  const provider = new StubProvider([textResponse('ok')])
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [
      captureTool(undefined, {
        prompt: async () => 'Use capture for explicit test-only input capture.',
      }),
      captureTool(undefined, {
        name: 'disabledTool',
        description: 'Disabled test tool',
        isEnabled: () => false,
        prompt: async () => 'UNIQUE_DISABLED_TOOL_PROMPT',
      }),
    ],
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)

    assert.match(provider.calls[0]?.system || '', /# Tool Guidance/)
    assert.match(provider.calls[0]?.system || '', /## capture/)
    assert.match(provider.calls[0]?.system || '', /Use capture for explicit test-only input capture/)
    assert.doesNotMatch(provider.calls[0]?.system || '', /UNIQUE_DISABLED_TOOL_PROMPT/)
  } finally {
    await agent.close()
  }
})

test('tool prompt guidance truncates oversized fragments and continues collecting later prompts', async () => {
  const provider = new StubProvider([textResponse('ok')])
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [
      captureTool(undefined, {
        name: 'largePrompt',
        description: 'Large prompt tool',
        prompt: async () => `LARGE_PROMPT_START ${'x'.repeat(9_000)} LARGE_PROMPT_END`,
      }),
      captureTool(undefined, {
        name: 'laterPrompt',
        description: 'Later prompt tool',
        prompt: async () => 'UNIQUE_LATER_TOOL_GUIDANCE',
      }),
    ],
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)

    const system = provider.calls[0]?.system || ''
    assert.match(system, /LARGE_PROMPT_START/)
    assert.match(system, /\.\.\.\(tool guidance truncated\)\.\.\./)
    assert.doesNotMatch(system, /LARGE_PROMPT_END/)
    assert.match(system, /UNIQUE_LATER_TOOL_GUIDANCE/)
  } finally {
    await agent.close()
  }
})

test('tool prompt guidance skips prompt errors and continues collecting later prompts', async () => {
  const provider = new StubProvider([textResponse('ok')])
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [
      captureTool(undefined, {
        name: 'throwingPrompt',
        description: 'Throwing prompt tool',
        prompt: async () => {
          throw new Error('prompt failure')
        },
      }),
      captureTool(undefined, {
        name: 'laterPrompt',
        description: 'Later prompt tool',
        prompt: async () => 'UNIQUE_PROMPT_AFTER_THROW',
      }),
    ],
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)

    const system = provider.calls[0]?.system || ''
    assert.doesNotMatch(system, /prompt failure/)
    assert.match(system, /UNIQUE_PROMPT_AFTER_THROW/)
  } finally {
    await agent.close()
  }
})

test('SkillTool prompt uses registry formatter with triggers and enabled skills only', async () => {
  const context = { runtimeNamespace: 'skill-prompt-system-test' }
  clearSkills(context)

  registerSkill({
    name: 'tenant-review',
    description: 'Tenant-specific review workflow',
    whenToUse: 'user asks for a tenant-specific review',
    argumentHint: 'scope or file path',
    userInvocable: true,
    async getPrompt() {
      return [{ type: 'text', text: 'review tenant scope' }]
    },
  }, context)
  registerSkill({
    name: 'disabled-route',
    description: 'UNIQUE_DISABLED_SKILL_DESCRIPTION',
    whenToUse: 'UNIQUE_DISABLED_SKILL_TRIGGER',
    userInvocable: true,
    isEnabled: () => false,
    async getPrompt() {
      return [{ type: 'text', text: 'disabled' }]
    },
  }, context)

  const provider = new StubProvider([textResponse('ok')])
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [SkillTool],
    runtimeNamespace: context.runtimeNamespace,
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)

    const system = provider.calls[0]?.system || ''
    assert.match(system, /# Tool Guidance/)
    assert.match(system, /Available skills:/)
    assert.match(system, /tenant-review: Tenant-specific review workflow/)
    assert.match(system, /TRIGGER when: user asks for a tenant-specific review/)
    assert.doesNotMatch(system, /UNIQUE_DISABLED_SKILL_DESCRIPTION/)
    assert.doesNotMatch(system, /UNIQUE_DISABLED_SKILL_TRIGGER/)
  } finally {
    clearSkills(context)
    await agent.close()
  }
})

test('inline SkillTool activation injects prompt, model override, and allowed tools', async () => {
  const context = { runtimeNamespace: 'skill-activation-inline-test' }
  clearSkills(context)

  registerSkill({
    name: 'focused-review',
    description: 'Focused review workflow',
    allowedTools: ['capture'],
    model: 'skill-model',
    userInvocable: true,
    async getPrompt(args) {
      return [{ type: 'text', text: `UNIQUE_SKILL_PROMPT ${args}` }]
    },
  }, context)

  const provider = new StubProvider([
    toolUseResponse({ skill: 'focused-review', args: 'src/engine.ts' }, 'Skill'),
    toolUseResponse({ value: 'from skill' }, 'capture'),
    textResponse('done'),
  ])
  const agent = new Agent({
    model: 'base-model',
    tools: [
      SkillTool,
      captureTool(),
      captureTool(undefined, { name: 'other' }),
    ],
    runtimeNamespace: context.runtimeNamespace,
  })
  ;(agent as any).provider = provider

  try {
    const events = await collectEvents(agent)
    const final = events.find((event) => event.type === 'result')

    assert.equal(provider.calls[0]?.model, 'base-model')
    assert.doesNotMatch(provider.calls[0]?.system || '', /UNIQUE_SKILL_PROMPT/)

    assert.equal(provider.calls[1]?.model, 'skill-model')
    assert.match(provider.calls[1]?.system || '', /# Active Skill: focused-review/)
    assert.match(provider.calls[1]?.system || '', /UNIQUE_SKILL_PROMPT src\/engine\.ts/)
    assert.deepEqual(provider.calls[1]?.tools?.map((tool) => tool.name), ['Skill', 'capture'])

    assert.equal(provider.calls[2]?.model, 'skill-model')
    assert.match(provider.calls[2]?.system || '', /# Active Skill: focused-review/)
    assert.deepEqual(provider.calls[2]?.tools?.map((tool) => tool.name), ['Skill', 'capture'])

    assert.equal(final?.type, 'result')
    if (final?.type === 'result') {
      assert.deepEqual(final.model_usage, {
        'base-model': { input_tokens: 1, output_tokens: 1 },
        'skill-model': { input_tokens: 2, output_tokens: 2 },
      })
    }
  } finally {
    clearSkills(context)
    await agent.close()
  }
})

test('inline SkillTool activation enforces allowed tools during execution', async () => {
  const context = { runtimeNamespace: 'skill-activation-enforce-test' }
  clearSkills(context)

  registerSkill({
    name: 'restricted-skill',
    description: 'Restricted skill workflow',
    allowedTools: ['capture'],
    userInvocable: true,
    async getPrompt() {
      return [{ type: 'text', text: 'restricted skill prompt' }]
    },
  }, context)

  const provider = new StubProvider([
    toolUseResponse({ skill: 'restricted-skill' }, 'Skill'),
    toolUseResponse({ value: 'blocked' }, 'other'),
    textResponse('done'),
  ])
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [
      SkillTool,
      captureTool(),
      captureTool(undefined, { name: 'other' }),
    ],
    runtimeNamespace: context.runtimeNamespace,
  })
  ;(agent as any).provider = provider

  try {
    const events = await collectEvents(agent)
    const toolResult = events.find(
      (event) => event.type === 'tool_result' && event.result.tool_name === 'other',
    )

    assert.ok(toolResult)
    assert.match(toolResult.result.output, /Unknown tool "other"/)
    assert.deepEqual(provider.calls[1]?.tools?.map((tool) => tool.name), ['Skill', 'capture'])
  } finally {
    clearSkills(context)
    await agent.close()
  }
})

test('malformed Skill tool output does not activate skill constraints', async () => {
  const malformedSkillTool: ToolDefinition = {
    name: 'Skill',
    description: 'Malformed skill test tool',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    call: async () => ({
      type: 'tool_result',
      tool_use_id: '',
      content: 'not-json',
    }),
  }

  const provider = new StubProvider([
    toolUseResponse({}, 'Skill'),
    toolUseResponse({ value: 'allowed after malformed output' }, 'other'),
    textResponse('done'),
  ])
  const agent = new Agent({
    model: 'base-model',
    tools: [
      malformedSkillTool,
      captureTool(undefined, { name: 'other' }),
    ],
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)

    assert.equal(provider.calls[1]?.model, 'base-model')
    assert.doesNotMatch(provider.calls[1]?.system || '', /# Active Skill:/)
    assert.deepEqual(provider.calls[1]?.tools?.map((tool) => tool.name), ['Skill', 'other'])
  } finally {
    await agent.close()
  }
})

test('custom system prompt bypasses default tool prompt guidance', async () => {
  const provider = new StubProvider([textResponse('ok')])
  const agent = new Agent({
    model: 'gpt-5.4',
    systemPrompt: 'CUSTOM SYSTEM PROMPT',
    appendSystemPrompt: 'APPENDED SYSTEM PROMPT',
    tools: [
      captureTool(undefined, {
        prompt: async () => 'UNIQUE_DEFAULT_TOOL_GUIDANCE',
      }),
    ],
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)

    assert.equal(provider.calls[0]?.system, 'CUSTOM SYSTEM PROMPT\n\nAPPENDED SYSTEM PROMPT')
    assert.doesNotMatch(provider.calls[0]?.system || '', /UNIQUE_DEFAULT_TOOL_GUIDANCE/)
  } finally {
    await agent.close()
  }
})

test('appendSystemPrompt composes with default tool prompt guidance', async () => {
  const provider = new StubProvider([textResponse('ok')])
  const agent = new Agent({
    model: 'gpt-5.4',
    appendSystemPrompt: 'APPENDED DEFAULT SYSTEM PROMPT',
    tools: [
      captureTool(undefined, {
        prompt: async () => 'UNIQUE_DEFAULT_TOOL_GUIDANCE',
      }),
    ],
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)

    const system = provider.calls[0]?.system || ''
    assert.match(system, /UNIQUE_DEFAULT_TOOL_GUIDANCE/)
    assert.match(system, /APPENDED DEFAULT SYSTEM PROMPT/)
  } finally {
    await agent.close()
  }
})

test('toolsets expand to named built-in tool groups', async () => {
  const { TOOLSET_NAMES, getToolsetTools, isToolsetName } = await import('../src/index.ts')

  assert.ok(TOOLSET_NAMES.includes('repo-readonly'))
  assert.equal(isToolsetName('repo-readonly'), true)
  assert.equal(isToolsetName('unknown'), false)
  assert.deepEqual(getToolsetTools(['repo-readonly']), ['Read', 'Glob', 'Grep'])

  const agent = new Agent({
    model: 'gpt-5.4',
    toolsets: ['repo-readonly'],
  })
  ;(agent as any).provider = new StubProvider([textResponse('ok')])

  try {
    const events = await collectEvents(agent)
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init')

    assert.ok(init)
    assert.deepEqual(init.tools, ['Read', 'Glob', 'Grep'])
  } finally {
    await agent.close()
  }
})

test('toolsets combine with allowedTools and respect disallowedTools', async () => {
  const agent = new Agent({
    model: 'gpt-5.4',
    toolsets: ['repo-readonly'],
    allowedTools: ['WebFetch'],
    disallowedTools: ['Grep'],
  })
  ;(agent as any).provider = new StubProvider([textResponse('ok')])

  try {
    const events = await collectEvents(agent)
    const init = events.find((event) => event.type === 'system' && event.subtype === 'init')

    assert.ok(init)
    assert.deepEqual(init.tools, ['Read', 'Glob', 'WebFetch'])
  } finally {
    await agent.close()
  }
})

test('canUseTool denial returns an error tool result and trace denial', async () => {
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [captureTool()],
    canUseTool: async () => ({ behavior: 'deny', message: 'blocked for test' }),
  })
  ;(agent as any).provider = new StubProvider([
    toolUseResponse({ value: 'original' }),
    textResponse('done'),
  ])

  try {
    const events = await collectEvents(agent)
    const result = events.find((event) => event.type === 'tool_result')
    const final = events.find((event) => event.type === 'result')

    assert.ok(result)
    assert.equal(result.result.tool_name, 'capture')
    assert.equal(result.result.output, 'blocked for test')
    assert.equal(final?.type, 'result')
    if (final?.type === 'result') {
      assert.deepEqual(final.permission_denials, [{ tool: 'capture', reason: 'blocked for test' }])
      assert.deepEqual(final.trace?.permission_denials, [{ tool: 'capture', reason: 'blocked for test' }])
    }
  } finally {
    await agent.close()
  }
})

test('canUseTool updatedInput reaches the tool call', async () => {
  let receivedInput: unknown
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [captureTool((input) => { receivedInput = input })],
    canUseTool: async () => ({ behavior: 'allow', updatedInput: { value: 'updated' } }),
  })
  ;(agent as any).provider = new StubProvider([
    toolUseResponse({ value: 'original' }),
    textResponse('done'),
  ])

  try {
    await collectEvents(agent)
    assert.deepEqual(receivedInput, { value: 'updated' })
  } finally {
    await agent.close()
  }
})

test('invalid max tool concurrency falls back to a safe value', async () => {
  const originalConcurrency = process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY
  process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY = '0'

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [captureTool(undefined, { isReadOnly: () => true, isConcurrencySafe: () => true })],
  })
  ;(agent as any).provider = new StubProvider([
    multiToolUseResponse([{ value: 'one' }, { value: 'two' }]),
    textResponse('done'),
  ])

  try {
    const events = await Promise.race([
      collectEvents(agent),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('query timed out')), 500)),
    ])
    assert.equal(events.at(-1)?.type, 'result')
  } finally {
    if (originalConcurrency === undefined) {
      delete process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY
    } else {
      process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY = originalConcurrency
    }
    await agent.close()
  }
})

test('non-numeric max tool concurrency falls back to a safe value', async () => {
  const originalConcurrency = process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY
  process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY = 'not-a-number'

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [captureTool(undefined, { isReadOnly: () => true, isConcurrencySafe: () => true })],
  })
  ;(agent as any).provider = new StubProvider([
    multiToolUseResponse([{ value: 'one' }, { value: 'two' }]),
    textResponse('done'),
  ])

  try {
    const events = await Promise.race([
      collectEvents(agent),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('query timed out')), 500)),
    ])
    assert.equal(events.at(-1)?.type, 'result')
  } finally {
    if (originalConcurrency === undefined) {
      delete process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY
    } else {
      process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY = originalConcurrency
    }
    await agent.close()
  }
})

test('single-turn text completion succeeds when maxTurns is exhausted', async () => {
  const agent = new Agent({ model: 'gpt-5.4', tools: [], maxTurns: 1 })
  ;(agent as any).provider = new StubProvider([textResponse('ok')])

  try {
    const events = await collectEvents(agent)
    const result = events.at(-1)

    assert.equal(result?.type, 'result')
    if (result?.type === 'result') {
      assert.equal(result.subtype, 'success')
      assert.equal(result.is_error, false)
    }
  } finally {
    await agent.close()
  }
})

test('max-token tool calls are executed before continuation recovery', async () => {
  let called = false
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [captureTool(() => { called = true })],
  })
  ;(agent as any).provider = new StubProvider([
    {
      content: [{ type: 'tool_use', id: 'tool-1', name: 'capture', input: { value: 'one' } }],
      stopReason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    textResponse('done'),
  ])

  try {
    const events = await collectEvents(agent)
    const toolResult = events.find((event) => event.type === 'tool_result')

    assert.equal(called, true)
    assert.ok(toolResult)
    assert.equal((agent as any).provider.calls[1]?.messages.at(-1)?.role, 'user')
    assert.deepEqual((agent as any).provider.calls[1]?.messages.at(-1)?.content, [
      { type: 'tool_result', tool_use_id: 'tool-1', content: '{"value":"one"}', is_error: undefined },
    ])
  } finally {
    await agent.close()
  }
})

test('tool execution preserves requested ordering around mutations and traces batches', async () => {
  const order: string[] = []
  const mutationTool = captureTool(async () => {
    order.push('mutation')
  }, { name: 'mutation' })
  const readTool = captureTool(async () => {
    order.push('read')
  }, { name: 'read', isReadOnly: () => true, isConcurrencySafe: () => true })
  const agent = new Agent({ model: 'gpt-5.4', tools: [mutationTool, readTool] })
  ;(agent as any).provider = new StubProvider([
    {
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'mutation', input: { value: 'one' } },
        { type: 'tool_use', id: 'tool-2', name: 'read', input: { value: 'two' } },
      ],
      stopReason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    textResponse('done'),
  ])

  try {
    const events = await collectEvents(agent)
    const final = events.find((event) => event.type === 'result')

    assert.deepEqual(order, ['mutation', 'read'])
    assert.equal(final?.type, 'result')
    if (final?.type === 'result') {
      assert.deepEqual(final.trace?.concurrency_batches, [1, 1])
      assert.deepEqual(final.trace?.tools.map((tool) => tool.tool_name), ['mutation', 'read'])
      assert.deepEqual(final.trace?.tools.map((tool) => tool.concurrency_safe), [false, true])
    }
  } finally {
    await agent.close()
  }
})

test('read-only tools that are not concurrency-safe execute serially', async () => {
  let activeCalls = 0
  let maxActiveCalls = 0
  const tool = captureTool(async () => {
    activeCalls += 1
    maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
    await new Promise((resolve) => setTimeout(resolve, 10))
    activeCalls -= 1
  }, { isReadOnly: () => true, isConcurrencySafe: () => false })

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool] })
  ;(agent as any).provider = new StubProvider([
    multiToolUseResponse([{ value: 'one' }, { value: 'two' }, { value: 'three' }]),
    textResponse('done'),
  ])

  try {
    const events = await collectEvents(agent)
    const final = events.find((event) => event.type === 'result')

    assert.equal(maxActiveCalls, 1)
    assert.equal(final?.type, 'result')
    if (final?.type === 'result') {
      assert.deepEqual(final.trace?.concurrency_batches, [1, 1, 1])
    }
  } finally {
    await agent.close()
  }
})

test('concurrency-safe tools execute concurrently and final result includes trace', async () => {
  let activeCalls = 0
  let maxActiveCalls = 0
  const tool = captureTool(async () => {
    activeCalls += 1
    maxActiveCalls = Math.max(maxActiveCalls, activeCalls)
    await new Promise((resolve) => setTimeout(resolve, 10))
    activeCalls -= 1
  }, { isReadOnly: () => true, isConcurrencySafe: () => true })

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool] })
  ;(agent as any).provider = new StubProvider([
    multiToolUseResponse([{ value: 'one' }, { value: 'two' }, { value: 'three' }]),
    textResponse('done'),
  ])

  try {
    const run = await agent.run('test trace')
    const final = run.events.find((event) => event.type === 'result')

    assert.ok(maxActiveCalls > 1)
    assert.deepEqual(run.trace?.concurrency_batches, [3])
    assert.equal(run.trace?.turns.length, 2)
    assert.deepEqual(run.trace?.turns.map((turn) => turn.tool_calls), [3, 0])
    assert.equal(run.trace?.tools.length, 3)
    assert.equal(run.trace?.tools.every((entry) => entry.tool_name === 'capture'), true)
    assert.equal(run.trace?.tools.every((entry) => entry.concurrency_safe), true)
    assert.equal(final?.type, 'result')
    if (final?.type === 'result') {
      assert.deepEqual(final.trace, run.trace)
    }
  } finally {
    await agent.close()
  }
})

test('tool evidence and quality gates propagate to events and run result', async () => {
  const evidence = [{
    type: 'test',
    summary: 'Focused verification passed',
    source: 'tool',
    id: 'capture-verification',
  }]
  const qualityGates = [{
    name: 'focused-tests',
    status: 'passed' as const,
    summary: 'Focused tests passed',
    evidence,
  }]
  const tool = captureTool(undefined, {
    call: async () => ({
      type: 'tool_result',
      tool_use_id: '',
      content: 'verified',
      evidence,
      quality_gates: qualityGates,
    }),
  })

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool] })
  ;(agent as any).provider = new StubProvider([
    toolUseResponse({ value: 'one' }),
    textResponse('done'),
  ])

  try {
    const run = await agent.run('test evidence')
    const toolEvent = run.events.find((event) => event.type === 'tool_result')
    const final = run.events.find((event) => event.type === 'result')

    assert.deepEqual(run.evidence, evidence)
    assert.deepEqual(run.quality_gates, qualityGates)
    assert.equal(toolEvent?.type, 'tool_result')
    if (toolEvent?.type === 'tool_result') {
      assert.deepEqual(toolEvent.result.evidence, evidence)
      assert.deepEqual(toolEvent.result.quality_gates, qualityGates)
    }
    assert.equal(final?.type, 'result')
    if (final?.type === 'result') {
      assert.deepEqual(final.evidence, evidence)
      assert.deepEqual(final.quality_gates, qualityGates)
    }
  } finally {
    await agent.close()
  }
})

test('initial evidence and quality gates propagate to final run result', async () => {
  const evidence = [{ type: 'artifact', summary: 'Preflight artifact exists', source: 'external' }]
  const qualityGates = [{ name: 'preflight', status: 'passed' as const, evidence }]
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [],
    evidence,
    quality_gates: qualityGates,
  })
  ;(agent as any).provider = new StubProvider([textResponse('done')])

  try {
    const run = await agent.run('test initial evidence')
    const final = run.events.find((event) => event.type === 'result')

    assert.deepEqual(run.evidence, evidence)
    assert.deepEqual(run.quality_gates, qualityGates)
    assert.equal(final?.type, 'result')
    if (final?.type === 'result') {
      assert.deepEqual(final.evidence, evidence)
      assert.deepEqual(final.quality_gates, qualityGates)
    }
  } finally {
    await agent.close()
  }
})

test('concurrency-safe tool traces preserve requested order', async () => {
  const slow = captureTool(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30))
  }, { name: 'slow', isReadOnly: () => true, isConcurrencySafe: () => true })
  const fast = captureTool(async () => {
    await new Promise((resolve) => setTimeout(resolve, 1))
  }, { name: 'fast', isReadOnly: () => true, isConcurrencySafe: () => true })

  const agent = new Agent({ model: 'gpt-5.4', tools: [slow, fast] })
  ;(agent as any).provider = new StubProvider([
    {
      content: [
        { type: 'tool_use', id: 'tool-1', name: 'slow', input: { value: 'one' } },
        { type: 'tool_use', id: 'tool-2', name: 'fast', input: { value: 'two' } },
      ],
      stopReason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    textResponse('done'),
  ])

  try {
    const run = await agent.run('test trace order')

    assert.deepEqual(run.trace?.concurrency_batches, [2])
    assert.deepEqual(run.trace?.tools.map((entry) => entry.tool_name), ['slow', 'fast'])
  } finally {
    await agent.close()
  }
})

test('provider retry exhaustion returns final trace', async () => {
  const rateLimitError = Object.assign(new Error('rate limited'), {
    status: 429,
    headers: { 'retry-after': '0' },
  })
  const agent = new Agent({ model: 'gpt-5.4', tools: [] })
  ;(agent as any).provider = new StubProvider([
    rateLimitError,
    rateLimitError,
    rateLimitError,
    rateLimitError,
  ])

  try {
    const run = await agent.run('test provider failure trace')
    const final = run.events.find((event) => event.type === 'result')

    assert.equal(run.status, 'errored')
    assert.equal(run.trace?.retry_count, 3)
    assert.deepEqual(run.trace?.turns, [])
    assert.equal(final?.type, 'result')
    if (final?.type === 'result') {
      assert.equal(final.is_error, true)
      assert.deepEqual(final.trace, run.trace)
      assert.deepEqual(final.errors, ['rate limited'])
    }
  } finally {
    await agent.close()
  }
})

test('GlobTool returns matches sorted by newest modification time', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')

  const dir = await mkdtemp(join(tmpdir(), 'glob-sort-'))
  await writeFile(join(dir, 'old.txt'), 'old')
  await new Promise((resolve) => setTimeout(resolve, 20))
  await writeFile(join(dir, 'new.txt'), 'new')

  const result = await GlobTool.call({ pattern: '*.txt' }, { cwd: dir })

  assert.equal(result.is_error, false)
  assert.deepEqual(String(result.content).split('\n'), ['new.txt', 'old.txt'])
})

test('EnterWorktree rejects paths outside managed worktree directory', async () => {
  const result = await EnterWorktreeTool.call(
    { branch: 'test-worktree-path', path: '../outside-worktree' },
    { cwd: process.cwd() },
  )

  assert.equal(result.is_error, true)
  assert.match(String(result.content), /must be inside/)
})

test('subagents inherit parent permission policy and mode', async () => {
  const context = { runtimeNamespace: 'subagent-permission-test' }
  clearAgents(context)
  const provider = new StubProvider([
    toolUseResponse({ prompt: 'try grep', description: 'check grep', subagent_type: 'permission-check' }, 'Agent'),
    toolUseResponse({ pattern: 'x', path: '.' }, 'Grep'),
    textResponse('subagent saw denial'),
    textResponse('parent done'),
  ])
  let deniedSubagentTool = false
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [AgentTool],
    runtimeNamespace: context.runtimeNamespace,
    agents: {
      'permission-check': {
        description: 'Checks inherited permissions',
        prompt: 'Use the Grep tool.',
        tools: ['Grep'],
      },
    },
    permissionMode: 'acceptEdits',
    canUseTool: async (tool) => {
      if (tool.name === 'Grep') {
        deniedSubagentTool = true
        return { behavior: 'deny', message: 'subagent blocked' }
      }
      return { behavior: 'allow' }
    },
  })
  ;(agent as any).provider = provider

  try {
    const events = await collectEvents(agent)
    const initEvents = events.filter((event) => event.type === 'system' && event.subtype === 'init')
    const agentResult = events.find((event) => event.type === 'tool_result' && event.result.tool_name === 'Agent')
    const subagentCall = provider.calls.find((call) => call.tools?.some((tool) => tool.name === 'Grep'))
    const subagentFollowupCall = provider.calls.find((call) => Array.isArray(call.messages.at(-1)?.content))

    assert.equal(initEvents.length, 1)
    assert.equal(initEvents[0]?.permission_mode, 'acceptEdits')
    assert.ok(subagentCall)
    assert.equal(subagentCall.tools?.some((tool) => tool.name === 'Grep'), true)
    assert.equal(deniedSubagentTool, true)
    assert.deepEqual(subagentFollowupCall?.messages.at(-1)?.content, [
      { type: 'tool_result', tool_use_id: 'tool-1', content: 'subagent blocked', is_error: true },
    ])
    assert.match(agentResult?.result.output ?? '', /subagent saw denial/)
  } finally {
    clearAgents(context)
    await agent.close()
  }
})

test('AgentTool run_in_background creates durable job and records completion', async () => {
  const context = { runtimeNamespace: 'background-agent-complete-test' }
  await clearAgentJobs(context)
  clearAgents(context)

  const provider = new StubProvider([
    textResponse('background result'),
  ])

  try {
    const result = await AgentTool.call(
      {
        prompt: 'run background task',
        description: 'background task',
        run_in_background: true,
      },
      {
        cwd: process.cwd(),
        provider,
        model: 'gpt-5.4',
        apiType: 'openai-completions',
        runtimeNamespace: context.runtimeNamespace,
      },
    )
    const payload = JSON.parse(String(result.content))

    assert.equal(payload.type, 'clavue.agent.job')
    assert.equal(payload.status, 'queued')
    assert.match(payload.job_id, /^agent_job_/)

    await eventually(async () => {
      const job = await getAgentJob(payload.job_id, context)
      assert.equal(job?.status, 'completed')
      assert.equal(job?.output, 'background result')
      assert.equal(job?.trace?.turns.length, 1)
    })

    const jobs = await listAgentJobs(context)
    assert.equal(jobs.length, 1)
    assert.equal(jobs[0]?.id, payload.job_id)
  } finally {
    await clearAgentJobs(context)
    clearAgents(context)
  }
})

test('Agent job tools list, get, and stop background jobs by namespace', async () => {
  const contextA = { runtimeNamespace: 'background-agent-tools-a' }
  const contextB = { runtimeNamespace: 'background-agent-tools-b' }
  await clearAgentJobs(contextA)
  await clearAgentJobs(contextB)

  let releaseBackground!: () => void
  const provider = new StubProvider([
    new Promise((resolve) => {
      releaseBackground = () => resolve(textResponse('late background result'))
    }) as any,
  ])

  try {
    const result = await AgentTool.call(
      {
        prompt: 'slow background task',
        description: 'slow background task',
        run_in_background: true,
      },
      {
        cwd: process.cwd(),
        provider,
        model: 'gpt-5.4',
        apiType: 'openai-completions',
        runtimeNamespace: contextA.runtimeNamespace,
      },
    )
    const { job_id: jobId } = JSON.parse(String(result.content))

    await eventually(async () => {
      const job = await getAgentJob(jobId, contextA)
      assert.equal(job?.status, 'running')
    })

    const listA = await AgentJobListTool.call({}, { cwd: process.cwd(), ...contextA })
    const listB = await AgentJobListTool.call({}, { cwd: process.cwd(), ...contextB })
    assert.match(String(listA.content), new RegExp(jobId))
    assert.equal(String(listB.content), '[]')

    const getA = await AgentJobGetTool.call({ id: jobId }, { cwd: process.cwd(), ...contextA })
    assert.match(String(getA.content), /slow background task/)

    const stop = await AgentJobStopTool.call(
      { id: jobId, reason: 'test cancellation' },
      { cwd: process.cwd(), ...contextA },
    )
    assert.equal(stop.is_error, undefined)
    assert.match(String(stop.content), /cancelled/)

    releaseBackground()
    await eventually(async () => {
      const job = await getAgentJob(jobId, contextA)
      assert.equal(job?.status, 'cancelled')
      assert.match(job?.error || '', /test cancellation/)
    })
  } finally {
    releaseBackground?.()
    await clearAgentJobs(contextA)
    await clearAgentJobs(contextB)
  }
})

test('stale queued agent jobs are marked stale on read', async () => {
  const context = { runtimeNamespace: 'background-agent-stale-test', staleAfterMs: 0 }
  await clearAgentJobs(context)

  try {
    const job = await createAgentJob({
      kind: 'subagent',
      prompt: 'never started',
      description: 'never started',
    }, context)

    const refreshed = await getAgentJob(job.id, context)

    assert.equal(refreshed?.status, 'stale')
    assert.match(refreshed?.error || '', /heartbeat expired/)
  } finally {
    await clearAgentJobs(context)
  }
})

test('forked skills create background agent jobs with allowed built-in tools', async () => {
  const context = { runtimeNamespace: 'forked-skill-background-test' }
  await clearAgentJobs(context)
  clearSkills(context)
  clearAgents(context)

  const provider = new StubProvider([
    textResponse('forked skill result'),
  ])

  registerSkill({
    name: 'deep-review',
    description: 'Deep review workflow',
    context: 'fork',
    agent: 'reviewer',
    allowedTools: ['Glob'],
    model: 'skill-model',
    userInvocable: true,
    async getPrompt(args) {
      return [{ type: 'text', text: `FORKED_SKILL_PROMPT ${args}` }]
    },
  }, context)

  registerAgents({
    reviewer: {
      description: 'Review agent',
      prompt: 'Use the provided forked skill prompt.',
      tools: ['Glob', 'Grep'],
    },
  }, context)

  try {
    const result = await SkillTool.call(
      { skill: 'deep-review', args: 'src/engine.ts' },
      {
        cwd: process.cwd(),
        provider,
        model: 'base-model',
        apiType: 'openai-completions',
        runtimeNamespace: context.runtimeNamespace,
      },
    )
    const payload = JSON.parse(String(result.content))

    assert.equal(payload.status, 'forked')
    assert.match(payload.job_id, /^agent_job_/)

    await eventually(async () => {
      const job = await getAgentJob(payload.job_id, context)
      assert.equal(job?.status, 'completed')
      assert.equal(job?.model, 'skill-model')
      assert.deepEqual(job?.allowedTools, ['Glob'])
      assert.match(job?.prompt || '', /FORKED_SKILL_PROMPT src\/engine\.ts/)
      assert.match(job?.output || '', /forked skill result/)
      assert.equal(job?.trace?.turns.length, 1)
    })

    assert.equal(provider.calls[0]?.model, 'skill-model')
    assert.deepEqual(provider.calls[0]?.tools?.map((tool) => tool.name), ['Glob'])
    assert.match(provider.calls[0]?.system || '', /FORKED_SKILL_PROMPT src\/engine\.ts/)
  } finally {
    await clearAgentJobs(context)
    clearSkills(context)
    clearAgents(context)
  }
})

test('custom subagent definitions are isolated by runtime namespace', async () => {
  const first = new Agent({
    model: 'gpt-5.4',
    runtimeNamespace: 'agent-registry-a',
    tools: [AgentTool],
    agents: {
      onlyA: {
        description: 'Only registered for A',
        prompt: 'A prompt',
        tools: ['Glob'],
      },
    },
  })
  const second = new Agent({
    model: 'gpt-5.4',
    runtimeNamespace: 'agent-registry-b',
    tools: [AgentTool],
    agents: {
      onlyB: {
        description: 'Only registered for B',
        prompt: 'B prompt',
        tools: ['Grep'],
      },
    },
  })

  try {
    await Promise.all([(first as any).setupDone, (second as any).setupDone])

    assert.deepEqual(Object.keys(getRegisteredAgentDefinitions({ runtimeNamespace: 'agent-registry-a' })), ['onlyA'])
    assert.deepEqual(Object.keys(getRegisteredAgentDefinitions({ runtimeNamespace: 'agent-registry-b' })), ['onlyB'])
    assert.deepEqual(Object.keys(getRegisteredAgentDefinitions()), [])
  } finally {
    clearAgents({ runtimeNamespace: 'agent-registry-a' })
    clearAgents({ runtimeNamespace: 'agent-registry-b' })
    await first.close()
    await second.close()
  }
})
