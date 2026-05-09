/**
 * ResilientCall — single retry+fallback wrapper for the per-turn model call.
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
 * - If it throws and a `fallbackModel` is configured, we evaluate three
 *   guards before falling back:
 *     1. `AbortError` / aborted signal — never fallback, always rethrow.
 *     2. `isPromptTooLongError` — bubble up so the engine can trigger
 *        compaction-and-retry. Fallback wouldn't help an oversize prompt.
 *     3. `shouldUseFallbackModel` — checks normalized provider error
 *        categories (404 unsupported, transient 5xx, etc.).
 * - Fallback call is a single attempt (no nested retry) — matches legacy
 *   behavior. Future Slice can wrap fallback in retry too.
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
  fallbackModel?: string
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
  /** Which model produced the response (primary or fallback). */
  model: string
}

export async function runResilientCall(input: ResilientCallInput): Promise<ResilientCallResult> {
  const { primaryModel, fallbackModel, abortSignal, call, retryConfig, onAttempt } = input

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
    // Order of guards matters: abort > oversize > category-check.
    if (!fallbackModel || isAbortError(primaryErr) || abortSignal?.aborted) {
      throw primaryErr
    }
    if (isPromptTooLongError(primaryErr)) {
      // Engine handles this with compaction-and-retry; fallback wouldn't help.
      throw primaryErr
    }
    if (!shouldUseFallbackModel(primaryErr)) {
      throw primaryErr
    }
    if (abortSignal?.aborted) throw abortError()

    onAttempt?.()
    const response = await call(fallbackModel)
    return { response, model: fallbackModel }
  }
}
