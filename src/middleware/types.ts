/**
 * Middleware types — Koa-style `(ctx, next) => Promise<void>` chain wrapping
 * `Agent.query()` invocations. Composes with existing event hooks; does not
 * replace them.
 *
 * Stable contract:
 * - `ctx.prompt` — user prompt for this query (mutable before `next()`)
 * - `ctx.options` — Partial<AgentOptions> overrides (mutable before `next()`)
 * - `ctx.startedAt` — ms timestamp set by the runtime before the first mw runs
 * - `ctx.finishedAt` — ms timestamp set by the runtime after the chain unwinds
 * - `ctx.error` — set if downstream chain or engine throws
 * - `ctx.metadata` — free-form per-request map for cross-mw communication
 *
 * Mutation rules:
 * - Pre-`next()`: `prompt` and `options` mutations are honored.
 * - Post-`next()`: only `metadata` and `error` are read by the runtime.
 *
 * Errors:
 * - Throwing from a middleware aborts the chain and the underlying query.
 *   Downstream cleanup runs in reverse via try/finally as in koa-compose.
 */

import type { AgentOptions } from '../types.js'

export interface MiddlewareContext {
  /** The user prompt for this query. Mutable before `next()` is called. */
  prompt: string
  /**
   * Per-call AgentOptions overrides (merged on top of the Agent instance
   * config). Mutable before `next()` is called.
   */
  options: Partial<AgentOptions>
  /** Wall-clock ms when the runtime started the chain. */
  readonly startedAt: number
  /** Wall-clock ms when the runtime finished the chain. Set after `next()`. */
  finishedAt?: number
  /** Set by the runtime if the underlying query (or downstream mw) threw. */
  error?: unknown
  /** Free-form bag for cross-middleware communication. */
  metadata: Record<string, unknown>
}

/**
 * Koa-style middleware. Call `next()` to invoke the rest of the chain (and
 * ultimately the engine). Skipping `next()` short-circuits the engine call.
 */
export type Middleware = (
  ctx: MiddlewareContext,
  next: () => Promise<void>,
) => Promise<void> | void
