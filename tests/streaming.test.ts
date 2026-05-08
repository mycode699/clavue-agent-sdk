/**
 * Engine streaming integration tests (P0-4 phase 2).
 *
 * Verify that when `includePartialMessages: true` is configured, the engine:
 *   1. Forwards a `stream.onText` callback to the provider.
 *   2. Yields `partial_message` SDK events for each delta.
 *   3. Preserves the final aggregated assistant message.
 *   4. Stays silent (no partials, no callback) when the flag is off.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { Agent } from '../src/index.ts'
import type {
  CreateMessageParams,
  CreateMessageResponse,
  LLMProvider,
  StreamCallbacks,
} from '../src/index.ts'

class StreamingStubProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  capturedStream: StreamCallbacks | undefined
  capturedCalls = 0

  constructor(
    private readonly deltas: string[],
    private readonly finalText: string,
  ) {}

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.capturedCalls += 1
    this.capturedStream = params.stream
    if (params.stream?.onText) {
      for (const delta of this.deltas) {
        params.stream.onText(delta)
      }
    }
    return {
      content: [{ type: 'text', text: this.finalText }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: this.deltas.length },
    }
  }
}

test('engine emits partial_message events when includePartialMessages is true', async () => {
  const provider = new StreamingStubProvider(['Hel', 'lo, ', 'world!'], 'Hello, world!')
  const agent = new Agent({
    model: 'gpt-primary',
    tools: [],
    persistSession: false,
    includePartialMessages: true,
  })
  ;(agent as any).provider = provider

  const events: any[] = []
  for await (const event of agent.query('hi')) {
    events.push(event)
  }

  assert.equal(provider.capturedCalls, 1)
  assert.ok(provider.capturedStream?.onText, 'stream.onText must be forwarded to the provider')

  const partials = events.filter((e) => e.type === 'partial_message')
  assert.equal(partials.length, 3)
  assert.deepEqual(partials.map((p) => p.partial.text), ['Hel', 'lo, ', 'world!'])

  const assistant = events.find((e) => e.type === 'assistant')
  assert.ok(assistant, 'final assistant message must still be emitted')
  assert.equal(assistant.message.content[0].text, 'Hello, world!')

  // Partials must arrive before the aggregated assistant message.
  const lastPartialIdx = events.lastIndexOf(partials[partials.length - 1])
  const assistantIdx = events.indexOf(assistant)
  assert.ok(lastPartialIdx < assistantIdx, 'partials must precede the final assistant event')
})

test('engine omits stream callbacks and partial events when includePartialMessages is false', async () => {
  const provider = new StreamingStubProvider(['ignored'], 'final only')
  const agent = new Agent({
    model: 'gpt-primary',
    tools: [],
    persistSession: false,
    // includePartialMessages defaults to false
  })
  ;(agent as any).provider = provider

  const events: any[] = []
  for await (const event of agent.query('hi')) {
    events.push(event)
  }

  assert.equal(provider.capturedStream, undefined, 'stream callbacks must not be passed when flag is off')
  assert.equal(events.filter((e) => e.type === 'partial_message').length, 0)
  const assistant = events.find((e) => e.type === 'assistant')
  assert.equal(assistant?.message.content[0].text, 'final only')
})

test('engine drops empty deltas without emitting empty partial_message events', async () => {
  const provider = new StreamingStubProvider(['', 'ok', ''], 'ok')
  const agent = new Agent({
    model: 'gpt-primary',
    tools: [],
    persistSession: false,
    includePartialMessages: true,
  })
  ;(agent as any).provider = provider

  const events: any[] = []
  for await (const event of agent.query('hi')) {
    events.push(event)
  }

  const partials = events.filter((e) => e.type === 'partial_message')
  assert.equal(partials.length, 1)
  assert.equal(partials[0].partial.text, 'ok')
})
