/**
 * Tracing — types (v3.3 prototype).
 *
 * Goal: capture every meaningful run event in a structured stream that hosts
 * can persist, replay, or forward to OTel/dashboards. The differentiator vs
 * openai-agents tracing dashboard is **replay** — peer dashboards can view
 * past runs but cannot drive a deterministic re-execution from any prefix.
 *
 * Event shape is intentionally narrow: `kind` + `at` + free-form `data`.
 * Concrete kinds (`graph_step`, `guardrail`, `tool_call` …) are documented
 * but not enforced — hosts can add custom kinds without forking the SDK.
 *
 * @module
 */

import type { GraphStep } from '../graph/types.js'
import type { GuardrailEvaluation, GuardrailScope } from '../guardrails/types.js'

export interface TraceEvent {
  /** Discriminator. Built-in kinds: `graph_step`, `guardrail`, `tool_call`, `tool_cache`, `tool_concurrency_adjust`, `note`. Hosts may extend. */
  kind: string
  /** Unix epoch ms when the event occurred. */
  at: number
  /** Free-form payload. Concrete shape lives on `kind`. */
  data: unknown
  /** Optional run id; falls back to TraceRun.id at append time. */
  runId?: string
  /** Optional grouping (graph node, agent, subagent, …). */
  spanId?: string
}

export interface TraceRun {
  id: string
  startedAt: number
  endedAt?: number
  /** Events in append order. */
  events: TraceEvent[]
  /** Free-form metadata (graph id, prompt hash, model id …). */
  meta: Record<string, unknown>
}

export interface TraceQuery {
  kinds?: string[]
  spanId?: string
  /** Inclusive lower bound on event index. */
  fromIndex?: number
  /** Exclusive upper bound on event index. */
  toIndex?: number
}

/** Convenience factories for built-in event kinds. */
export interface GraphStepEventData {
  step: GraphStep
}
export interface GuardrailEventData {
  scope: GuardrailScope
  evaluation: GuardrailEvaluation
  toolName?: string
  agentId?: string
}
export interface ToolCallEventData {
  toolName: string
  phase: 'request' | 'result'
  input?: unknown
  output?: unknown
  error?: string
}

/**
 * `tool_cache` event payload — one event per cacheable `tool.call()`
 * dispatch. `outcome: 'hit'` means the result was served from the
 * turn-scoped cache; `'miss'` means the tool actually ran. Tools that
 * are not `isReadOnly() && isConcurrencySafe()` bypass the cache and
 * emit no `tool_cache` event.
 *
 * The event mirrors the aggregate counters in
 * `AgentRunTrace.tool_cache?: { hits, misses }` but is per-call, so
 * OTel/streaming consumers can correlate cache outcomes to individual
 * `tool_use` ids in real time.
 */
export interface ToolCacheEventData {
  toolName: string
  toolUseId: string
  outcome: 'hit' | 'miss'
}

/**
 * `tool_concurrency_adjust` event payload — one event per AIMD limit
 * change. Mirrors `AgentRunAdaptiveConcurrencyAdjustment` but as a
 * streaming TraceEvent so OTel consumers see every halve/+1 decision
 * in real time, not only at run end via
 * `AgentRunTrace.tool_concurrency_adaptive.adjustments`.
 *
 * Emitted only when the host opts into `adaptiveToolConcurrency`. The
 * static-fallback controller never produces this event (byte-identical
 * default trace behavior preserved).
 */
export interface ToolConcurrencyAdjustEventData {
  /** 0-based index over adaptive-affecting concurrent chunks (size > 1). */
  batchIndex: number
  /** Limit before this adjustment. */
  previous: number
  /** Limit after this adjustment. */
  current: number
  /** `'error'` = batch had at least one tool error → halve. `'success'` = clean batch → +1. */
  reason: 'error' | 'success'
}
