import test from 'node:test'
import assert from 'node:assert/strict'

import { Agent } from '../src/index.ts'
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from '../src/index.ts'

class StubProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  calls: CreateMessageParams[] = []

  constructor(private readonly responses: Array<CreateMessageResponse | Error>) {}

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.calls.push(params)
    const response = this.responses.shift()
    if (response instanceof Error) throw response
    return response ?? textResponse('done')
  }
}

function textResponse(text: string): CreateMessageResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input_tokens: 2, output_tokens: 3 },
  }
}

function apiError(message: string, status: number): Error & { status: number } {
  const err = new Error(message) as Error & { status: number }
  err.status = status
  return err
}

function providerError(message: string, category: string): Error & { category: string; provider: string; headers: Record<string, string> } {
  const err = new Error(message) as Error & { category: string; provider: string; headers: Record<string, string> }
  err.provider = 'openai'
  err.category = category
  err.headers = { 'retry-after': '0' }
  return err
}

test('Agent retries with fallbackModel after primary model failure', async () => {
  const provider = new StubProvider([
    apiError('primary model unavailable', 404),
    textResponse('fallback ok'),
  ])
  const agent = new Agent({
    model: 'gpt-primary',
    fallbackModel: 'gpt-fallback',
    tools: [],
    persistSession: false,
  })
  ;(agent as any).provider = provider

  const result = await agent.run('hello')

  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'fallback ok')
  assert.deepEqual(provider.calls.map((call) => call.model), ['gpt-primary', 'gpt-fallback'])
  assert.deepEqual(result.events.find((event) => event.type === 'result')?.model_usage, {
    'gpt-fallback': { input_tokens: 2, output_tokens: 3 },
  })
})

test('Agent does not use fallbackModel for non-retryable provider errors', async () => {
  for (const category of ['invalid_request', 'authentication', 'authorization', 'unsupported']) {
    const provider = new StubProvider([
      providerError('non-retryable provider error', category),
      textResponse('fallback ok'),
    ])
    const agent = new Agent({
      model: 'gpt-primary',
      fallbackModel: 'gpt-fallback',
      tools: [],
      persistSession: false,
    })
    ;(agent as any).provider = provider

    const result = await agent.run('hello')

    assert.equal(result.status, 'errored')
    assert.deepEqual(provider.calls.map((call) => call.model), ['gpt-primary'])
  }
})

test('Agent uses fallbackModel when normalized error has status=404 even if category is set', async () => {
  // Regression: shouldUseFallbackModel previously short-circuited on err.category
  // and never inspected status. After provider normalization a 404 from the
  // gateway arrives as { status: 404, category: 'unsupported' } — without this
  // path, configured fallbacks would silently never trigger.
  const err = new Error('primary not found') as Error & { status: number; category: string; provider: string; headers: Record<string, string> }
  err.status = 404
  err.category = 'unsupported'
  err.provider = 'openai'
  err.headers = {}
  const provider = new StubProvider([err, textResponse('fallback ok')])
  const agent = new Agent({
    model: 'gpt-primary',
    fallbackModel: 'gpt-fallback',
    tools: [],
    persistSession: false,
  })
  ;(agent as any).provider = provider

  const result = await agent.run('hello')

  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'fallback ok')
  assert.deepEqual(provider.calls.map((call) => call.model), ['gpt-primary', 'gpt-fallback'])
})

test('Agent retries fallbackModel after normalized retryable provider errors are exhausted', async () => {
  const provider = new StubProvider([
    providerError('provider overloaded', 'provider_error'),
    providerError('provider still overloaded', 'provider_error'),
    providerError('provider still overloaded', 'provider_error'),
    providerError('provider still overloaded', 'provider_error'),
    textResponse('fallback ok'),
  ])
  const agent = new Agent({
    model: 'gpt-primary',
    fallbackModel: 'gpt-fallback',
    tools: [],
    persistSession: false,
  })
  ;(agent as any).provider = provider

  const result = await agent.run('hello')

  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'fallback ok')
  assert.deepEqual(provider.calls.map((call) => call.model), [
    'gpt-primary',
    'gpt-primary',
    'gpt-primary',
    'gpt-primary',
    'gpt-fallback',
  ])
})

test('Agent does not use fallbackModel after cancellation', async () => {
  const abortErr = new Error('Aborted')
  abortErr.name = 'AbortError'
  const normalizedAbortErr = providerError('response cancelled', 'aborted')

  for (const err of [abortErr, normalizedAbortErr]) {
    const provider = new StubProvider([err])
    const agent = new Agent({
      model: 'gpt-primary',
      fallbackModel: 'gpt-fallback',
      tools: [],
      persistSession: false,
    })
    ;(agent as any).provider = provider

    const result = await agent.run('hello')

    assert.equal(result.status, 'errored')
    assert.deepEqual(provider.calls.map((call) => call.model), ['gpt-primary'])
  }
})

test('Agent preserves prompt-too-long recovery instead of using fallbackModel', async () => {
  const provider = new StubProvider([
    apiError('prompt is too long for this model', 400),
    textResponse('summary'),
    textResponse('compacted ok'),
  ])
  const agent = new Agent({
    model: 'gpt-primary',
    fallbackModel: 'gpt-fallback',
    tools: [],
    persistSession: false,
  })
  ;(agent as any).provider = provider

  const result = await agent.run('hello')

  assert.equal(result.status, 'completed')
  assert.equal(result.text, 'compacted ok')
  assert.deepEqual(provider.calls.map((call) => call.model), ['gpt-primary', 'gpt-primary', 'gpt-primary'])
  assert.equal(result.trace?.compaction_count, 1)
  assert.equal(result.trace?.compactions?.length, 1)
  assert.equal(result.trace?.compactions?.[0]?.trigger, 'prompt_too_long')
  assert.equal(result.trace?.compactions?.[0]?.status, 'succeeded')
  assert.equal(result.trace?.compactions?.[0]?.message_count_before, 1)
  assert.equal(result.trace?.compactions?.[0]?.message_count_after, 2)
  assert.equal(result.trace?.compactions?.[0]?.summary_chars, 'summary'.length)
  assert.ok((result.trace?.compactions?.[0]?.estimated_tokens_before ?? 0) > 0)
})

test('Agent max_output_tokens recovery still works on the final allowed turn', async () => {
  // Regression: previously max_output recovery did `continue` without
  // refunding the turn, so on the final turn the next loop iteration would
  // see turnsRemaining === 0 and exit before the continuation request was
  // ever sent. Mirror the compact-retry path: a recovery is a continuation
  // of the same logical turn.
  const provider = new StubProvider([
    {
      content: [{ type: 'text', text: 'starting…' }],
      stopReason: 'max_tokens',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    textResponse('finished after recovery'),
  ])
  const agent = new Agent({
    model: 'gpt-primary',
    tools: [],
    persistSession: false,
    maxTurns: 1,
  })
  ;(agent as any).provider = provider

  const result = await agent.run('hello')

  assert.equal(result.status, 'completed')
  assert.equal(provider.calls.length, 2, 'recovery continuation request must be sent even on final turn')
  assert.equal(result.text, 'finished after recovery')
})
