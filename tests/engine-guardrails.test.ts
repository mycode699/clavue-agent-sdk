/**
 * Engine ↔ Guardrails (v3.4 tool-scope) integration test.
 *
 * Locks RFC D1+D2 acceptance: tool_input + tool_output evaluations fire from
 * the engine's tool dispatcher, default policy = `'skip'` (denied ToolResult
 * with structured reason, run continues), and trace auto-append works when
 * both `guardrails` and `trace` are provided.
 *
 * @module
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { Agent, GuardrailRegistry, TraceStore } from '../src/index.ts'
import type {
  CreateMessageParams,
  CreateMessageResponse,
  LLMProvider,
  SDKMessage,
  ToolDefinition,
} from '../src/index.ts'

class StubProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  calls: CreateMessageParams[] = []

  constructor(private readonly responses: CreateMessageResponse[]) {}

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.calls.push(params)
    return this.responses.shift() ?? {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

function toolUseResponse(input: unknown, name = 'capture'): CreateMessageResponse {
  return {
    content: [{ type: 'tool_use', id: 'tool-1', name, input }],
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function textResponse(text: string): CreateMessageResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function captureTool(returns: string = '{"ok":true}'): ToolDefinition {
  return {
    name: 'capture',
    description: 'Echo input',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    call: async (input) => ({
      type: 'tool_result',
      tool_use_id: '',
      content: typeof returns === 'string' ? returns : JSON.stringify(input),
    }),
  }
}

async function collectEvents(agent: Agent, prompt = 'go'): Promise<SDKMessage[]> {
  const events: SDKMessage[] = []
  for await (const event of agent.query(prompt)) events.push(event)
  return events
}

test('tool_input guardrail blocks the call before tool.call() runs', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'no_secrets_in_input',
    scope: 'tool_input',
    check: (payload) =>
      /sk-[a-z0-9]{6,}/i.test(JSON.stringify(payload))
        ? { pass: false, message: 'API key in input' }
        : { pass: true },
  })

  let toolFired = false
  const tool: ToolDefinition = {
    ...captureTool(),
    call: async (input) => {
      toolFired = true
      return { type: 'tool_result', tool_use_id: '', content: JSON.stringify(input) }
    },
  }

  const provider = new StubProvider([
    toolUseResponse({ value: 'sk-abc12345' }),
    textResponse('done'),
  ])

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool], guardrails: rails })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)
    assert.equal(toolFired, false, 'tool must not run when tool_input is denied')

    // The denied tool_result is echoed to the model in the next provider call
    const followup = provider.calls[1]
    assert.ok(followup, 'expected a follow-up provider call')
    const last = followup.messages.at(-1)
    assert.equal(last?.role, 'user')
    const content = last?.content as Array<{ type: string; is_error?: boolean; content: string }>
    assert.ok(Array.isArray(content))
    const denied = content.find((c) => c.type === 'tool_result' && c.is_error === true)
    assert.ok(denied, 'denied tool_result should be echoed back to the model')
    assert.match(String(denied.content), /Guardrail denied tool input/)
    assert.match(String(denied.content), /API key in input/)
  } finally {
    await agent.close()
  }
})

test('tool_input guardrail passes → tool runs normally', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'always_pass_input',
    scope: 'tool_input',
    check: () => ({ pass: true }),
  })

  let toolFired = false
  const tool: ToolDefinition = {
    ...captureTool('{"ok":1}'),
    call: async (input) => {
      toolFired = true
      return { type: 'tool_result', tool_use_id: '', content: JSON.stringify(input) }
    },
  }

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool], guardrails: rails })
  ;(agent as any).provider = new StubProvider([
    toolUseResponse({ value: 'safe-input' }),
    textResponse('done'),
  ])

  try {
    await collectEvents(agent)
    assert.equal(toolFired, true)
  } finally {
    await agent.close()
  }
})

test('tool_output guardrail blocks the result after tool.call() returns', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'no_pii_in_output',
    scope: 'tool_output',
    check: (payload) =>
      /SSN-\d+/.test(String(payload))
        ? { pass: false, message: 'PII detected in tool output' }
        : { pass: true },
  })

  const tool: ToolDefinition = {
    ...captureTool(),
    call: async () => ({
      type: 'tool_result',
      tool_use_id: '',
      content: 'leaked SSN-12345',
    }),
  }

  const provider = new StubProvider([
    toolUseResponse({ value: 'x' }),
    textResponse('done'),
  ])

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool], guardrails: rails })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)
    const followup = provider.calls[1]
    assert.ok(followup, 'expected a follow-up provider call')
    const content = followup.messages.at(-1)?.content as Array<{ type: string; is_error?: boolean; content: string }>
    const denied = content.find((c) => c.type === 'tool_result' && c.is_error === true)
    assert.ok(denied, 'denied tool_output should be echoed back to the model')
    assert.match(String(denied.content), /Guardrail denied tool output/)
    assert.match(String(denied.content), /PII detected/)
  } finally {
    await agent.close()
  }
})

test('trace + guardrails: every tool call appends one tool_input + one tool_output guardrail event', async () => {
  const rails = new GuardrailRegistry()
    .add({
      name: 'pass_in',
      scope: 'tool_input',
      check: () => ({ pass: true }),
    })
    .add({
      name: 'pass_out',
      scope: 'tool_output',
      check: () => ({ pass: true }),
    })

  const store = new TraceStore()
  const runId = store.startRun({ scenario: 'engine-guardrail-trace' })

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [captureTool('{"ok":1}')],
    guardrails: rails,
    trace: store,
  })
  ;(agent as any).provider = new StubProvider([
    toolUseResponse({ value: 'one' }),
    textResponse('done'),
  ])

  try {
    await collectEvents(agent)
    store.endRun(runId)

    const events = store.query(runId)
    const guardrailEvents = events.filter((e) => e.kind === 'guardrail')
    assert.equal(guardrailEvents.length, 2, 'expected one tool_input + one tool_output event')

    const scopes = guardrailEvents.map((e) => (e.data as { scope: string }).scope).sort()
    assert.deepEqual(scopes, ['tool_input', 'tool_output'])
    for (const ev of guardrailEvents) {
      assert.equal((ev.data as { toolName: string }).toolName, 'capture')
      assert.equal((ev.data as { evaluation: { passed: boolean } }).evaluation.passed, true)
    }
  } finally {
    await agent.close()
  }
})

test('async tool_input check is awaited; throwing check counts as blocking violation', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'async_throws',
    scope: 'tool_input',
    check: async () => {
      await new Promise((r) => setTimeout(r, 1))
      throw new Error('upstream check service offline')
    },
  })

  let toolFired = false
  const tool: ToolDefinition = {
    ...captureTool(),
    call: async () => {
      toolFired = true
      return { type: 'tool_result', tool_use_id: '', content: 'never' }
    },
  }

  const provider = new StubProvider([
    toolUseResponse({ value: 'x' }),
    textResponse('done'),
  ])

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool], guardrails: rails })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)
    assert.equal(toolFired, false, 'tool must not run when guardrail check throws')

    const followup = provider.calls[1]
    assert.ok(followup)
    const content = followup.messages.at(-1)?.content as Array<{ type: string; is_error?: boolean; content: string }>
    const denied = content.find((c) => c.type === 'tool_result' && c.is_error === true)
    assert.ok(denied)
    assert.match(String(denied.content), /Guardrail denied tool input/)
    assert.match(String(denied.content), /upstream check service offline/)
  } finally {
    await agent.close()
  }
})

test('no guardrails configured → engine fast path; tool runs unchanged', async () => {
  let toolFired = false
  const tool: ToolDefinition = {
    ...captureTool(),
    call: async (input) => {
      toolFired = true
      return { type: 'tool_result', tool_use_id: '', content: JSON.stringify(input) }
    },
  }

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool] })
  ;(agent as any).provider = new StubProvider([
    toolUseResponse({ value: 'x' }),
    textResponse('done'),
  ])

  try {
    await collectEvents(agent)
    assert.equal(toolFired, true)
  } finally {
    await agent.close()
  }
})
