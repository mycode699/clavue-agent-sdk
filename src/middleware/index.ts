/**
 * Public middleware barrel — exposes the koa-style `agent.use()` runtime.
 *
 * Stable surface (added in v0.10.0):
 *   - `Middleware` / `MiddlewareContext` types
 *   - `composeMiddleware` runtime helper
 *   - `createMiddlewareContext` for tests / advanced hosts
 */

export type { Middleware, MiddlewareContext } from './types.js'
export { composeMiddleware, createMiddlewareContext } from './runtime.js'
export type { CoreRunner } from './runtime.js'
