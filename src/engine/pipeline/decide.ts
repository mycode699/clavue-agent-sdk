/**
 * Decide stage — terminate / continue / max_output recovery.
 *
 * Inputs are the assistant response + whether tools were dispatched this
 * turn. Output instructs engine.ts what to do next:
 *   - 'stop': loop exits, success or final-turn
 *   - 'continue': run another turn (tools were called, more work pending)
 *   - 'max_output_recovery': inject "please continue" and refund the turn
 */

import type { PipelineContext, StageResult } from './types.js'
import type { CreateMessageResponse } from '../../providers/types.js'

export interface DecideStageInput {
  response: CreateMessageResponse
  hadToolCalls: boolean
  maxOutputRecoveryLimit: number
}

export type DecideNext = 'stop' | 'continue' | 'max_output_recovery'

export interface DecideStageOutput {
  next: DecideNext
}

export async function runDecideStage(
  ctx: PipelineContext,
  input: DecideStageInput,
): Promise<StageResult<DecideStageOutput>> {
  const start = performance.now()

  // 1. End-of-turn always wins (even if tools were called this turn — the
  //    model chose to stop, which means it considered the turn complete).
  if (input.response.stopReason === 'end_turn') {
    ctx.state.completedNormally = true
    record(ctx, start)
    return { kind: 'ok', value: { next: 'stop' } }
  }

  // 2. No tools + max_tokens → recovery if budget left, else stop.
  if (!input.hadToolCalls && input.response.stopReason === 'max_tokens') {
    if (ctx.state.maxOutputRecoveryAttempts < input.maxOutputRecoveryLimit) {
      ctx.state.maxOutputRecoveryAttempts += 1
      record(ctx, start)
      return { kind: 'ok', value: { next: 'max_output_recovery' } }
    }
    ctx.state.completedNormally = true
    record(ctx, start)
    return { kind: 'ok', value: { next: 'stop' } }
  }

  // 3. No tools + non-end_turn stop → engine done (e.g. content_filter).
  if (!input.hadToolCalls) {
    ctx.state.completedNormally = true
    record(ctx, start)
    return { kind: 'ok', value: { next: 'stop' } }
  }

  // 4. Tools were called → reset recovery counter, continue loop.
  ctx.state.maxOutputRecoveryAttempts = 0
  record(ctx, start)
  return { kind: 'ok', value: { next: 'continue' } }
}

function record(ctx: PipelineContext, start: number): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.decide = {
    duration_ms: performance.now() - start,
    status: 'ok',
  }
}
