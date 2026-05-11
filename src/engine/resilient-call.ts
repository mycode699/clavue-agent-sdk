/**
 * ResilientCall — retry+fallback wrapper for the per-turn model call.
 *
 * Slice K2 / P1-4: previously the engine had three overlapping recovery
 * paths (`withRetry` for primary, manual fallback dispatch, prompt-too-long
 * compact-and-retry). Two of them lived inline inside `submitMessage`. This
 * helper consolidates the retry + fallback story; prompt-too-long stays in
 * the engine because it requires turn-counter rewinding (different control
 * flow).
 *
 * Contract:
 * - `primary(model)` is invoked first via `withRetry` (exponential backoff,
 *   shared with the rest of the SDK).
 * - If it throws and a fallback chain is configured, we evaluate three
 *   guards before attempting each fallback step:
 *     1. `AbortError` / aborted signal — never fallback, always rethrow.
 *     2. `isPromptTooLongError` — bubble up so the engine can trigger
 *        compaction-and-retry. Fallback wouldn't help an oversize prompt.
 *     3. `shouldUseFallbackModel` — checks normalized provider error
 *        categories (404 unsupported, transient 5xx, etc.).
 * - Tier A #3: when `fallbackModel` is an array, the chain is tried in
 *   order; each step is a single attempt (no nested retry) and the first
 *   that returns wins. If every step fails, the *last* error is thrown
 *   (matching legacy single-fallback behaviour).
 *
 * Returns the model used + response so the engine can record per-model
 * usage / cost without the caller threading state.
 */

import type { CreateMessageResponse } from '../providers/types.js'
import { abortError } from '../utils/abort.js'
import {
  isPromptTooLongError,
  withRetry,
  type RetryConfig,
} from '../utils/retry.js'
import { isAbortError, shouldUseFallbackModel } from './error-helpers.js'

export interface ResilientCallInput {
  primaryModel: string
  /** Single fallback (legacy) or ordered chain of fallback models. */
  fallbackModel?: string | string[]
  abortSignal?: AbortSignal
  /** Issues the model call. Returns the raw provider response. */
  call: (model: string) => Promise<CreateMessageResponse>
  /** Override the retry policy (test seam). */
  retryConfig?: RetryConfig
  /** Called once per attempt (incl. fallback). Lets engine count attempts. */
  onAttempt?: () => void
}

export interface ResilientCallResult {
  response: CreateMessageResponse
  /** Which model produced the response (primary or one of the fallbacks). */
  model: string
}

function normalizeFallbackChain(input: string | string[] | undefined): string[] {
  if (!input) return []
  if (Array.isArray(input)) return input.filter((m) => typeof m === 'string' && m.length > 0)
  return [input]
}

export async function runResilientCall(input: ResilientCallInput): Promise<ResilientCallResult> {
  const { primaryModel, abortSignal, call, retryConfig, onAttempt } = input
  const chain = normalizeFallbackChain(input.fallbackModel)

  try {
    const response = await withRetry(
      async () => {
        onAttempt?.()
        return call(primaryModel)
      },
      retryConfig,
      abortSignal,
    )
    return { response, model: primaryModel }
  } catch (primaryErr: any) {
    if (chain.length === 0) throw primaryErr
    if (isAbortError(primaryErr) || abortSignal?.aborted) throw primaryErr
    if (isPromptTooLongError(primaryErr)) throw primaryErr
    if (!shouldUseFallbackModel(primaryErr)) throw primaryErr

    let lastErr: any = primaryErr
    for (const fallbackModel of chain) {
      if (abortSignal?.aborted) throw abortError()
      try {
        onAttempt?.()
        const response = await call(fallbackModel)
        return { response, model: fallbackModel }
      } catch (err: any) {
        // Abort short-circuits the whole chain.
        if (isAbortError(err) || abortSignal?.aborted) throw err
        // Configuration-class errors (auth, prompt-too-long) make further
        // fallbacks pointless — surface immediately rather than burning
        // through the rest of the chain on the same root cause.
        if (isPromptTooLongError(err)) throw err
        if (!shouldUseFallbackModel(err)) throw err
        lastErr = err
      }
    }
    throw lastErr
  }
}
