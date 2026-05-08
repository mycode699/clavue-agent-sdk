import test from 'node:test'
import assert from 'node:assert/strict'

import { AnthropicProvider } from '../src/index.ts'
import type { CreateMessageParams, ProviderError } from '../src/index.ts'

const baseParams: CreateMessageParams = {
  model: 'claude-sonnet-4-6',
  maxTokens: 64,
  system: 'You are helpful.',
  messages: [{ role: 'user', content: 'hello' }],
}

test('AnthropicProvider normalizes transport failures with provider metadata', async () => {
  const cases = [
    { error: Object.assign(new Error('fetch failed'), { code: 'ENOTFOUND' }), category: 'network' },
    { error: Object.assign(new Error('headers timeout'), { code: 'UND_ERR_HEADERS_TIMEOUT' }), category: 'timeout' },
    { error: Object.assign(new Error('aborted'), { name: 'AbortError' }), category: 'aborted' },
  ]

  for (const { error, category } of cases) {
    const provider = new AnthropicProvider({ apiKey: 'test-key' })
    ;(provider as any).client.messages.create = async () => {
      throw error
    }

    await assert.rejects(
      provider.createMessage(baseParams),
      (err: unknown) => {
        const providerError = err as ProviderError
        assert.equal(providerError.provider, 'anthropic')
        assert.equal(providerError.category, category)
        assert.equal(providerError.message, error.message)
        return true
      },
    )
  }
})

test('AnthropicProvider normalizes API errors with provider metadata', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test-key' })
  const apiError = Object.assign(new Error('too many requests'), {
    status: 429,
    headers: { 'retry-after': '2' },
    body: '{"error":{"type":"rate_limit_error"}}',
    error: { type: 'rate_limit_error' },
  })
  ;(provider as any).client.messages.create = async () => {
    throw apiError
  }

  await assert.rejects(
    provider.createMessage(baseParams),
    (err: unknown) => {
      const providerError = err as ProviderError
      assert.equal(providerError.provider, 'anthropic')
      assert.equal(providerError.category, 'rate_limit')
      assert.equal(providerError.status, 429)
      assert.deepEqual(providerError.headers, { 'retry-after': '2' })
      assert.equal(providerError.body, '{"error":{"type":"rate_limit_error"}}')
      assert.deepEqual(providerError.error, { type: 'rate_limit_error' })
      assert.equal(providerError.message, 'too many requests')
      return true
    },
  )
})

const fakeAnthropicResponse = {
  content: [{ type: 'text', text: 'ok' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 0, output_tokens: 0 },
}

function captureAnthropicRequest() {
  const provider = new AnthropicProvider({ apiKey: 'test-key' })
  let captured: any
  ;(provider as any).client.messages.create = async (req: any) => {
    captured = req
    return fakeAnthropicResponse
  }
  return { provider, getCaptured: () => captured }
}

test('AnthropicProvider with outputSchema synthesizes _output tool and forces tool_choice', async () => {
  const { provider, getCaptured } = captureAnthropicRequest()
  const schema = {
    type: 'object',
    properties: { ok: { type: 'boolean' } },
    required: ['ok'],
  }

  await provider.createMessage({
    ...baseParams,
    outputSchema: { schema, name: 'verdict', description: 'verdict payload' },
  })

  const req = getCaptured()
  assert.ok(Array.isArray(req.tools), 'tools should be an array')
  const synthesized = req.tools[req.tools.length - 1]
  assert.equal(synthesized.name, 'verdict')
  assert.equal(synthesized.description, 'verdict payload')
  assert.deepEqual(synthesized.input_schema, schema)
  // Caching should still tag the trailing tool (the synthesized output tool).
  assert.deepEqual(synthesized.cache_control, { type: 'ephemeral' })
  assert.deepEqual(req.tool_choice, { type: 'tool', name: 'verdict' })
})

test('AnthropicProvider outputSchema defaults the synthesized tool name to _output', async () => {
  const { provider, getCaptured } = captureAnthropicRequest()
  await provider.createMessage({
    ...baseParams,
    outputSchema: { schema: { type: 'object', properties: {} } },
  })

  const req = getCaptured()
  const synthesized = req.tools[req.tools.length - 1]
  assert.equal(synthesized.name, '_output')
  assert.deepEqual(req.tool_choice, { type: 'tool', name: '_output' })
})

test('AnthropicProvider without outputSchema does not add tool_choice or synthesized tool', async () => {
  const { provider, getCaptured } = captureAnthropicRequest()
  await provider.createMessage({
    ...baseParams,
    tools: [
      { name: 'real', description: 'real tool', input_schema: { type: 'object', properties: {} } },
    ],
  })

  const req = getCaptured()
  assert.equal(req.tool_choice, undefined)
  assert.equal(req.tools.length, 1)
  assert.equal(req.tools[0].name, 'real')
})

// --------------------------------------------------------------------------
// Streaming path
// --------------------------------------------------------------------------

test('AnthropicProvider streams text deltas via stream.onText when configured', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test-key' })
  const finalMessage = {
    content: [{ type: 'text', text: 'hello world' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 5, output_tokens: 6 },
  }
  let capturedRequest: any
  ;(provider as any).client.messages.stream = (req: any) => {
    capturedRequest = req
    const handlers: Record<string, Array<(...args: any[]) => void>> = {}
    return {
      on(event: string, fn: (...args: any[]) => void) {
        ;(handlers[event] ||= []).push(fn)
        return this
      },
      async finalMessage() {
        // Drive deltas synchronously after subscription, then resolve.
        for (const delta of ['hel', 'lo ', 'world']) {
          for (const fn of handlers['text'] ?? []) fn(delta)
        }
        return finalMessage
      },
    }
  }

  const deltas: string[] = []
  const result = await provider.createMessage({
    ...baseParams,
    stream: { onText: (d) => deltas.push(d) },
  })

  assert.deepEqual(deltas, ['hel', 'lo ', 'world'])
  assert.equal(capturedRequest.stream, true, 'streaming param must be set on request')
  assert.equal(result.content[0]?.type, 'text')
  if (result.content[0]?.type === 'text') {
    assert.equal(result.content[0].text, 'hello world')
  }
  assert.equal(result.stopReason, 'end_turn')
})

test('AnthropicProvider falls back to non-streaming create() when stream is undefined', async () => {
  const { provider, getCaptured } = captureAnthropicRequest()
  // Make stream() throw if the provider mistakenly takes the streaming path.
  ;(provider as any).client.messages.stream = () => {
    throw new Error('streaming should not be used without stream callbacks')
  }

  await provider.createMessage({ ...baseParams })
  const req = getCaptured()
  assert.notEqual(req.stream, true, 'non-streaming path must not flip stream flag on')
})

test('AnthropicProvider stream callback errors do not propagate', async () => {
  const provider = new AnthropicProvider({ apiKey: 'test-key' })
  ;(provider as any).client.messages.stream = () => {
    const handlers: Record<string, Array<(...args: any[]) => void>> = {}
    return {
      on(event: string, fn: (...args: any[]) => void) {
        ;(handlers[event] ||= []).push(fn)
        return this
      },
      async finalMessage() {
        for (const fn of handlers['text'] ?? []) fn('delta')
        return {
          content: [{ type: 'text', text: 'delta' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      },
    }
  }

  const result = await provider.createMessage({
    ...baseParams,
    stream: {
      onText: () => {
        throw new Error('user callback blew up')
      },
    },
  })

  // Despite the throwing callback, the call resolves normally.
  assert.equal(result.stopReason, 'end_turn')
})
