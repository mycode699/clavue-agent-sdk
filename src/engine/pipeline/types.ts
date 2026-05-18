/**
 * Pipeline contracts shared across all 7 stages.
 *
 * Each stage is a pure-ish function that takes a context + input and returns
 * an output. State mutation is concentrated in PipelineState (a single
 * mutable carrier passed through the loop) so individual stages stay
 * testable without spinning up a full QueryEngine.
 */

import type {
  AgentRunTrace,
  TokenUsage,
  ToolDefinition,
} from '../../types.js'
import type {
  LLMProvider,
} from '../../providers/types.js'

export const PIPELINE_STAGE_NAMES = [
  'guard',
  'compact',
  'render',
  'call',
  'stream',
  'tools',
  'decide',
] as const

export type PipelineStageName = (typeof PIPELINE_STAGE_NAMES)[number]

/** Per-turn mutable state. Cleared between runs, persists across the
 *  generator's `submitMessage` loop. */
export interface PipelineState {
  turnIndex: number
  apiAttempts: number
  maxOutputRecoveryAttempts: number
  completedNormally: boolean
  budgetExceeded: boolean
}

/** Read-mostly context handed to every stage. The `state` field is the only
 *  mutation surface. */
export interface PipelineContext {
  readonly runId: string
  readonly sessionId: string
  readonly provider: LLMProvider
  readonly trace: AgentRunTrace
  readonly totalUsage: TokenUsage
  readonly tools: ToolDefinition[]
  state: PipelineState
}

/** Generic stage signature. Each concrete stage refines In/Out. */
export type PipelineStage<In, Out> = (
  ctx: PipelineContext,
  input: In,
) => Promise<Out>

/** Reused across guard/compact/render outputs to short-circuit the loop. */
export interface StageDenied {
  kind: 'denied'
  reason: string
  errors: string[]
}

export type StageResult<T> = { kind: 'ok'; value: T } | StageDenied
