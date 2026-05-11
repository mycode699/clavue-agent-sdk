import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildConcurrencyController,
  createAdaptiveConcurrencyController,
  createStaticConcurrencyController,
} from '../src/engine/concurrency-controller.ts'

test('static controller is a no-op pass-through', () => {
  const c = createStaticConcurrencyController(5)
  assert.equal(c.current(), 5)
  c.onBatchComplete({ size: 3, errors: 0 })
  assert.equal(c.current(), 5)
  c.onBatchComplete({ size: 3, errors: 2 })
  assert.equal(c.current(), 5)
  assert.equal(c.snapshot(), undefined, 'static path leaves trace untouched')
})

test('adaptive controller halves on error and increments on success', () => {
  const c = createAdaptiveConcurrencyController({ initial: 8, min: 1, max: 8 })
  assert.equal(c.current(), 8)

  // Errored chunk → halve.
  c.onBatchComplete({ size: 8, errors: 1 })
  assert.equal(c.current(), 4)

  // Clean chunk → +1.
  c.onBatchComplete({ size: 4, errors: 0 })
  assert.equal(c.current(), 5)

  // Another clean chunk → +1.
  c.onBatchComplete({ size: 5, errors: 0 })
  assert.equal(c.current(), 6)

  const snap = c.snapshot()
  assert.ok(snap)
  assert.equal(snap!.enabled, true)
  assert.equal(snap!.initial, 8)
  assert.equal(snap!.min, 1)
  assert.equal(snap!.max, 8)
  assert.equal(snap!.final, 6)
  assert.equal(snap!.adjustments.length, 3)
  assert.equal(snap!.adjustments[0]!.reason, 'error')
  assert.equal(snap!.adjustments[0]!.previous, 8)
  assert.equal(snap!.adjustments[0]!.current, 4)
  assert.equal(snap!.adjustments[1]!.reason, 'success')
})

test('adaptive controller clamps to min on repeated errors', () => {
  const c = createAdaptiveConcurrencyController({ initial: 8, min: 2, max: 8 })
  for (let i = 0; i < 6; i++) c.onBatchComplete({ size: 4, errors: 1 })
  assert.equal(c.current(), 2, 'never goes below min=2')
})

test('adaptive controller clamps to max on repeated success', () => {
  const c = createAdaptiveConcurrencyController({ initial: 2, min: 1, max: 4 })
  for (let i = 0; i < 10; i++) c.onBatchComplete({ size: 2, errors: 0 })
  assert.equal(c.current(), 4, 'never exceeds max=4')
})

test('adaptive controller ignores size<=1 chunks (single calls do not adjust)', () => {
  const c = createAdaptiveConcurrencyController({ initial: 4, min: 1, max: 8 })
  c.onBatchComplete({ size: 1, errors: 1 })
  assert.equal(c.current(), 4, 'serial-shaped chunk must not move limit')
  c.onBatchComplete({ size: 1, errors: 0 })
  assert.equal(c.current(), 4)
  assert.equal(c.snapshot()!.adjustments.length, 0)
})

test('adaptive controller does not record no-op adjustments at boundaries', () => {
  const c = createAdaptiveConcurrencyController({ initial: 1, min: 1, max: 4 })
  // Already at min — error is a no-op, must not record.
  c.onBatchComplete({ size: 2, errors: 1 })
  assert.equal(c.current(), 1)
  assert.equal(c.snapshot()!.adjustments.length, 0)
})

test('buildConcurrencyController returns static when adaptive is omitted', () => {
  const c = buildConcurrencyController(undefined, 5)
  assert.equal(c.current(), 5)
  assert.equal(c.snapshot(), undefined)
})

test('buildConcurrencyController returns static when adaptive is false', () => {
  const c = buildConcurrencyController(false, 5)
  assert.equal(c.current(), 5)
  assert.equal(c.snapshot(), undefined)
})

test('buildConcurrencyController accepts true and uses resolved limit as initial', () => {
  const c = buildConcurrencyController(true, 6)
  assert.equal(c.current(), 6)
  c.onBatchComplete({ size: 6, errors: 1 })
  assert.equal(c.current(), 3)
  const snap = c.snapshot()
  assert.equal(snap!.initial, 6)
  assert.equal(snap!.max, 6)
  assert.equal(snap!.min, 1)
})

test('buildConcurrencyController accepts object overrides', () => {
  const c = buildConcurrencyController({ min: 2, max: 4, initial: 3 }, 10)
  assert.equal(c.current(), 3)
  const snap0 = c.snapshot()
  assert.equal(snap0!.min, 2)
  assert.equal(snap0!.max, 4)
  c.onBatchComplete({ size: 3, errors: 0 })
  assert.equal(c.current(), 4)
  c.onBatchComplete({ size: 4, errors: 0 })
  assert.equal(c.current(), 4, 'capped at max=4')
})
