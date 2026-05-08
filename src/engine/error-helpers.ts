/**
 * Provider/runtime error classification helpers used by the QueryEngine
 * agentic loop to decide retry vs fallback vs abort.
 */

import { isRetryableError } from '../utils/retry.js'

/**
 * Returns true when the engine should switch to the configured fallback
 * model after a primary-model failure.
 *
 * Status 404 means "primary model/endpoint not found" — always fall back to
 * the configured alternate, regardless of whether the provider has already
 * normalized this into category 'unsupported'. The original guard checked
 * `if (err?.category) return isRetryableError(err)` first, which short-
 * circuited away from the 404 branch once providers started attaching
 * categories. Other non-retryable categories (authentication / authorization
 * / invalid_request / unsupported without 404) are still NOT eligible for
 * fallback — those are configuration errors that auto-fallback would mask.
 */
export function shouldUseFallbackModel(err: any): boolean {
  if (err?.status === 404) return true
  return isRetryableError(err)
}

export function isAbortError(err: any): boolean {
  return err?.name === 'AbortError'
}
