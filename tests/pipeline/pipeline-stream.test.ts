import test from 'node:test'
import assert from 'node:assert/strict'

import { drainStream } from '../../src/engine/pipeline/stream.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r', sessionId: 's', provider: {} as any,
    trace: {
      schema_version: '2.0.0', turns: [], tools: [],
      concurrency_batches: [], tool_concurrency_limit: 10,
      tool_concurrency_source: 'default', retry_count: 0,
      compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

test('drainStream yields nothing when streaming disabled', async () => {
  const ctx = makeCtx()
  const queue: string[] = ['ignored']
  const stream = drainStream(ctx, {
    queue,
    wantStreaming: false,
    isDoneRef: { current: false },
    waitForFill: () => Promise.resolve(),
  })
  const events: any[] = []
  for await (const ev of stream) events.push(ev)
  assert.equal(events.length, 0)
  assert.equal(ctx.trace.pipeline_stages?.stream?.status, 'skipped')
})

test('drainStream yields partial_message events from queue until done', async () => {
  const ctx = makeCtx()
  const queue: string[] = ['hel', 'lo']
  const isDoneRef = { current: false }
  let resumeWaiter: (() => void) | null = null
  const waitForFill = () => new Promise<void>((res) => { resumeWaiter = res })

  const stream = drainStream(ctx, {
    queue, wantStreaming: true, isDoneRef, waitForFill,
  })
  const collector: any[] = []
  const consumeP = (async () => {
    for await (const ev of stream) collector.push(ev)
  })()

  // Drain initial 2 items, queue empty → drainStream awaits waitForFill
  while (collector.length < 2) await new Promise((r) => setImmediate(r))
  assert.deepEqual(collector.map((e) => e.partial.text), ['hel', 'lo'])
  assert.equal(collector[0].type, 'partial_message')

  // Mark done and unblock the waiter
  isDoneRef.current = true
  resumeWaiter?.()

  await consumeP
  assert.equal(collector.length, 2)
})

test('drainStream records duration_ms + status=ok on clean close', async () => {
  const ctx = makeCtx()
  const isDoneRef = { current: true }
  const stream = drainStream(ctx, {
    queue: [], wantStreaming: true, isDoneRef,
    waitForFill: () => Promise.resolve(),
  })
  for await (const _ev of stream) { /* noop */ }
  assert.equal(ctx.trace.pipeline_stages?.stream?.status, 'ok')
  assert.ok(typeof ctx.trace.pipeline_stages?.stream?.duration_ms === 'number')
  assert.ok(ctx.trace.pipeline_stages!.stream!.duration_ms >= 0)
})

test('drainStream drains remaining queue even after isDoneRef flipped', async () => {
  const ctx = makeCtx()
  const queue: string[] = ['leftover-1', 'leftover-2']
  const isDoneRef = { current: true }  // already done from the start
  const stream = drainStream(ctx, {
    queue, wantStreaming: true, isDoneRef,
    waitForFill: () => Promise.resolve(),
  })
  const collector: any[] = []
  for await (const ev of stream) collector.push(ev)
  assert.equal(collector.length, 2)
  assert.deepEqual(collector.map((e) => e.partial.text), ['leftover-1', 'leftover-2'])
})

test('drainStream records error status when generator errors', async () => {
  const ctx = makeCtx()
  const isDoneRef = { current: false }
  const stream = drainStream(ctx, {
    queue: [],
    wantStreaming: true,
    isDoneRef,
    waitForFill: () => Promise.reject(new Error('fill error')),
  })
  let threw = false
  try {
    for await (const _ev of stream) { /* noop */ }
  } catch {
    threw = true
  }
  assert.equal(threw, true)
  assert.equal(ctx.trace.pipeline_stages?.stream?.status, 'error')
  assert.match(ctx.trace.pipeline_stages?.stream?.error_message ?? '', /fill error/)
})
