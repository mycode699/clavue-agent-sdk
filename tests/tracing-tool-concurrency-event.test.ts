/**
 * Tier A #2 — `tool_concurrency_adjust` TraceEvent contract.
 *
 * Locks three things:
 *   1. `TraceStore.appendToolConcurrencyAdjust` writes a
 *      `kind: 'tool_concurrency_adjust'` event with the documented
 *      payload + `tool:concurrency` spanId.
 *   2. `eventToOtelSpan` maps the event to
 *      `tool.concurrency.adjust.<reason>` with documented attributes.
 *   3. Adaptive controller invokes `onAdjustment` exactly once per
 *      limit change; static controller never invokes it; the callback
 *      is wired through `buildConcurrencyController`.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TraceStore,
  eventToOtelSpan,
  JsonlExporter,
} from '../src/tracing/index.ts'
import type { ToolConcurrencyAdjustEventData } from '../src/tracing/index.ts'
import {
  buildConcurrencyController,
  createAdaptiveConcurrencyController,
  createStaticConcurrencyController,
} from '../src/engine/concurrency-controller.ts'
import type { AgentRunAdaptiveConcurrencyAdjustment } from '../src/types/trace.ts'

test('TraceStore.appendToolConcurrencyAdjust writes kind=tool_concurrency_adjust with tool:concurrency spanId', () => {
  const store = new TraceStore()
  const runId = store.startRun()
  const idx = store.appendToolConcurrencyAdjust({
    batchIndex: 0,
    previous: 4,
    current: 2,
    reason: 'error',
  })
  assert.equal(idx, 0)

  const events = store.query(runId, { kinds: ['tool_concurrency_adjust'] })
  assert.equal(events.length, 1)
  const evt = events[0]!
  assert.equal(evt.kind, 'tool_concurrency_adjust')
  assert.equal(evt.spanId, 'tool:concurrency')
  const payload = evt.data as ToolConcurrencyAdjustEventData
  assert.equal(payload.batchIndex, 0)
  assert.equal(payload.previous, 4)
  assert.equal(payload.current, 2)
  assert.equal(payload.reason, 'error')
})

test('eventToOtelSpan maps tool_concurrency_adjust to tool.concurrency.adjust.<reason> with documented attributes', () => {
  const halve = eventToOtelSpan({
    kind: 'tool_concurrency_adjust',
    at: 200,
    runId: 'run_y',
    spanId: 'tool:concurrency',
    data: { batchIndex: 3, previous: 8, current: 4, reason: 'error' } satisfies ToolConcurrencyAdjustEventData,
  })
  assert.equal(halve.name, 'tool.concurrency.adjust.error')
  assert.equal(halve.traceId, 'run_y')
  assert.equal(halve.spanId, 'tool:concurrency')
  assert.equal(halve.attributes['tool.concurrency.reason'], 'error')
  assert.equal(halve.attributes['tool.concurrency.previous'], 8)
  assert.equal(halve.attributes['tool.concurrency.current'], 4)
  assert.equal(halve.attributes['tool.concurrency.batch_index'], 3)

  const bump = eventToOtelSpan({
    kind: 'tool_concurrency_adjust',
    at: 300,
    runId: 'run_y',
    data: { batchIndex: 4, previous: 4, current: 5, reason: 'success' } satisfies ToolConcurrencyAdjustEventData,
  })
  assert.equal(bump.name, 'tool.concurrency.adjust.success')
  assert.equal(bump.attributes['tool.concurrency.reason'], 'success')
  assert.equal(bump.attributes['tool.concurrency.current'], 5)
})

test('adaptive controller fires onAdjustment exactly once per limit change', () => {
  const seen: AgentRunAdaptiveConcurrencyAdjustment[] = []
  const c = createAdaptiveConcurrencyController({
    initial: 4,
    min: 1,
    max: 8,
    onAdjustment: (adj) => seen.push(adj),
  })
  // Size-1 batch — controller ignores it (no adjustment).
  c.onBatchComplete({ size: 1, errors: 0 })
  assert.equal(seen.length, 0)

  // Errored batch → halve 4 → 2.
  c.onBatchComplete({ size: 3, errors: 1 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.previous, 4)
  assert.equal(seen[0]!.current, 2)
  assert.equal(seen[0]!.reason, 'error')
  assert.equal(seen[0]!.batch_index, 0)

  // Clean batch → +1: 2 → 3.
  c.onBatchComplete({ size: 3, errors: 0 })
  assert.equal(seen.length, 2)
  assert.equal(seen[1]!.previous, 2)
  assert.equal(seen[1]!.current, 3)
  assert.equal(seen[1]!.reason, 'success')
  assert.equal(seen[1]!.batch_index, 1)
})

test('adaptive controller does not fire onAdjustment when the limit pin-bounces against min/max', () => {
  const seen: AgentRunAdaptiveConcurrencyAdjustment[] = []
  const c = createAdaptiveConcurrencyController({
    initial: 1,
    min: 1,
    max: 1,
    onAdjustment: (adj) => seen.push(adj),
  })
  // Both halve and +1 would clamp back to 1 — no observable change.
  c.onBatchComplete({ size: 2, errors: 1 })
  c.onBatchComplete({ size: 2, errors: 0 })
  assert.equal(seen.length, 0, 'no-op adjustments must not emit events')
})

test('static controller never invokes onAdjustment via buildConcurrencyController', () => {
  let called = 0
  const c = buildConcurrencyController(false, 4, () => {
    called++
  })
  c.onBatchComplete({ size: 4, errors: 2 })
  c.onBatchComplete({ size: 4, errors: 0 })
  assert.equal(called, 0)
  assert.equal(c.snapshot(), undefined, 'static mode snapshot stays undefined')
  // Also via createStaticConcurrencyController directly.
  const s = createStaticConcurrencyController(4)
  s.onBatchComplete({ size: 4, errors: 1 })
  assert.equal(s.snapshot(), undefined)
})

test('JsonlExporter receives tool.concurrency.adjust spans interleaved with tool.cache spans', () => {
  const store = new TraceStore()
  const runId = store.startRun({}, 'jsonl-aimd')
  store.appendToolCache({ toolName: 'read_kv', toolUseId: 't-1', outcome: 'miss' })
  store.appendToolConcurrencyAdjust({ batchIndex: 0, previous: 4, current: 2, reason: 'error' })
  store.appendToolCache({ toolName: 'read_kv', toolUseId: 't-2', outcome: 'hit' })
  store.appendToolConcurrencyAdjust({ batchIndex: 1, previous: 2, current: 3, reason: 'success' })

  const exporter = new JsonlExporter()
  exporter.export(store.query(runId).map(eventToOtelSpan))
  const lines = exporter.drain().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 4)
  assert.deepEqual(
    lines.map((l) => l.name),
    ['tool.cache.miss', 'tool.concurrency.adjust.error', 'tool.cache.hit', 'tool.concurrency.adjust.success'],
  )
  // Cache spans share tool:<name>; concurrency spans share tool:concurrency.
  assert.deepEqual(
    lines.map((l) => l.spanId),
    ['tool:read_kv', 'tool:concurrency', 'tool:read_kv', 'tool:concurrency'],
  )
})

test('buildConcurrencyController routes adjustments through the callback in adaptive mode', () => {
  const seen: AgentRunAdaptiveConcurrencyAdjustment[] = []
  const c = buildConcurrencyController({ initial: 4, min: 1, max: 8 }, 4, (adj) => seen.push(adj))
  c.onBatchComplete({ size: 4, errors: 1 }) // halve
  c.onBatchComplete({ size: 4, errors: 0 }) // +1
  assert.equal(seen.length, 2)
  assert.deepEqual(seen.map((a) => a.reason), ['error', 'success'])
  const snap = c.snapshot()
  assert.ok(snap, 'snapshot present in adaptive mode')
  assert.deepEqual(snap.adjustments, seen, 'snapshot.adjustments mirrors callback-emitted adjustments')
})
