import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_RETRY_CONFIG,
  getRetryDelay,
  isRetryableError,
  withRetry,
  type RetryConfig,
} from '../src/utils/retry.ts'

const fastRetryConfig: RetryConfig = {
  ...DEFAULT_RETRY_CONFIG,
  maxRetries: 2,
  baseDelayMs: 1,
  maxDelayMs: 5,
}

test('isRetryableError covers transient API and network failures', () => {
  assert.equal(isRetryableError({ status: 429 }), true)
  assert.equal(isRetryableError({ status: 529 }), true)
  assert.equal(isRetryableError({ status: 400 }), false)
  assert.equal(isRetryableError({ code: 'ECONNRESET' }), true)
  assert.equal(isRetryableError({ category: 'network' }), true)
  assert.equal(isRetryableError({ code: 'UND_ERR_SOCKET' }), true)
  assert.equal(isRetryableError({ cause: { code: 'ENOTFOUND' } }), true)
  assert.equal(isRetryableError(new TypeError('fetch failed')), true)
  assert.equal(isRetryableError({ name: 'AbortError' }), false)
  assert.equal(isRetryableError({ error: { type: 'overloaded_error' } }), true)
})

test('getRetryDelay honors retry-after values before exponential backoff', () => {
  const config = { ...fastRetryConfig, maxDelayMs: 30_000 }
  assert.equal(getRetryDelay(0, config, { retryAfterMs: 250 }), 250)
  assert.equal(getRetryDelay(0, config, { retryAfterMs: 50_000 }), config.maxDelayMs)
})

test('withRetry retries retryable failures until success', async () => {
  let calls = 0

  const result = await withRetry(async () => {
    calls += 1
    if (calls < 3) {
      const err: any = new Error('temporarily overloaded')
      err.status = 503
      throw err
    }
    return 'ok'
  }, fastRetryConfig)

  assert.equal(result, 'ok')
  assert.equal(calls, 3)
})

test('withRetry stops immediately for non-retryable failures', async () => {
  let calls = 0

  await assert.rejects(
    withRetry(async () => {
      calls += 1
      const err: any = new Error('bad request')
      err.status = 400
      throw err
    }, fastRetryConfig),
    /bad request/,
  )

  assert.equal(calls, 1)
})

test('withRetry observes abort signals during retry backoff', async () => {
  const controller = new AbortController()
  let calls = 0

  await assert.rejects(
    withRetry(async () => {
      calls += 1
      const err: any = new Error('rate limited')
      err.status = 429
      err.headers = { 'retry-after': '30' }
      setTimeout(() => controller.abort(), 5)
      throw err
    }, {
      ...fastRetryConfig,
      maxDelayMs: 30_000,
    }, controller.signal),
    (err: any) => err?.name === 'AbortError' && err?.message === 'Aborted',
  )

  assert.equal(calls, 1)
})

test('withRetry throws AbortError when already aborted', async () => {
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    withRetry(async () => 'unreachable', fastRetryConfig, controller.signal),
    (err: any) => err?.name === 'AbortError' && err?.message === 'Aborted',
  )
})
