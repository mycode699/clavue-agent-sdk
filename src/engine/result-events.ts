/**
 * Result-event helpers — Slice K4. Three call sites in `submitMessage`
 * (model-call error, guardrail abort, final success/error) emit `SDKResultMessage`
 * with mostly the same shape: usage, num_turns, cost, defensive trace +
 * evidence + quality-gate copies. Centralizing the shape here eliminates
 * drift between the three branches and makes the engine generator focus on
 * control flow.
 *
 * Pure data — no I/O, no async. Caller still owns the `yield`.
 */

import { SDK_EVENT_SCHEMA_VERSION } from '../types.js'
import type {
  AgentRunTrace,
  Evidence,
  QualityGateResult,
  SDKMessage,
  TokenUsage,
} from '../types.js'

export interface ResultEventStateSnapshot {
  sessionId: string
  totalUsage: TokenUsage
  numTurns: number
  totalCost: number
  durationApiMs: number
  modelUsage: Record<string, { input_tokens: number; output_tokens: number }>
  permissionDenials: AgentRunTrace['permission_denials']
  evidence: Evidence[]
  qualityGates: QualityGateResult[]
  trace: AgentRunTrace
}

export interface BuildErrorResultInput extends ResultEventStateSnapshot {
  /** SDK result subtype — caller picks 'error' / 'error_guardrail_abort' / etc. */
  subtype: 'error' | 'error_guardrail_abort' | 'error_during_execution'
  errors: string[]
}

/**
 * Build an `is_error: true` SDKResultMessage for mid-run failures (model
 * error, guardrail abort). Shape is identical for both call sites — the
 * only thing that differs is `subtype` and `errors`.
 */
export function buildErrorResultEvent(input: BuildErrorResultInput): SDKMessage {
  return {
    type: 'result',
    schema_version: SDK_EVENT_SCHEMA_VERSION,
    subtype: input.subtype,
    session_id: input.sessionId,
    is_error: true,
    usage: input.totalUsage,
    num_turns: input.numTurns,
    total_cost_usd: input.totalCost,
    duration_api_ms: Math.round(input.durationApiMs),
    model_usage: input.modelUsage,
    permission_denials: input.permissionDenials,
    evidence: input.evidence,
    quality_gates: input.qualityGates,
    trace: input.trace,
    errors: input.errors,
    cost: input.totalCost,
  }
}

export interface BuildFinalResultInput extends ResultEventStateSnapshot {
  /**
   * Resolved subtype. Caller computes it from baseSubtype + gate failure
   * (logic stays in engine because budget/normal/turns/gate decisions are
   * intertwined with the loop state).
   */
  subtype: 'success' | 'error_max_turns' | 'error_max_budget_usd' | 'error_quality_gate_failed'
  /** Errors slot — only populated for gate failure path. */
  errors?: string[]
}

/**
 * Build the terminal SDKResultMessage emitted when the agentic loop ends
 * (normal completion, budget exceeded, max turns, or required gate failure).
 */
export function buildFinalResultEvent(input: BuildFinalResultInput): SDKMessage {
  return {
    type: 'result',
    schema_version: SDK_EVENT_SCHEMA_VERSION,
    subtype: input.subtype,
    session_id: input.sessionId,
    is_error: input.subtype !== 'success',
    num_turns: input.numTurns,
    total_cost_usd: input.totalCost,
    duration_api_ms: Math.round(input.durationApiMs),
    usage: input.totalUsage,
    model_usage: input.modelUsage,
    permission_denials: input.permissionDenials,
    evidence: input.evidence,
    quality_gates: input.qualityGates,
    trace: input.trace,
    errors: input.errors,
    cost: input.totalCost,
  }
}
