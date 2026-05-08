/**
 * AgentRun execution trace types — turns, tools, policy decisions, memory,
 * and compaction observability.
 */

import type { AgentAutonomyMode } from './runtime.js'
import type { PermissionBehavior, PermissionMode } from './permissions.js'
import type { MemoryPolicyMode } from './memory.js'

export interface AgentRunToolTrace {
  tool_use_id: string
  tool_name: string
  duration_ms: number
  is_error: boolean
  concurrency_safe: boolean
}

export type AgentRunPolicyDecisionSource =
  | 'permission_mode'
  | 'host_canUseTool'
  | 'policy_error'
  | 'hook'

export type AgentRunToolInputSummaryType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'undefined'
  | 'unknown'

export interface AgentRunToolInputSummary {
  type: AgentRunToolInputSummaryType
  keys?: string[]
  size_bytes?: number
}

export interface AgentRunToolSafetySummary {
  read: boolean
  write: boolean
  shell: boolean
  network: boolean
  external_state: boolean
  destructive: boolean
  approval_required: boolean
  idempotent?: boolean
}

export interface AgentRunPolicyDecisionTrace {
  tool_use_id: string
  tool_name: string
  timestamp: string
  behavior: PermissionBehavior
  source: AgentRunPolicyDecisionSource
  permission_mode: PermissionMode
  autonomy_mode: AgentAutonomyMode
  reason?: string
  input_summary: AgentRunToolInputSummary
  updated_input_summary?: AgentRunToolInputSummary
  input_rewritten: boolean
  safety: AgentRunToolSafetySummary
}

export interface AgentRunTurnTrace {
  turn: number
  duration_api_ms: number
  input_tokens: number
  output_tokens: number
  tool_calls: number
}

export type AgentRunMemoryValidationState = 'validated' | 'unvalidated'
export type AgentRunMemoryInjectionStatus = 'off' | 'empty' | 'injected'
export type AgentRunMemoryRedactionStatus = 'not_required' | 'redacted'

export interface AgentRunMemoryScoreComponent {
  reason: string
  score: number
}

export interface AgentRunMemoryTraceFilters {
  repo_path?: string
  session_id?: string
  text?: string
  tags?: string[]
  limit?: number
}

export interface AgentRunMemoryStoreTrace {
  configured: boolean
  dir?: string
}

export interface AgentRunMemorySelectionTrace {
  id: string
  type: import('../memory.js').MemoryType
  scope: import('../memory.js').MemoryScope
  title: string
  score: number
  score_reasons?: string[]
  score_components?: AgentRunMemoryScoreComponent[]
  matched_fields?: string[]
  validation_state?: AgentRunMemoryValidationState
  stale?: boolean
  redaction_status?: AgentRunMemoryRedactionStatus
  tags?: string[]
  source?: string
  confidence?: import('../memory.js').MemoryConfidence
  last_validated_at?: string
  repo_path?: string
  session_id?: string
}

export type AgentRunMemorySelectionSource = 'targeted' | 'repo_fallback' | 'off' | 'empty'

export interface AgentRunMemoryRetrievalStep {
  source: 'targeted' | 'repo_fallback'
  strategy?: AgentRunMemoryRetrievalStrategy
  query?: string
  repo_path?: string
  filters?: AgentRunMemoryTraceFilters
  candidate_count: number
  selected_count: number
  duration_ms?: number
}

export type AgentRunMemoryRetrievalStrategy = 'auto_inject' | 'brain_first'

export interface AgentRunMemoryTrace {
  schema_version?: string
  retrieval_id?: string
  policy: MemoryPolicyMode
  strategy?: AgentRunMemoryRetrievalStrategy
  query?: string
  repo_path?: string
  filters?: AgentRunMemoryTraceFilters
  store?: AgentRunMemoryStoreTrace
  duration_ms?: number
  selected_ids: string[]
  selected?: AgentRunMemorySelectionTrace[]
  injected_count: number
  injection_status?: AgentRunMemoryInjectionStatus
  selection_source?: AgentRunMemorySelectionSource
  retrieval_steps?: AgentRunMemoryRetrievalStep[]
  retrieved_before_first_model_call: boolean
}

export type AgentRunToolConcurrencySource = 'option' | 'env' | 'default'

export type AgentRunCompactionTrigger = 'auto_threshold' | 'prompt_too_long'
export type AgentRunCompactionStatus = 'succeeded' | 'failed'

export interface AgentRunCompactionTrace {
  trigger: AgentRunCompactionTrigger
  status: AgentRunCompactionStatus
  message_count_before: number
  message_count_after: number
  estimated_tokens_before: number
  estimated_tokens_after: number
  summary_chars: number
  dropped_chars: number
  failure_reason?: string
}

export interface AgentRunTrace {
  schema_version: string
  turns: AgentRunTurnTrace[]
  tools: AgentRunToolTrace[]
  concurrency_batches: number[]
  tool_concurrency_limit: number
  tool_concurrency_source: AgentRunToolConcurrencySource
  retry_count: number
  compaction_count: number
  compactions?: AgentRunCompactionTrace[]
  permission_denials: Array<{ tool: string; reason: string }>
  policy_decisions?: AgentRunPolicyDecisionTrace[]
  memory?: AgentRunMemoryTrace[]
}
