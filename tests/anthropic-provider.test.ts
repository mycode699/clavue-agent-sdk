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
