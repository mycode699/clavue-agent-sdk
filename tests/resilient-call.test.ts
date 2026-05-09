import test from 'node:test'
import assert from 'node:assert/strict'

import { runResilientCall } from '../src/engine/resilient-call.ts'
import type { CreateMessageResponse, ProviderError } from '../src/providers/types.ts'
import { abortError } from '../src/utils/abort.ts'

function fakeResponse(text: string): CreateMessageResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function makeProviderError(opts: { status?: number; category?: ProviderError['category'] } = {}): ProviderError {
  const err = new Error('fake provider error') as ProviderError
  err.provider = 'anthropic'
  err.category = opts.category ?? 'unknown'
  err.status = opts.status
  return err
}

test('runResilientCall returns primary response on first try', async () => {
  let attempts = 0
  const result = await runResilientCall({
    primaryModel: 'm-primary',
    call: async (model) => {
      attempts++
      assert.equal(model, 'm-primary')
      return fakeResponse('ok')
    },
    onAttempt: () => {},
  })
  assert.equal(result.model, 'm-primary')
  assert.equal(result.response.content[0]?.type, 'text')
  assert.equal(attempts, 1)
})

test('runResilientCall falls back to secondary on retryable provider error', async () => {
  let primaryCalls = 0
  let fallbackCalls = 0
  const result = await runResilientCall({
    primaryModel: 'm-primary',
    fallbackModel: 'm-fallback',
    // Disable retry so the test runs in <50ms instead of waiting for backoff.
    retryConfig: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [] },
    call: async (model) => {
      if (model === 'm-primary') {
        primaryCalls++
        // 404 / unsupported = legacy fallback trigger.
        throw makeProviderError({ status: 404, category: 'unsupported' })
      }
      fallbackCalls++
      return fakeResponse('fallback-ok')
    },
  })
  assert.equal(result.model, 'm-fallback')
  assert.equal(primaryCalls, 1)
  assert.equal(fallbackCalls, 1)
})

test('runResilientCall does NOT fall back on prompt-too-long (engine handles via compaction)', async () => {
  await assert.rejects(
    () => runResilientCall({
      primaryModel: 'm-primary',
      fallbackModel: 'm-fallback',
      retryConfig: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [] },
      call: async () => {
        const err = new Error('prompt is too long: 200000 tokens') as ProviderError
        err.status = 400
        throw err
      },
    }),
    /prompt is too long/i,
  )
})

test('runResilientCall does NOT fall back on abort signal', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => runResilientCall({
      primaryModel: 'm-primary',
      fallbackModel: 'm-fallback',
      abortSignal: controller.signal,
      retryConfig: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [] },
      call: async () => { throw makeProviderError({ status: 503, category: 'provider_error' }) },
    }),
  )
})

test('runResilientCall does NOT fall back on AbortError class', async () => {
  await assert.rejects(
    () => runResilientCall({
      primaryModel: 'm-primary',
      fallbackModel: 'm-fallback',
      retryConfig: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [] },
      call: async () => { throw abortError() },
    }),
  )
})

test('runResilientCall does NOT fall back on non-categorical errors (e.g. authentication)', async () => {
  let primaryCalls = 0
  let fallbackCalls = 0
  await assert.rejects(
    () => runResilientCall({
      primaryModel: 'm-primary',
      fallbackModel: 'm-fallback',
      retryConfig: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [] },
      call: async (model) => {
        if (model === 'm-primary') {
          primaryCalls++
          throw makeProviderError({ status: 401, category: 'authentication' })
        }
        fallbackCalls++
        return fakeResponse('should-never-run')
      },
    }),
  )
  assert.equal(primaryCalls, 1)
  assert.equal(fallbackCalls, 0, 'fallback must not run on auth errors')
})

test('runResilientCall onAttempt fires once for primary, once for fallback', async () => {
  let attempts = 0
  await runResilientCall({
    primaryModel: 'm-primary',
    fallbackModel: 'm-fallback',
    retryConfig: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [] },
    call: async (model) => {
      if (model === 'm-primary') throw makeProviderError({ status: 404, category: 'unsupported' })
      return fakeResponse('ok')
    },
    onAttempt: () => { attempts++ },
  })
  assert.equal(attempts, 2, 'one onAttempt call per attempted model')
})

test('runResilientCall throws primary error when no fallback configured', async () => {
  await assert.rejects(
    () => runResilientCall({
      primaryModel: 'm-primary',
      retryConfig: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [] },
      call: async () => { throw makeProviderError({ status: 503, category: 'provider_error' }) },
    }),
    (err: Error) => /fake provider error/.test(err.message),
  )
})
