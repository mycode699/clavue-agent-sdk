/**
 * Tool dispatch executor — Slice K4c. Takes a `ToolDispatchBatch[]` (already
 * computed by planToolDispatch) and runs it: serial batches one-by-one,
 * concurrent batches via Promise.all bounded by `maxConcurrency`. Records
 * batch sizes into `trace.concurrency_batches` and tool traces into
 * `trace.tools`.
 *
 * The single-tool executor is injected so the engine keeps ownership of
 * the `executeSingleTool` method (which touches policy, hooks, guardrails,
 * skill activation, etc.). This helper only does batching + bookkeeping.
 */

import type { AgentRunTrace, AgentRunToolTrace, ToolContext, ToolDefinition, ToolResult } from '../types.js'
import type { ToolDispatchBatch } from './tool-helpers.js'

export type ToolResultWithMeta = ToolResult & { tool_name?: string }

export type ExecuteSingleToolFn<TBlock> = (
  block: TBlock,
  tool: ToolDefinition | undefined,
  context: ToolContext,
  recordTrace: ((trace: AgentRunToolTrace) => void) | true,
) => Promise<ToolResultWithMeta>

export interface ExecuteDispatchPlanInput<TBlock> {
  plan: ToolDispatchBatch<TBlock>[]
  context: ToolContext
  trace: AgentRunTrace
  maxConcurrency: number
  executeSingle: ExecuteSingleToolFn<TBlock>
}

/**
 * Run a tool dispatch plan and return the ordered tool results. Mutates
 * `trace.concurrency_batches` and `trace.tools` in place — same contract as
 * the previous inline loop in `QueryEngine.executeTools`.
 */
export async function executeDispatchPlan<TBlock>(
  input: ExecuteDispatchPlanInput<TBlock>,
): Promise<ToolResultWithMeta[]> {
  const { plan, context, trace, maxConcurrency, executeSingle } = input
  const results: ToolResultWithMeta[] = []

  for (const batch of plan) {
    if (batch.kind === 'serial') {
      const { block, tool } = batch.entries[0]!
      trace.concurrency_batches.push(1)
      // Serial path uses the legacy `recordTrace = true` shortcut so the
      // single-tool executor pushes its trace directly into `trace.tools`.
      results.push(await executeSingle(block, tool, context, true))
      continue
    }

    // Concurrent batch: split into Promise.all chunks bounded by maxConcurrency.
    for (let i = 0; i < batch.entries.length; i += maxConcurrency) {
      const slice = batch.entries.slice(i, i + maxConcurrency)
      trace.concurrency_batches.push(slice.length)
      const batchTraces: AgentRunToolTrace[] = []
      const batchResults = await Promise.all(
        slice.map((item, index) =>
          executeSingle(item.block, item.tool, context, (toolTrace) => {
            batchTraces[index] = toolTrace
          }),
        ),
      )
      trace.tools.push(...batchTraces)
      results.push(...batchResults)
    }
  }

  return results
}
