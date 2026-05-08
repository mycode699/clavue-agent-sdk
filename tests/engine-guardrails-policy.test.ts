/**
 * Engine ↔ Guardrails — `onToolViolation` policy callback (RFC D2 follow-up).
 *
 * Locks acceptance for tool-scope guardrail actions:
 *   - `'skip'` (default): denied ToolResult, run continues (covered in
 *     `engine-guardrails.test.ts`)
 *   - `'abort'`: terminal `error_guardrail_abort` result, no follow-up turn
 *   - `'continue'`: tool runs / result passes through unchanged (audit-only)
 *   - callback throws → `'abort'` (matches graph `onViolation` behavior)
 *   - callback receives `{ toolName, phase }` so policy can branch on
 *     request vs response
 *
 * @module
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { Agent, GuardrailRegistry } from '../src/index.ts'
import type {
  CreateMessageParams,
  CreateMessageResponse,
  LLMProvider,
  OnToolViolationFn,
  SDKMessage,
  ToolDefinition,
  ToolGuardrailAction,
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

function captureTool(returns = '{"ok":true}'): ToolDefinition {
  return {
    name: 'capture',
    description: 'Echo input',
    inputSchema: {
      type: 'object',
      properties: { value: { type: 'string' } },
      required: ['value'],
    },
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: returns }),
  }
}

async function collectEvents(agent: Agent, prompt = 'go'): Promise<SDKMessage[]> {
  const events: SDKMessage[] = []
  for await (const event of agent.query(prompt)) events.push(event)
  return events
}

test('onToolViolation = "abort" on tool_input → terminal error_guardrail_abort, no second turn', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'always_block_input',
    scope: 'tool_input',
    check: () => ({ pass: false, message: 'denied' }),
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
    textResponse('should-not-run'),
  ])

  const onToolViolation: OnToolViolationFn = (_eval, ctx) => {
    assert.equal(ctx.toolName, 'capture')
    assert.equal(ctx.phase, 'request')
    return 'abort'
  }

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [tool],
    guardrails: rails,
    onToolViolation,
  })
  ;(agent as any).provider = provider

  try {
    const events = await collectEvents(agent)
    assert.equal(toolFired, false, 'tool must not run when policy = abort')
    // Only one provider call — no follow-up turn.
    assert.equal(provider.calls.length, 1)

    const result = events.find((e) => e.type === 'result') as any
    assert.ok(result, 'expected a terminal result event')
    assert.equal(result.subtype, 'error_guardrail_abort')
    assert.equal(result.is_error, true)
    assert.ok(Array.isArray(result.errors))
    assert.match(result.errors[0], /Guardrail aborted tool input/)
    assert.match(result.errors[0], /denied/)
  } finally {
    await agent.close()
  }
})

test('onToolViolation = "abort" on tool_output → terminal error_guardrail_abort after tool ran', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'block_output',
    scope: 'tool_output',
    check: () => ({ pass: false, message: 'leak' }),
  })

  let toolFired = false
  const tool: ToolDefinition = {
    ...captureTool(),
    call: async () => {
      toolFired = true
      return { type: 'tool_result', tool_use_id: '', content: 'sensitive' }
    },
  }

  const provider = new StubProvider([
    toolUseResponse({ value: 'x' }),
    textResponse('should-not-run'),
  ])

  let observedPhase: string | undefined
  const onToolViolation: OnToolViolationFn = (_eval, ctx) => {
    observedPhase = ctx.phase
    return 'abort'
  }

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [tool],
    guardrails: rails,
    onToolViolation,
  })
  ;(agent as any).provider = provider

  try {
    const events = await collectEvents(agent)
    assert.equal(toolFired, true, 'tool runs first; output evaluation aborts after')
    assert.equal(observedPhase, 'response')
    assert.equal(provider.calls.length, 1)

    const result = events.find((e) => e.type === 'result') as any
    assert.equal(result.subtype, 'error_guardrail_abort')
    assert.match(result.errors[0], /Guardrail aborted tool output/)
  } finally {
    await agent.close()
  }
})

test('onToolViolation = "continue" on tool_input → tool runs anyway (audit-only)', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'flag_input',
    scope: 'tool_input',
    check: () => ({ pass: false, message: 'flagged' }),
  })

  let toolFired = false
  const tool: ToolDefinition = {
    ...captureTool('{"audited":1}'),
    call: async () => {
      toolFired = true
      return { type: 'tool_result', tool_use_id: '', content: '{"audited":1}' }
    },
  }

  const provider = new StubProvider([
    toolUseResponse({ value: 'x' }),
    textResponse('done'),
  ])

  const onToolViolation: OnToolViolationFn = () => 'continue'

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [tool],
    guardrails: rails,
    onToolViolation,
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)
    assert.equal(toolFired, true, 'continue → tool must run despite violation')

    // Follow-up call sees the real tool result, not a denied one.
    const followup = provider.calls[1]
    assert.ok(followup)
    const content = followup.messages.at(-1)?.content as Array<{ type: string; is_error?: boolean; content: string }>
    const tr = content.find((c) => c.type === 'tool_result')
    assert.ok(tr)
    assert.notEqual(tr.is_error, true, 'continue → result must not be marked is_error')
    assert.match(String(tr.content), /audited/)
  } finally {
    await agent.close()
  }
})

test('onToolViolation = "continue" on tool_output → original tool output passes through unchanged', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'audit_output',
    scope: 'tool_output',
    check: () => ({ pass: false, message: 'noted but allowed' }),
  })

  const tool: ToolDefinition = {
    ...captureTool(),
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: 'real-output-payload' }),
  }

  const provider = new StubProvider([
    toolUseResponse({ value: 'x' }),
    textResponse('done'),
  ])

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [tool],
    guardrails: rails,
    onToolViolation: () => 'continue',
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)

    const followup = provider.calls[1]
    assert.ok(followup)
    const content = followup.messages.at(-1)?.content as Array<{ type: string; is_error?: boolean; content: string }>
    const tr = content.find((c) => c.type === 'tool_result')
    assert.ok(tr)
    assert.notEqual(tr.is_error, true)
    assert.match(String(tr.content), /real-output-payload/)
    assert.doesNotMatch(String(tr.content), /Guardrail denied/)
  } finally {
    await agent.close()
  }
})

test('onToolViolation throws → treated as "abort" (defensive default mirrors graph onViolation)', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'block_input',
    scope: 'tool_input',
    check: () => ({ pass: false, message: 'x' }),
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

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [tool],
    guardrails: rails,
    onToolViolation: () => {
      throw new Error('policy callback exploded')
    },
  })
  ;(agent as any).provider = provider

  try {
    const events = await collectEvents(agent)
    assert.equal(toolFired, false)
    const result = events.find((e) => e.type === 'result') as any
    assert.equal(result.subtype, 'error_guardrail_abort')
  } finally {
    await agent.close()
  }
})

test('onToolViolation absent → default policy is "skip" (RFC D2 default)', async () => {
  const rails = new GuardrailRegistry().add({
    name: 'block_input',
    scope: 'tool_input',
    check: () => ({ pass: false, message: 'denied default' }),
  })

  const tool: ToolDefinition = captureTool()

  const provider = new StubProvider([
    toolUseResponse({ value: 'x' }),
    textResponse('done'),
  ])

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [tool],
    guardrails: rails,
    // no onToolViolation
  })
  ;(agent as any).provider = provider

  try {
    const events = await collectEvents(agent)
    // Default skip → run completes successfully, model gets a denied result.
    const result = events.find((e) => e.type === 'result') as any
    assert.equal(result.subtype, 'success')

    const followup = provider.calls[1]
    assert.ok(followup, 'skip default must produce a follow-up provider call')
    const content = followup.messages.at(-1)?.content as Array<{ type: string; is_error?: boolean; content: string }>
    const denied = content.find((c) => c.type === 'tool_result' && c.is_error === true)
    assert.ok(denied)
    assert.match(String(denied.content), /Guardrail denied tool input/)
  } finally {
    await agent.close()
  }
})

test('onToolViolation can branch on phase: skip on request, abort on response', async () => {
  // First evaluation (request) is denied → callback returns 'skip'.
  // No second tool call happens, so 'response' branch never fires here —
  // we only assert the callback receives the correct phase value the *one*
  // time it is invoked.
  const rails = new GuardrailRegistry()
    .add({
      name: 'block_in',
      scope: 'tool_input',
      check: () => ({ pass: false, message: 'in' }),
    })

  const phases: string[] = []
  const policy: OnToolViolationFn = (_eval, ctx): ToolGuardrailAction => {
    phases.push(ctx.phase)
    return ctx.phase === 'request' ? 'skip' : 'abort'
  }

  const provider = new StubProvider([
    toolUseResponse({ value: 'x' }),
    textResponse('done'),
  ])

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [captureTool()],
    guardrails: rails,
    onToolViolation: policy,
  })
  ;(agent as any).provider = provider

  try {
    await collectEvents(agent)
    assert.deepEqual(phases, ['request'])
  } finally {
    await agent.close()
  }
})
