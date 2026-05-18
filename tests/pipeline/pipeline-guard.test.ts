import test from 'node:test'
import assert from 'node:assert/strict'

import { runGuardStage } from '../../src/engine/pipeline/guard.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { GuardStageInput } from '../../src/engine/pipeline/guard.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'test-run',
    sessionId: 'test-session',
    provider: {} as any,
    trace: {
      schema_version: '2.0.0',
      turns: [],
      tools: [],
      concurrency_batches: [],
      tool_concurrency_limit: 10,
      tool_concurrency_source: 'default',
      retry_count: 0,
      compaction_count: 0,
      permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0,
      apiAttempts: 0,
      maxOutputRecoveryAttempts: 0,
      completedNormally: false,
      budgetExceeded: false,
    },
  }
}

test('guard passes through when no abort, no budget breach, no hook block', async () => {
  const ctx = makeCtx()
  const input: GuardStageInput = {
    abortSignal: undefined,
    maxBudgetUsd: undefined,
    totalCost: 0,
    hookResults: [],
  }
  const result = await runGuardStage(ctx, input)
  assert.equal(result.kind, 'ok')
})

test('guard denies when abort signal fired', async () => {
  const ctx = makeCtx()
  const ac = new AbortController()
  ac.abort()
  const result = await runGuardStage(ctx, {
    abortSignal: ac.signal,
    maxBudgetUsd: undefined,
    totalCost: 0,
    hookResults: [],
  })
  assert.equal(result.kind, 'denied')
  if (result.kind === 'denied') {
    assert.match(result.reason, /abort/i)
  }
})

test('guard denies when budget exceeded', async () => {
  const ctx = makeCtx()
  const result = await runGuardStage(ctx, {
    abortSignal: undefined,
    maxBudgetUsd: 1.0,
    totalCost: 1.5,
    hookResults: [],
  })
  assert.equal(result.kind, 'denied')
  if (result.kind === 'denied') {
    assert.match(result.reason, /budget/i)
    assert.equal(ctx.state.budgetExceeded, true)
  }
})

test('guard denies when hook returns block=true', async () => {
  const ctx = makeCtx()
  const result = await runGuardStage(ctx, {
    abortSignal: undefined,
    maxBudgetUsd: undefined,
    totalCost: 0,
    hookResults: [{ block: true, reason: 'forbidden by policy' }],
  })
  assert.equal(result.kind, 'denied')
  if (result.kind === 'denied') {
    assert.match(result.reason, /forbidden by policy/)
  }
})

test('guard records duration in ctx.trace.pipeline_stages.guard', async () => {
  const ctx = makeCtx()
  await runGuardStage(ctx, {
    abortSignal: undefined,
    maxBudgetUsd: undefined,
    totalCost: 0,
    hookResults: [],
  })
  assert.ok(ctx.trace.pipeline_stages?.guard)
  assert.equal(ctx.trace.pipeline_stages?.guard?.status, 'ok')
  assert.ok(typeof ctx.trace.pipeline_stages?.guard?.duration_ms === 'number')
})

test('guard does not deny when totalCost just below maxBudgetUsd', async () => {
  const ctx = makeCtx()
  const result = await runGuardStage(ctx, {
    abortSignal: undefined,
    maxBudgetUsd: 1.0,
    totalCost: 0.99,
    hookResults: [],
  })
  assert.equal(result.kind, 'ok')
  assert.equal(ctx.state.budgetExceeded, false)
})

test('guard ignores hook results that did not block', async () => {
  const ctx = makeCtx()
  const result = await runGuardStage(ctx, {
    abortSignal: undefined,
    maxBudgetUsd: undefined,
    totalCost: 0,
    hookResults: [
      { block: false, reason: 'noted' },
      { block: undefined as any },
    ],
  })
  assert.equal(result.kind, 'ok')
})
