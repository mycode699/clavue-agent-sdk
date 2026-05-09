import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildErrorResultEvent,
  buildFinalResultEvent,
} from '../src/engine/result-events.ts'
import type { AgentRunTrace } from '../src/types.ts'

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

const baseState = {
  sessionId: 'sess-1',
  totalUsage: { input_tokens: 10, output_tokens: 20 },
  numTurns: 2,
  totalCost: 0.01,
  durationApiMs: 1234.5,
  modelUsage: { 'claude-sonnet-4-6': { input_tokens: 10, output_tokens: 20 } },
  permissionDenials: [],
  evidence: [],
  qualityGates: [],
  trace: makeTrace(),
}

test('buildErrorResultEvent produces is_error=true result with supplied subtype + errors', () => {
  const ev = buildErrorResultEvent({
    ...baseState,
    subtype: 'error',
    errors: ['boom'],
  })
  assert.equal(ev.type, 'result')
  if (ev.type !== 'result') return
  assert.equal(ev.subtype, 'error')
  assert.equal(ev.is_error, true)
  assert.equal(ev.session_id, 'sess-1')
  assert.equal(ev.num_turns, 2)
  assert.equal(ev.duration_api_ms, 1235, 'durationApiMs is rounded')
  assert.deepEqual(ev.errors, ['boom'])
  assert.equal(ev.cost, 0.01)
  assert.equal(ev.total_cost_usd, 0.01)
})

test('buildErrorResultEvent supports error_guardrail_abort subtype', () => {
  const ev = buildErrorResultEvent({
    ...baseState,
    subtype: 'error_guardrail_abort',
    errors: ['guardrail blocked Bash: no secrets'],
  })
  if (ev.type !== 'result') return assert.fail('expected result type')
  assert.equal(ev.subtype, 'error_guardrail_abort')
  assert.equal(ev.is_error, true)
})

test('buildErrorResultEvent supports error_during_execution subtype', () => {
  const ev = buildErrorResultEvent({
    ...baseState,
    subtype: 'error_during_execution',
    errors: ['Blocked by UserPromptSubmit hook'],
  })
  if (ev.type !== 'result') return assert.fail('expected result type')
  assert.equal(ev.subtype, 'error_during_execution')
})

test('buildFinalResultEvent marks is_error=false for success subtype', () => {
  const ev = buildFinalResultEvent({ ...baseState, subtype: 'success' })
  if (ev.type !== 'result') return assert.fail('expected result type')
  assert.equal(ev.subtype, 'success')
  assert.equal(ev.is_error, false)
  assert.equal(ev.errors, undefined)
})

test('buildFinalResultEvent marks is_error=true for max-turns termination', () => {
  const ev = buildFinalResultEvent({ ...baseState, subtype: 'error_max_turns' })
  if (ev.type !== 'result') return assert.fail('expected result type')
  assert.equal(ev.subtype, 'error_max_turns')
  assert.equal(ev.is_error, true)
})

test('buildFinalResultEvent marks is_error=true for quality_gate_failed with errors', () => {
  const ev = buildFinalResultEvent({
    ...baseState,
    subtype: 'error_quality_gate_failed',
    errors: ['Required quality gate failed: tests - 3 failures'],
  })
  if (ev.type !== 'result') return assert.fail('expected result type')
  assert.equal(ev.subtype, 'error_quality_gate_failed')
  assert.equal(ev.is_error, true)
  assert.deepEqual(ev.errors, ['Required quality gate failed: tests - 3 failures'])
})

test('buildFinalResultEvent marks is_error=true for budget exhaustion', () => {
  const ev = buildFinalResultEvent({ ...baseState, subtype: 'error_max_budget_usd' })
  if (ev.type !== 'result') return assert.fail('expected result type')
  assert.equal(ev.is_error, true)
  assert.equal(ev.subtype, 'error_max_budget_usd')
})

test('buildFinalResultEvent preserves trace + usage + modelUsage defensive copies', () => {
  const state = {
    ...baseState,
    trace: makeTrace(),
    modelUsage: {
      'claude-sonnet-4-6': { input_tokens: 5, output_tokens: 10 },
      'claude-haiku-4-5': { input_tokens: 1, output_tokens: 2 },
    },
  }
  const ev = buildFinalResultEvent({ ...state, subtype: 'success' })
  if (ev.type !== 'result') return assert.fail('expected result type')
  assert.equal(ev.usage, state.totalUsage)
  assert.equal(ev.model_usage, state.modelUsage)
  assert.equal(ev.trace, state.trace)
})
