/**
 * AdaptiveConcurrencyController — AIMD-style limit for the per-turn
 * concurrent tool dispatch (Tier A #2 / opt-in).
 *
 * Motivation: a static `maxToolConcurrency` is a coarse blunt instrument.
 * When tools start failing (provider 5xx, rate limits, sandbox errors),
 * fanning out N parallel calls just multiplies the damage and slows the
 * turn. When everything is clean, we want to walk up to the cap.
 *
 * Algorithm (additive-increase / multiplicative-decrease):
 * - Start at `initial` (defaults to the resolved static limit).
 * - After every concurrent chunk:
 *   - any tool result with `is_error: true`  → `current = max(min, floor(current/2))`
 *   - all results clean                       → `current = min(max, current + 1)`
 * - Serial batches do not affect the limit (they are size-1 anyway).
 *
 * Static mode is a no-op pass-through so `dispatch-executor` can always
 * call `controller.current()` / `controller.onBatchComplete()` regardless
 * of whether adaptive concurrency is enabled. `snapshot()` returns
 * `undefined` in static mode so the engine only attaches the trace field
 * when adaptive is actually doing work.
 */

import type { AgentRunAdaptiveConcurrencyTrace, AgentRunAdaptiveConcurrencyAdjustment } from '../types/trace.js'

export interface AdaptiveConcurrencyOptions {
  /** Initial concurrent chunk size. Clamped into [min, max]. */
  initial: number
  /** Lower bound. Default = 1. */
  min?: number
  /** Upper bound. Default = `initial`. */
  max?: number
}

export interface ConcurrencyController {
  /** Limit to apply to the next concurrent chunk. */
  current(): number
  /** Notify the controller a concurrent chunk just completed. */
  onBatchComplete(input: { size: number; errors: number }): void
  /**
   * Final adaptive trace, or `undefined` for the static no-op controller.
   * The engine attaches this to `AgentRunTrace.tool_concurrency_adaptive`.
   */
  snapshot(): AgentRunAdaptiveConcurrencyTrace | undefined
}

export function createStaticConcurrencyController(limit: number): ConcurrencyController {
  return {
    current: () => limit,
    onBatchComplete: () => {},
    snapshot: () => undefined,
  }
}

export function createAdaptiveConcurrencyController(
  opts: AdaptiveConcurrencyOptions,
): ConcurrencyController {
  const initial = clampPositive(opts.initial)
  const min = Math.max(1, clampPositive(opts.min ?? 1))
  const max = Math.max(min, clampPositive(opts.max ?? initial))
  let current = clamp(initial, min, max)

  const adjustments: AgentRunAdaptiveConcurrencyAdjustment[] = []
  let batchIndex = 0

  return {
    current: () => current,
    onBatchComplete: ({ size, errors }) => {
      // Single-call chunks (size === 1) cannot be "decreased further" and
      // adding +1 to the limit on every serial-shaped chunk is noise — so
      // the controller only reacts to true fan-outs.
      if (size <= 1) return
      const previous = current
      if (errors > 0) {
        current = Math.max(min, Math.floor(current / 2))
      } else {
        current = Math.min(max, current + 1)
      }
      if (current !== previous) {
        adjustments.push({
          batch_index: batchIndex,
          previous,
          current,
          reason: errors > 0 ? 'error' : 'success',
        })
      }
      batchIndex++
    },
    snapshot: () => ({
      enabled: true,
      initial,
      min,
      max,
      final: current,
      adjustments: adjustments.map((a) => ({ ...a })),
    }),
  }
}

function clampPositive(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 1
  return Math.floor(value)
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Resolve the controller for a run from the engine config:
 * - `false` / `undefined` → static no-op (legacy behavior).
 * - `true` → adaptive with defaults: `min=1`, `max=initial=resolvedLimit`.
 * - `{ min, max, initial }` → adaptive with overrides; `initial` falls back
 *   to `resolvedLimit`, `min` to 1, `max` to `initial`.
 */
export function buildConcurrencyController(
  configured: boolean | { min?: number; max?: number; initial?: number } | undefined,
  resolvedLimit: number,
): ConcurrencyController {
  if (!configured) return createStaticConcurrencyController(resolvedLimit)
  if (configured === true) {
    return createAdaptiveConcurrencyController({ initial: resolvedLimit })
  }
  return createAdaptiveConcurrencyController({
    initial: configured.initial ?? resolvedLimit,
    min: configured.min,
    max: configured.max,
  })
}
