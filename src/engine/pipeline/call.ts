/**
 * Call stage — issue the per-turn model call with retry + fallback.
 *
 * Wraps `runResilientCall` (engine/resilient-call) and stamps timing +
 * status on `trace.pipeline_stages.call`. Each underlying attempt bumps
 * `ctx.state.apiAttempts` via the `onAttempt` hook, matching the legacy
 * engine counter.
 *
 * Errors are not swallowed: the stage records `status: 'error'` with the
 * message and rethrows so the engine can run its prompt-too-long /
 * compaction-and-retry path one layer up.
 */

import type { CreateMessageResponse } from '../../providers/types.js'
import type { PipelineContext, StageResult } from './types.js'
import { runResilientCall } from '../resilient-call.js'

export interface CallStageInput {
  requestModel: string
  fallbackModel?: string | string[]
  abortSignal?: AbortSignal
  /** Issues the model call. Returns the raw provider response. */
  createModelMessage: (model: string) => Promise<CreateMessageResponse>
}

export interface CallStageOutput {
  response: CreateMessageResponse
  /** Which model produced the response (primary or one of the fallbacks). */
  successfulModel: string
}

export async function runCallStage(
  ctx: PipelineContext,
  input: CallStageInput,
): Promise<StageResult<CallStageOutput>> {
  const start = performance.now()
  try {
    const result = await runResilientCall({
      primaryModel: input.requestModel,
      fallbackModel: input.fallbackModel,
      abortSignal: input.abortSignal,
      call: input.createModelMessage,
      onAttempt: () => {
        ctx.state.apiAttempts += 1
      },
    })
    record(ctx, start, 'ok')
    return {
      kind: 'ok',
      value: { response: result.response, successfulModel: result.model },
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
  ctx.trace.pipeline_stages.call = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
