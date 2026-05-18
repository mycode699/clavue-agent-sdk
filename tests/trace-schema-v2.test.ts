import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_RUN_TRACE_SCHEMA_VERSION,
} from '../src/types/schema-versions.ts'
import type {
  AgentRunTrace,
  AgentRunPipelineStageTrace,
} from '../src/types/trace.ts'

test('AGENT_RUN_TRACE_SCHEMA_VERSION is 2.0.0', () => {
  assert.equal(AGENT_RUN_TRACE_SCHEMA_VERSION, '2.0.0')
})

test('AgentRunTrace.pipeline_stages is optional and indexed by stage name', () => {
  const trace: AgentRunTrace = {
    schema_version: AGENT_RUN_TRACE_SCHEMA_VERSION,
    turns: [],
    tools: [],
    concurrency_batches: [],
    tool_concurrency_limit: 10,
    tool_concurrency_source: 'default',
    retry_count: 0,
    compaction_count: 0,
    permission_denials: [],
    pipeline_stages: {
      guard: { duration_ms: 1.2, status: 'ok' },
      compact: { duration_ms: 0.5, status: 'ok' },
    },
  }
  assert.equal(trace.pipeline_stages?.guard?.status, 'ok')
})

test('AgentRunPipelineStageTrace status enum is closed', () => {
  const ok: AgentRunPipelineStageTrace = { duration_ms: 0, status: 'ok' }
  const skipped: AgentRunPipelineStageTrace = { duration_ms: 0, status: 'skipped' }
  const denied: AgentRunPipelineStageTrace = { duration_ms: 0, status: 'denied' }
  const error: AgentRunPipelineStageTrace = {
    duration_ms: 0,
    status: 'error',
    error_message: 'boom',
  }
  assert.equal(ok.status, 'ok')
  assert.equal(skipped.status, 'skipped')
  assert.equal(denied.status, 'denied')
  assert.equal(error.error_message, 'boom')
})
