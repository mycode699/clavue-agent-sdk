import test from 'node:test'
import assert from 'node:assert/strict'
import { Agent } from '../src/index.ts'
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

function toolUseResponse(input: unknown): CreateMessageResponse {
  return {
    content: [{ type: 'tool_use', id: 'tool-1', name: 'capture', input }],
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function captureTool(onInput?: (input: unknown) => void): ToolDefinition {
  return {
    name: 'capture',
    description: 'Capture input for permission tests',
    inputSchema: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
    },
    call: async (input) => {
      onInput?.(input)
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify(input),
      }
    },
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
