import test from 'node:test'
import assert from 'node:assert/strict'

import type {
  PipelineContext,
  PipelineState,
  PipelineStageName,
} from '../../src/engine/pipeline/types.ts'
import { PIPELINE_STAGE_NAMES } from '../../src/engine/pipeline/types.ts'

test('PIPELINE_STAGE_NAMES lists all 7 stages in order', () => {
  assert.deepEqual(PIPELINE_STAGE_NAMES, [
    'guard',
    'compact',
    'render',
    'call',
    'stream',
    'tools',
    'decide',
  ])
})

test('PipelineStageName covers exactly the 7 stages', () => {
  // Compile-time check: every name must be assignable
  const names: PipelineStageName[] = [
    'guard', 'compact', 'render', 'call', 'stream', 'tools', 'decide',
  ]
  assert.equal(names.length, 7)
})

test('PipelineState shape is mutable with required scalars', () => {
  // Smoke check shape; full state machine is verified per stage.
  const state: PipelineState = {
    turnIndex: 0,
    apiAttempts: 0,
    maxOutputRecoveryAttempts: 0,
    completedNormally: false,
    budgetExceeded: false,
  }
  state.turnIndex = 1
  assert.equal(state.turnIndex, 1)
})

test('PipelineContext can be constructed with minimal valid fields', () => {
  // Compile-time / structural smoke check — the engine will inject the real
  // provider/trace/totalUsage; here we just ensure the shape compiles.
  const ctx: PipelineContext = {
    runId: 'r',
    sessionId: 's',
    provider: {} as any,
    trace: {} as any,
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
  assert.equal(ctx.runId, 'r')
  assert.equal(ctx.tools.length, 0)
})
