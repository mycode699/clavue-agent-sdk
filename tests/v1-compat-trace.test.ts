import test from 'node:test'
import assert from 'node:assert/strict'

import { downgradeTraceToV1 } from '../src/v1-compat/trace-shim.ts'
import type { AgentRunTrace } from '../src/types/trace.ts'

test('downgradeTraceToV1 strips pipeline_stages and sets schema_version=1.0.0', () => {
  const v2: AgentRunTrace = {
    schema_version: '2.0.0',
    turns: [], tools: [], concurrency_batches: [],
    tool_concurrency_limit: 10, tool_concurrency_source: 'default',
    retry_count: 0, compaction_count: 0, permission_denials: [],
    pipeline_stages: { guard: { duration_ms: 1, status: 'ok' } },
  }
  const v1 = downgradeTraceToV1(v2)
  assert.equal(v1.schema_version, '1.0.0')
  assert.equal((v1 as any).pipeline_stages, undefined)
})

test('downgradeTraceToV1 preserves all v1 fields', () => {
  const v2: AgentRunTrace = {
    schema_version: '2.0.0',
    turns: [{ index: 0, prompt_tokens: 1, completion_tokens: 1, latency_ms: 100 } as any],
    tools: [{ name: 'foo' } as any],
    concurrency_batches: [{ batch_index: 0, tool_count: 1 } as any],
    tool_concurrency_limit: 5,
    tool_concurrency_source: 'env',
    retry_count: 2,
    compaction_count: 1,
    permission_denials: [{ tool: 'shell', reason: 'denied' } as any],
  }
  const v1 = downgradeTraceToV1(v2)
  assert.equal(v1.turns.length, 1)
  assert.equal(v1.tools.length, 1)
  assert.equal(v1.concurrency_batches.length, 1)
  assert.equal(v1.tool_concurrency_limit, 5)
  assert.equal(v1.retry_count, 2)
  assert.equal(v1.permission_denials.length, 1)
})

test('downgradeTraceToV1 returns a defensive copy (no aliasing)', () => {
  const v2: AgentRunTrace = {
    schema_version: '2.0.0',
    turns: [], tools: [], concurrency_batches: [],
    tool_concurrency_limit: 10, tool_concurrency_source: 'default',
    retry_count: 0, compaction_count: 0, permission_denials: [],
    pipeline_stages: { call: { duration_ms: 5, status: 'ok' } },
  }
  const v1 = downgradeTraceToV1(v2)
  // Mutating the original must not affect the downgraded copy.
  ;(v2 as any).schema_version = '99.0.0'
  assert.equal(v1.schema_version, '1.0.0')
})
