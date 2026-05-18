import test from 'node:test'
import assert from 'node:assert/strict'

import { runCompactStage } from '../../src/engine/pipeline/compact.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { CompactStageInput } from '../../src/engine/pipeline/compact.ts'
import { createAutoCompactState } from '../../src/utils/compact.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r',
    sessionId: 's',
    provider: { countTokens: async () => ({ input_tokens: 100 }) } as any,
    trace: {
      schema_version: '2.0.0',
      turns: [], tools: [], concurrency_batches: [],
      tool_concurrency_limit: 10, tool_concurrency_source: 'default',
      retry_count: 0, compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

test('compact returns messages unchanged when context fits', async () => {
  const ctx = makeCtx()
  const messages = [{ role: 'user', content: 'hi' }] as any
  const input: CompactStageInput = {
    model: 'claude-3-5-sonnet',
    messages,
    state: createAutoCompactState(),
    abortSignal: undefined,
  }
  const result = await runCompactStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.messages.length, 1)
    assert.equal(result.value.apiMessages.length, 1)
  }
  assert.equal(ctx.trace.pipeline_stages?.compact?.status, 'ok')
})

test('compact records duration_ms', async () => {
  const ctx = makeCtx()
  await runCompactStage(ctx, {
    model: 'claude-3-5-sonnet',
    messages: [{ role: 'user', content: 'x' }] as any,
    state: createAutoCompactState(),
    abortSignal: undefined,
  })
  assert.ok(typeof ctx.trace.pipeline_stages?.compact?.duration_ms === 'number')
})

test('compact micro-compacts large tool results in apiMessages', async () => {
  const ctx = makeCtx()
  const big = 'x'.repeat(200_000)
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
  ] as any
  const result = await runCompactStage(ctx, {
    model: 'claude-3-5-sonnet',
    messages,
    state: createAutoCompactState(),
    abortSignal: undefined,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    // micro-compact truncates; the apiMessages copy must shrink
    const apiSize = JSON.stringify(result.value.apiMessages).length
    const origSize = JSON.stringify(messages).length
    assert.ok(apiSize < origSize, `expected micro-compact to shrink: ${apiSize} < ${origSize}`)
  }
})

test('compact preserves message order in apiMessages', async () => {
  const ctx = makeCtx()
  const messages = [
    { role: 'user', content: 'a' },
    { role: 'assistant', content: 'b' },
    { role: 'user', content: 'c' },
  ] as any
  const result = await runCompactStage(ctx, {
    model: 'claude-3-5-sonnet',
    messages,
    state: createAutoCompactState(),
    abortSignal: undefined,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.apiMessages.length, 3)
    assert.equal((result.value.apiMessages[0] as any).content, 'a')
    assert.equal((result.value.apiMessages[2] as any).content, 'c')
  }
})

test('compact result includes updated state object', async () => {
  const ctx = makeCtx()
  const initialState = createAutoCompactState()
  const result = await runCompactStage(ctx, {
    model: 'claude-3-5-sonnet',
    messages: [{ role: 'user', content: 'x' }] as any,
    state: initialState,
    abortSignal: undefined,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.ok(result.value.state, 'state must be returned')
    // shape check — state has the same shape as input
    assert.equal(typeof result.value.state, 'object')
  }
})
