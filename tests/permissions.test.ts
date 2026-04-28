import test from 'node:test'
import assert from 'node:assert/strict'
import {
  Agent,
  AgentTool,
  GlobTool,
  EnterWorktreeTool,
  SkillTool,
  clearAgents,
  clearSkills,
  getRegisteredAgentDefinitions,
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
