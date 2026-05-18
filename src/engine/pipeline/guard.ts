/**
 * Guard stage — pre-turn permission / budget / hook gate.
 *
 * Responsibilities:
 *   - Honor abort signal
 *   - Enforce maxBudgetUsd
 *   - Honor UserPromptSubmit hook block decisions (caller passes results)
 *
 * Out of scope (handled by other stages):
 *   - Tool-level permission (Tools stage)
 *   - Token budget / context window (Compact stage)
 *   - Model-specific safety (Call stage)
 */

import type { PipelineContext, StageResult } from './types.js'

export interface GuardStageInput {
  abortSignal?: AbortSignal
  maxBudgetUsd?: number
  totalCost: number
  /** Pre-collected results from UserPromptSubmit hooks. */
  hookResults: Array<{ block?: boolean; reason?: string }>
}

export interface GuardStageOutput {
  /** Always 'pass' when StageResult.kind === 'ok'. */
  marker: 'pass'
}

export async function runGuardStage(
  ctx: PipelineContext,
  input: GuardStageInput,
): Promise<StageResult<GuardStageOutput>> {
  const start = performance.now()

  // 1. Abort signal
  if (input.abortSignal?.aborted) {
    recordStage(ctx, start, 'denied')
    return {
      kind: 'denied',
      reason: 'abort signal received before turn',
      errors: ['Aborted'],
    }
  }

  // 2. Budget
  if (input.maxBudgetUsd !== undefined && input.totalCost >= input.maxBudgetUsd) {
    ctx.state.budgetExceeded = true
    recordStage(ctx, start, 'denied')
    return {
      kind: 'denied',
      reason: `budget exceeded (${input.totalCost} >= ${input.maxBudgetUsd})`,
      errors: [`Max budget reached: $${input.maxBudgetUsd}`],
    }
  }

  // 3. Hook block
  const blocked = input.hookResults.find((r) => r.block === true)
  if (blocked) {
    const reason = blocked.reason || 'blocked by hook'
    recordStage(ctx, start, 'denied')
    return {
      kind: 'denied',
      reason,
      errors: [`Blocked by UserPromptSubmit hook: ${reason}`],
    }
  }

  recordStage(ctx, start, 'ok')
  return { kind: 'ok', value: { marker: 'pass' } }
}

function recordStage(
  ctx: PipelineContext,
  start: number,
  status: 'ok' | 'denied',
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.guard = {
    duration_ms: performance.now() - start,
    status,
  }
}
