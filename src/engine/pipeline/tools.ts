/**
 * Tools stage — extract tool_use blocks + dispatch + collect results.
 *
 * The actual tool execution is injected via `input.executeTools` so this
 * stage stays decoupled from QueryEngine internals (cache, concurrency
 * controller, guardrails are wired by engine.ts and threaded through the
 * injected executor).
 */

import type { PipelineContext, StageResult } from './types.js'
import type { CreateMessageResponse } from '../../providers/types.js'
import type { QueryEngineConfig, ToolResult } from '../../types.js'
import type { ToolResultCache } from '../tool-result-cache.js'
import type { ConcurrencyController } from '../concurrency-controller.js'
import type { SkillActivation } from '../skill-helpers.js'

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

export interface ToolsStageInput {
  response: CreateMessageResponse
  config: QueryEngineConfig
  activeSkill?: SkillActivation
  maxToolConcurrency: number
  /** Reserved for future stage-level cache integration. The current
   *  executor owns its own cache; passing this is optional. */
  toolResultCache?: ToolResultCache
  /** Reserved for future stage-level concurrency control. The current
   *  executor reads from the engine's controller directly. */
  concurrencyController?: ConcurrencyController
  /** Injected executor — engine.ts wires it to the existing executeTools method. */
  executeTools: (blocks: ToolUseBlock[]) => Promise<(ToolResult & { tool_name?: string })[]>
}

export interface ToolsStageOutput {
  toolUseBlocks: ToolUseBlock[]
  toolResults: (ToolResult & { tool_name?: string })[]
}

export async function runToolsStage(
  ctx: PipelineContext,
  input: ToolsStageInput,
): Promise<StageResult<ToolsStageOutput>> {
  const start = performance.now()
  const blocks = input.response.content.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use',
  )

  if (blocks.length === 0) {
    record(ctx, start, 'skipped')
    return { kind: 'ok', value: { toolUseBlocks: [], toolResults: [] } }
  }

  try {
    const results = await input.executeTools(blocks)
    record(ctx, start, 'ok')
    return { kind: 'ok', value: { toolUseBlocks: blocks, toolResults: results } }
  } catch (err) {
    record(ctx, start, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}

function record(
  ctx: PipelineContext,
  start: number,
  status: 'ok' | 'skipped' | 'error',
  errorMessage?: string,
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.tools = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
