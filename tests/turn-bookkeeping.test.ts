import test from 'node:test'
import assert from 'node:assert/strict'

import {
  recordTurnUsage,
  tryCompactOnPromptTooLong,
} from '../src/engine/turn-bookkeeping.ts'
import type { CreateMessageResponse, LLMProvider } from '../src/providers/types.ts'
import { createAutoCompactState } from '../src/utils/compact.ts'
import type { AgentRunTrace, TokenUsage } from '../src/types.ts'

function makeTrace(): AgentRunTrace {
  return {
    schema_version: '1.0.0',
    turns: [],
    tools: [],
    concurrency_batches: [],
    tool_concurrency_limit: 10,
    tool_concurrency_source: 'default',
    retry_count: 0,
    compaction_count: 0,
    compactions: [],
    permission_denials: [],
    policy_decisions: [],
    memory: [],
  }
}

function makeProvider(opts: { compactSucceeds: boolean }): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage() {
      if (!opts.compactSucceeds) throw new Error('compaction summarizer also OOM')
      return {
        content: [{ type: 'text', text: 'compact summary' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 10 },
      }
    },
  }
}

test('tryCompactOnPromptTooLong recovers when compaction succeeds', async () => {
  const trace = makeTrace()
  const result = await tryCompactOnPromptTooLong({
    provider: makeProvider({ compactSucceeds: true }),
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'big prompt' } as any],
    state: createAutoCompactState(),
    trace,
  })
  assert.equal(result.recovered, true)
  assert.equal(trace.compaction_count, 1)
  assert.equal(trace.compactions?.length, 1)
  assert.equal(result.state.compacted, true)
})

test('tryCompactOnPromptTooLong does NOT re-compact if already compacted', async () => {
  const trace = makeTrace()
  const state = { ...createAutoCompactState(), compacted: true }
  const result = await tryCompactOnPromptTooLong({
    provider: makeProvider({ compactSucceeds: true }),
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'big' } as any],
    state,
    trace,
  })
  assert.equal(result.recovered, false)
  assert.equal(trace.compaction_count, 0, 'no second compaction recorded')
})

test('tryCompactOnPromptTooLong records failed compaction trace when summarizer fails', async () => {
  // compactConversation never throws — on summarizer error it returns a
  // result with `trace.status === 'failed'`. The recovery helper currently
  // treats that as "recovered: true" because it didn't throw, which matches
  // legacy engine behavior. Document the actual contract here so a future
  // refactor that distinguishes failed-trace from success can update both.
  const trace = makeTrace()
  const result = await tryCompactOnPromptTooLong({
    provider: makeProvider({ compactSucceeds: false }),
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'huge' } as any],
    state: createAutoCompactState(),
    trace,
  })
  // Legacy contract: helper returns recovered=true even on failed summary.
  assert.equal(result.recovered, true)
  assert.equal(trace.compaction_count, 1)
  // But the trace records the failure status so observers can see it.
  assert.equal(trace.compactions?.[0]?.status, 'failed')
})

function makeResponse(input: number, output: number, opts: { cacheCreate?: number; cacheRead?: number } = {}): CreateMessageResponse {
  return {
    content: [{ type: 'text', text: 'hi' }],
    stopReason: 'end_turn',
    usage: {
      input_tokens: input,
      output_tokens: output,
      cache_creation_input_tokens: opts.cacheCreate,
      cache_read_input_tokens: opts.cacheRead,
    },
  }
}

test('recordTurnUsage appends turn entry and folds usage into totals', () => {
  const trace = makeTrace()
  const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  const modelUsage: Record<string, { input_tokens: number; output_tokens: number }> = {}

  const r = recordTurnUsage({
    response: makeResponse(100, 50),
    successfulModel: 'claude-sonnet-4-6',
    turnApiTimeMs: 1234,
    trace,
    totalUsage,
    totalCost: 0,
    modelUsage,
    turnCount: 1,
  })

  assert.equal(trace.turns.length, 1)
  assert.equal(trace.turns[0]!.input_tokens, 100)
  assert.equal(trace.turns[0]!.output_tokens, 50)
  assert.equal(trace.turns[0]!.duration_api_ms, 1234)
  assert.equal(trace.turns[0]!.tool_calls, 0)
  assert.equal(totalUsage.input_tokens, 100)
  assert.equal(totalUsage.output_tokens, 50)
  assert.deepEqual(modelUsage['claude-sonnet-4-6'], { input_tokens: 100, output_tokens: 50 })
  assert.ok(r.totalCost > 0, 'cost should be > 0 when usage is non-zero')
})

test('recordTurnUsage accumulates cache token fields', () => {
  const trace = makeTrace()
  const totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  const modelUsage: Record<string, { input_tokens: number; output_tokens: number }> = {}

  recordTurnUsage({
    response: makeResponse(10, 5, { cacheCreate: 200, cacheRead: 1000 }),
    successfulModel: 'claude-sonnet-4-6',
    turnApiTimeMs: 100,
    trace,
    totalUsage,
    totalCost: 0,
    modelUsage,
    turnCount: 1,
  })

  recordTurnUsage({
    response: makeResponse(10, 5, { cacheCreate: 50, cacheRead: 500 }),
    successfulModel: 'claude-sonnet-4-6',
    turnApiTimeMs: 100,
    trace,
    totalUsage,
    totalCost: 0,
    modelUsage,
    turnCount: 2,
  })

  assert.equal(totalUsage.cache_creation_input_tokens, 250)
  assert.equal(totalUsage.cache_read_input_tokens, 1500)
})

test('recordTurnUsage counts tool_use blocks per turn', () => {
  const trace = makeTrace()
  const response: CreateMessageResponse = {
    content: [
      { type: 'text', text: 'thinking...' },
      { type: 'tool_use', id: 't1', name: 'Read', input: {} },
      { type: 'tool_use', id: 't2', name: 'Glob', input: {} },
    ] as any,
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }

  recordTurnUsage({
    response,
    successfulModel: 'claude-sonnet-4-6',
    turnApiTimeMs: 0,
    trace,
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    totalCost: 0,
    modelUsage: {},
    turnCount: 1,
  })

  assert.equal(trace.turns[0]!.tool_calls, 2)
})

test('recordTurnUsage handles response without usage gracefully', () => {
  const trace = makeTrace()
  const response: CreateMessageResponse = {
    content: [{ type: 'text', text: 'hi' }],
    stopReason: 'end_turn',
  }
  const r = recordTurnUsage({
    response,
    successfulModel: 'claude-sonnet-4-6',
    turnApiTimeMs: 100,
    trace,
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    totalCost: 5.55,
    modelUsage: {},
    turnCount: 1,
  })
  assert.equal(trace.turns.length, 1, 'turn entry recorded even without usage')
  assert.equal(trace.turns[0]!.input_tokens, 0)
  assert.equal(r.totalCost, 5.55, 'cost unchanged when no usage')
})
