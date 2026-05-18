/**
 * Stream stage — drain partial text deltas while Call stage is in flight.
 *
 * Engine wires this concurrently with Call: Call pushes deltas to `queue`,
 * Stream yields them as `partial_message` SDKMessage events. When Call
 * completes (`isDoneRef.current = true`) and the queue is empty, drain
 * exits cleanly. If `wantStreaming` is false, the generator emits nothing
 * and records `status: 'skipped'`.
 */

import type { PipelineContext } from './types.js'
import type { SDKMessage } from '../../types.js'

export interface DrainStreamInput {
  queue: string[]
  wantStreaming: boolean
  /** Mutable ref the Call stage flips to true on completion. */
  isDoneRef: { current: boolean }
  /** Returns a promise that resolves when the queue gets new content
   *  or when Call signals completion. */
  waitForFill: () => Promise<void>
}

export async function* drainStream(
  ctx: PipelineContext,
  input: DrainStreamInput,
): AsyncGenerator<SDKMessage> {
  const start = performance.now()
  if (!input.wantStreaming) {
    record(ctx, start, 'skipped')
    return
  }
  try {
    while (!input.isDoneRef.current || input.queue.length > 0) {
      if (input.queue.length === 0) {
        await input.waitForFill()
        continue
      }
      const delta = input.queue.shift()!
      yield {
        type: 'partial_message',
        partial: { type: 'text', text: delta },
      } as SDKMessage
    }
    record(ctx, start, 'ok')
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
  ctx.trace.pipeline_stages.stream = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
