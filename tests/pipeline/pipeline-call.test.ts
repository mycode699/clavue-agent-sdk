import test from 'node:test'
import assert from 'node:assert/strict'

import { runCallStage } from '../../src/engine/pipeline/call.ts'
import type { CallStageInput } from '../../src/engine/pipeline/call.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { CreateMessageResponse, ProviderError } from '../../src/providers/types.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r', sessionId: 's',
    provider: {} as any,
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

const fakeResponse: CreateMessageResponse = {
  content: [{ type: 'text', text: 'hi' }],
  stopReason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
}

test('call returns response + successfulModel for happy path', async () => {
  const ctx = makeCtx()
  const input: CallStageInput = {
    requestModel: 'm-primary',
    fallbackModel: undefined,
    abortSignal: undefined,
    createModelMessage: async (model) => {
      assert.equal(model, 'm-primary')
      return fakeResponse
    },
  }
  const result = await runCallStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.successfulModel, 'm-primary')
    assert.equal(result.value.response.content[0]?.type, 'text')
  }
  assert.equal(ctx.state.apiAttempts, 1)
  assert.equal(ctx.trace.pipeline_stages?.call?.status, 'ok')
})

test('call increments apiAttempts on each onAttempt fire', async () => {
  const ctx = makeCtx()
  let calls = 0
  const result = await runCallStage(ctx, {
    requestModel: 'm-primary',
    fallbackModel: undefined,
    abortSignal: undefined,
    createModelMessage: async () => {
      calls++
      return fakeResponse
    },
  })
  assert.equal(result.kind, 'ok')
  assert.equal(ctx.state.apiAttempts, 1)
  assert.equal(calls, 1)
})

test('call records error status when provider throws', async () => {
  const ctx = makeCtx()
  let threw = false
  try {
    await runCallStage(ctx, {
      requestModel: 'm-primary',
      fallbackModel: undefined,
      abortSignal: undefined,
      createModelMessage: async () => { throw new Error('provider down') },
    })
  } catch {
    threw = true
  }
  assert.equal(threw, true)
  assert.equal(ctx.trace.pipeline_stages?.call?.status, 'error')
  assert.match(ctx.trace.pipeline_stages?.call?.error_message ?? '', /provider down/)
})

test('call falls back to secondary model on retryable provider error', async () => {
  const ctx = makeCtx()
  let lastModel = ''
  const tries: string[] = []
  const result = await runCallStage(ctx, {
    requestModel: 'm-primary',
    fallbackModel: 'm-fallback',
    abortSignal: undefined,
    createModelMessage: async (model) => {
      tries.push(model)
      lastModel = model
      if (model === 'm-primary') {
        const err = new Error('overload') as ProviderError
        err.provider = 'anthropic'
        err.category = 'overload'
        err.status = 529
        throw err
      }
      return fakeResponse
    },
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.successfulModel, 'm-fallback')
  }
  assert.equal(lastModel, 'm-fallback')
  assert.deepEqual(tries[0], 'm-primary')
})

test('call records duration_ms even when error occurs', async () => {
  const ctx = makeCtx()
  try {
    await runCallStage(ctx, {
      requestModel: 'm-primary',
      fallbackModel: undefined,
      abortSignal: undefined,
      createModelMessage: async () => { throw new Error('crash') },
    })
  } catch { /* expected */ }
  assert.ok(typeof ctx.trace.pipeline_stages?.call?.duration_ms === 'number')
  assert.ok(ctx.trace.pipeline_stages!.call!.duration_ms >= 0)
})
