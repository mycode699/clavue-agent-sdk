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
 *
 * Tier A #2: when an optional `concurrencyController` is supplied, the
 * concurrent-chunk size is sourced from `controller.current()` (can shrink
 * / grow between chunks) and `controller.onBatchComplete()` is notified
 * after each chunk. The static path (no controller) keeps the original
 * behavior byte-identical.
 */

import type { AgentRunTrace, AgentRunToolTrace, ToolContext, ToolDefinition, ToolResult } from '../types.js'
import type { ToolDispatchBatch } from './tool-helpers.js'
import type { ConcurrencyController } from './concurrency-controller.js'

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
  /** Optional Tier A #2 adaptive controller. Absent = static maxConcurrency. */
  concurrencyController?: ConcurrencyController
}

/**
 * Run a tool dispatch plan and return the ordered tool results. Mutates
 * `trace.concurrency_batches` and `trace.tools` in place — same contract as
 * the previous inline loop in `QueryEngine.executeTools`.
 */
export async function executeDispatchPlan<TBlock>(
  input: ExecuteDispatchPlanInput<TBlock>,
): Promise<ToolResultWithMeta[]> {
  const { plan, context, trace, maxConcurrency, executeSingle, concurrencyController } = input
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

    // Concurrent batch: split into Promise.all chunks bounded by the current
    // adaptive limit (or `maxConcurrency` when no controller is wired).
    let i = 0
    while (i < batch.entries.length) {
      const chunkSize = concurrencyController?.current() ?? maxConcurrency
      const slice = batch.entries.slice(i, i + chunkSize)
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

      // Notify the controller AFTER we see the results so the next chunk can
      // react. A chunk counts as errored if any result is `is_error: true`.
      if (concurrencyController) {
        const errors = batchResults.reduce((n, r) => n + (r.is_error ? 1 : 0), 0)
        concurrencyController.onBatchComplete({ size: slice.length, errors })
      }

      i += slice.length
    }
  }

  return results
}
