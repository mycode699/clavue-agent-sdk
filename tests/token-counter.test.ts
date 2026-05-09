import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ApiBackedCounter,
  createApiBackedCounter,
  heuristicCounter,
  type CountTokensClientLike,
} from '../src/tokens/api-counter.ts'
import { estimateTokens } from '../src/utils/tokens.ts'

function makeClient(returnTokens: number): { client: CountTokensClientLike; calls: number } {
  let calls = 0
  return {
    calls: 0,
    get client() {
      return {
        messages: {
          async countTokens() {
            calls += 1
            ;(this as any)._calls = calls
            return { input_tokens: returnTokens }
          },
        },
      }
    },
    // expose calls via getter on the wrapper
  } as any
}

test('Slice G: heuristicCounter delegates to estimateTokens', () => {
  const text = 'hello world'
  assert.equal(heuristicCounter.count(text), estimateTokens(text))
})

test('Slice G: ApiBackedCounter returns heuristic value before calibration completes', () => {
  let calls = 0
  const client: CountTokensClientLike = {
    messages: {
      async countTokens() {
        calls += 1
        return { input_tokens: 999 }
      },
    },
  }
  const counter = new ApiBackedCounter({ client, model: 'test-model' })
  const text = 'a quick brown fox jumps over the lazy dog'
  const sync = counter.count(text)
  // Synchronous call returns the heuristic before any await fires.
  assert.equal(sync, estimateTokens(text))
  // But the warmup must have been queued.
  assert.ok(calls === 0 || calls === 1, 'warmup should queue at most one call by now')
})

test('Slice G: ApiBackedCounter calibrates factor from first probe via ready()', async () => {
  // Heuristic for plain ASCII gives ~chars/4. We force the API to claim
  // 2x that, so the post-warmup factor should be ~2.
  const text = 'a'.repeat(80) // heuristic ~ ceil(80/4) = 20
  const apiTokens = 40
  let calls = 0
  const client: CountTokensClientLike = {
    messages: {
      async countTokens() {
        calls += 1
        return { input_tokens: apiTokens }
      },
    },
  }
  const counter = createApiBackedCounter({ client, model: 'test' })
  counter.count(text) // queue warmup
  await counter.ready()

  // Factor should be ~2 since apiTokens / heuristic = 40 / 20 = 2.
  assert.ok(Math.abs(counter.getFactor() - 2) < 0.01)
  assert.equal(counter.getSampleCount(), 1)
  assert.equal(calls, 1)

  // Subsequent count should reflect the calibration.
  const after = counter.count(text)
  assert.equal(after, Math.round(estimateTokens(text) * 2))
})

test('Slice G: observeUsage updates factor via EMA', () => {
  // No client probe — we'll only feed observations.
  const client: CountTokensClientLike = {
    messages: {
      async countTokens() {
        return { input_tokens: 0 }
      },
    },
  }
  const counter = new ApiBackedCounter({ client, model: 'test', emaAlpha: 0.5 })
  // First sample sets factor directly (samples == 0 path).
  counter.observeUsage({ text: 'a'.repeat(40), tokens: 20 }) // heuristic=10, ratio=2
  assert.ok(Math.abs(counter.getFactor() - 2) < 0.01)
  assert.equal(counter.getSampleCount(), 1)
  // Second sample blends 50/50: 2 * 0.5 + 1 * 0.5 = 1.5.
  counter.observeUsage({ text: 'a'.repeat(40), tokens: 10 }) // heuristic=10, ratio=1
  assert.ok(Math.abs(counter.getFactor() - 1.5) < 0.01)
  assert.equal(counter.getSampleCount(), 2)
})

test('Slice G: ApiBackedCounter survives a throwing API and falls back to heuristic', async () => {
  const client: CountTokensClientLike = {
    messages: {
      async countTokens() {
        throw new Error('upstream 503')
      },
    },
  }
  const counter = new ApiBackedCounter({ client, model: 'test' })
  const text = 'hello'
  const initial = counter.count(text)
  await counter.ready()
  // Factor unchanged since calibration threw.
  assert.equal(counter.getFactor(), 1)
  assert.equal(counter.getSampleCount(), 0)
  assert.equal(initial, estimateTokens(text))
})

test('Slice G: ApiBackedCounter rejects pathological observation values', () => {
  const client: CountTokensClientLike = {
    messages: {
      async countTokens() {
        return { input_tokens: 0 }
      },
    },
  }
  const counter = new ApiBackedCounter({ client, model: 'test' })
  counter.observeUsage({ text: '', tokens: 100 }) // empty text → ignored
  counter.observeUsage({ text: 'hi', tokens: 0 }) // zero tokens → ignored
  counter.observeUsage({ text: 'hi', tokens: -5 }) // negative → ignored
  assert.equal(counter.getSampleCount(), 0)
  assert.equal(counter.getFactor(), 1)
})

test('Slice G: count(empty) returns 0 without queuing a probe', async () => {
  let calls = 0
  const client: CountTokensClientLike = {
    messages: {
      async countTokens() {
        calls += 1
        return { input_tokens: 1 }
      },
    },
  }
  const counter = new ApiBackedCounter({ client, model: 'test' })
  assert.equal(counter.count(''), 0)
  await counter.ready()
  assert.equal(calls, 0)
})

test('Slice G: probeEvery triggers periodic recalibration', async () => {
  let calls = 0
  const client: CountTokensClientLike = {
    messages: {
      async countTokens() {
        calls += 1
        return { input_tokens: 10 }
      },
    },
  }
  const counter = new ApiBackedCounter({ client, model: 'test', probeEvery: 3 })
  counter.count('hello') // call 1 — schedules warmup
  await counter.ready()
  assert.equal(calls, 1)

  counter.count('world') // call 2
  counter.count('again') // call 3
  counter.count('and-again') // call 4 — probeEvery threshold reached, schedules another probe
  // Allow the async probe to settle.
  await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(calls >= 2, `expected periodic probe to fire, got ${calls}`)
})
