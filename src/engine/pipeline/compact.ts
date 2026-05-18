/**
 * Compact stage — auto-compact + micro-compact for the per-turn API call.
 *
 * Wraps existing helpers `maybeAutoCompactBeforeTurn` and
 * `applyMicroCompactForApi` from `engine/compact-stage.ts`. The wrapper
 * adds pipeline-level timing + denied/error short-circuits.
 */

import type { NormalizedMessageParam } from '../../providers/types.js'
import type { PipelineContext, StageResult } from './types.js'
import {
  applyMicroCompactForApi,
  maybeAutoCompactBeforeTurn,
} from '../compact-stage.js'
import type { AutoCompactState } from '../../utils/compact.js'

export interface CompactStageInput {
  model: string
  messages: NormalizedMessageParam[]
  state: AutoCompactState
  abortSignal?: AbortSignal
  /** Optional pre/post hooks (PreCompact/PostCompact). Caller wires them. */
  onPreCompact?: () => Promise<void>
  onPostCompact?: () => Promise<void>
}

export interface CompactStageOutput {
  /** Possibly-compacted message history (mutates engine.messages). */
  messages: NormalizedMessageParam[]
  /** Updated compact state (must be persisted by caller). */
  state: AutoCompactState
  /** Micro-compacted copy used only for this turn's API request. */
  apiMessages: NormalizedMessageParam[]
}

export async function runCompactStage(
  ctx: PipelineContext,
  input: CompactStageInput,
): Promise<StageResult<CompactStageOutput>> {
  const start = performance.now()
  try {
    const compacted = await maybeAutoCompactBeforeTurn({
      provider: ctx.provider,
      model: input.model,
      messages: input.messages,
      state: input.state,
      abortSignal: input.abortSignal,
      trace: ctx.trace,
      onPreCompact: input.onPreCompact,
      onPostCompact: input.onPostCompact,
    })
    const apiMessages = applyMicroCompactForApi(compacted.messages)
    record(ctx, start, 'ok')
    return {
      kind: 'ok',
      value: {
        messages: compacted.messages,
        state: compacted.state,
        apiMessages,
      },
    }
  } catch (err) {
    record(ctx, start, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}

function record(
  ctx: PipelineContext,
  start: number,
  status: 'ok' | 'error',
  errorMessage?: string,
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.compact = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
