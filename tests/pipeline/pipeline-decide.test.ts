import test from 'node:test'
import assert from 'node:assert/strict'

import { runDecideStage } from '../../src/engine/pipeline/decide.ts'
import type { DecideStageInput } from '../../src/engine/pipeline/decide.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { CreateMessageResponse } from '../../src/providers/types.ts'

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

const noToolsResponse = (stop: string): CreateMessageResponse => ({
  content: [{ type: 'text', text: 'done' }],
  stopReason: stop as any,
  usage: { input_tokens: 1, output_tokens: 1 },
})

test('decide stops when no tool calls and stopReason=end_turn', async () => {
  const ctx = makeCtx()
  const input: DecideStageInput = {
    response: noToolsResponse('end_turn'),
    hadToolCalls: false,
    maxOutputRecoveryLimit: 3,
  }
  const result = await runDecideStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'stop')
  }
  assert.equal(ctx.state.completedNormally, true)
  assert.equal(ctx.trace.pipeline_stages?.decide?.status, 'ok')
})

test('decide triggers max_output_recovery when stopReason=max_tokens, no tools, attempts left', async () => {
  const ctx = makeCtx()
  ctx.state.maxOutputRecoveryAttempts = 0
  const result = await runDecideStage(ctx, {
    response: noToolsResponse('max_tokens'),
    hadToolCalls: false,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'max_output_recovery')
  }
  assert.equal(ctx.state.maxOutputRecoveryAttempts, 1)
})

test('decide stops when max_output_recovery attempts exhausted', async () => {
  const ctx = makeCtx()
  ctx.state.maxOutputRecoveryAttempts = 3
  const result = await runDecideStage(ctx, {
    response: noToolsResponse('max_tokens'),
    hadToolCalls: false,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'stop')
  }
  assert.equal(ctx.state.completedNormally, true)
})

test('decide continues when tools were called and stopReason != end_turn', async () => {
  const ctx = makeCtx()
  const result = await runDecideStage(ctx, {
    response: noToolsResponse('tool_use'),
    hadToolCalls: true,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'continue')
  }
  assert.equal(ctx.state.completedNormally, false)
})

test('decide stops when tools were called but stopReason=end_turn', async () => {
  const ctx = makeCtx()
  const result = await runDecideStage(ctx, {
    response: noToolsResponse('end_turn'),
    hadToolCalls: true,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'stop')
  }
  assert.equal(ctx.state.completedNormally, true)
})

test('decide resets max_output recovery counter when tools were called', async () => {
  const ctx = makeCtx()
  ctx.state.maxOutputRecoveryAttempts = 2
  await runDecideStage(ctx, {
    response: noToolsResponse('tool_use'),
    hadToolCalls: true,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(ctx.state.maxOutputRecoveryAttempts, 0)
})
