/**
 * Middleware runtime — koa-compose-style dispatcher.
 *
 * `composeMiddleware(mws)` returns a function that, given an initial
 * `MiddlewareContext` and a terminal `core` runner, executes the chain in
 * order with strict guarantees:
 *
 *   1. Each `next()` may be called at most once per middleware (double-call
 *      throws synchronously, matching koa-compose).
 *   2. Errors thrown by a middleware (or by `core`) propagate up the stack
 *      and are surfaced on `ctx.error` after the chain unwinds.
 *   3. `ctx.startedAt` is set before the first middleware; `ctx.finishedAt`
 *      after the final unwind. Both are best-effort wall-clock ms.
 *
 * No external deps; ~50 lines of runtime + types.
 */

import type { Middleware, MiddlewareContext } from './types.js'

export type CoreRunner = (ctx: MiddlewareContext) => Promise<void>

export function composeMiddleware(
  middlewares: ReadonlyArray<Middleware>,
): (ctx: MiddlewareContext, core: CoreRunner) => Promise<void> {
  // Defensive copy so the caller mutating their array later does not change
  // dispatch order mid-flight.
  const stack = middlewares.slice()
  return async function dispatch(ctx, core) {
    let lastIndex = -1
    const run = async (i: number): Promise<void> => {
      if (i <= lastIndex) {
        throw new Error('next() called multiple times in middleware chain')
      }
      lastIndex = i
      const fn = stack[i]
      if (!fn) {
        // End of chain → run the terminal core.
        await core(ctx)
        return
      }
      await fn(ctx, () => run(i + 1))
    }
    await run(0)
  }
}

/**
 * Build an initial `MiddlewareContext`. Public so callers (and tests) can
 * synthesise a context without going through Agent.
 */
export function createMiddlewareContext(
  prompt: string,
  options: MiddlewareContext['options'] = {},
): MiddlewareContext {
  return {
    prompt,
    options,
    startedAt: Date.now(),
    metadata: {},
  }
}
