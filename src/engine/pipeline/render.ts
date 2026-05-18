/**
 * Render stage — build system prompt + turn request.
 *
 * Wraps `buildSystemPrompt` (engine/prompt-helpers) + `buildTurnRequest`
 * (engine/turn-request). Output is a ready-to-issue request that the Call
 * stage will hand to the provider.
 */

import type { PipelineContext, StageResult } from './types.js'
import { buildSystemPrompt } from '../prompt-helpers.js'
import { buildTurnRequest, type BuiltTurnRequest } from '../turn-request.js'
import type { SkillActivation } from '../skill-helpers.js'
import type { NormalizedMessageParam } from '../../providers/types.js'
import type { QueryEngineConfig } from '../../types.js'

export interface RenderStageInput {
  config: QueryEngineConfig
  apiMessages: NormalizedMessageParam[]
  activeSkill?: SkillActivation
  partialQueue: string[]
  releaseDrain: () => void
}

export interface RenderStageOutput extends BuiltTurnRequest {
  systemPrompt: string
}

export async function runRenderStage(
  ctx: PipelineContext,
  input: RenderStageInput,
): Promise<StageResult<RenderStageOutput>> {
  const start = performance.now()
  try {
    const built = await buildSystemPrompt(input.config)
    if (built.memoryTrace) {
      if (!ctx.trace.memory) ctx.trace.memory = []
      ctx.trace.memory.push(built.memoryTrace)
    }
    const turnRequest = buildTurnRequest({
      config: input.config,
      provider: ctx.provider,
      systemPrompt: built.systemPrompt,
      apiMessages: input.apiMessages,
      activeSkill: input.activeSkill,
      partialQueue: input.partialQueue,
      releaseDrain: input.releaseDrain,
    })
    record(ctx, start, 'ok')
    return {
      kind: 'ok',
      value: { ...turnRequest, systemPrompt: built.systemPrompt },
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
  ctx.trace.pipeline_stages.render = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
