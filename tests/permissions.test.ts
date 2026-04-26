import test from 'node:test'
import assert from 'node:assert/strict'
import { Agent, AgentTool, clearAgents } from '../src/index.ts'
import type { CreateMessageParams, CreateMessageResponse, LLMProvider, SDKMessage, ToolDefinition } from '../src/index.ts'

class StubProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  calls: CreateMessageParams[] = []

  constructor(private readonly responses: CreateMessageResponse[]) {}

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.calls.push(params)
    return this.responses.shift() ?? textResponse('done')
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

test('canUseTool denial returns an error tool result', async () => {
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

    assert.ok(result)
    assert.equal(result.result.tool_name, 'capture')
    assert.equal(result.result.output, 'blocked for test')
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
    await collectEvents(agent)
    assert.equal(maxActiveCalls, 1)
  } finally {
    await agent.close()
  }
})

test('subagents inherit parent permission policy and mode', async () => {
  clearAgents()
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
    clearAgents()
    await agent.close()
  }
})
