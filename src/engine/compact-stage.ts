/**
 * Compact stage helper — runs `auto_threshold` autocompact when the running
 * conversation exceeds the model's threshold, then applies micro-compaction
 * to the API-bound view. Pure side-effects on the supplied state object.
 *
 * Slice K1: extracted from `QueryEngine.submitMessage` so the agentic loop
 * body shrinks without changing behavior. The compact-on-prompt-too-long
 * recovery path stays inline (it has different control flow + must refund
 * a turn). This helper only handles the proactive pre-turn compaction.
 */

import type { LLMProvider, NormalizedMessageParam } from '../providers/types.js'
import type { AgentRunTrace } from '../types.js'
import {
  compactConversation,
  microCompactMessages,
  shouldAutoCompact,
  type AutoCompactState,
} from '../utils/compact.js'
import { normalizeMessagesForAPI } from '../utils/messages.js'

export interface AutoCompactRunInput {
  provider: LLMProvider
  model: string
  messages: NormalizedMessageParam[]
  state: AutoCompactState
  abortSignal?: AbortSignal
  trace: AgentRunTrace
  /** Hooks to fire around the compaction. Receives no payload; returns are ignored. */
  onPreCompact?: () => Promise<void>
  onPostCompact?: () => Promise<void>
}

export interface AutoCompactRunResult {
  messages: NormalizedMessageParam[]
  state: AutoCompactState
  ran: boolean
}

/**
 * Trigger threshold-based auto-compaction if needed. On success: replaces
 * `messages` and `state`, increments trace counters, and emits Pre/PostCompact
 * hooks. On failure: keeps messages unchanged and swallows the error (caller
 * keeps running with the un-compacted history — same legacy behavior).
 */
export async function maybeAutoCompactBeforeTurn(
  input: AutoCompactRunInput,
): Promise<AutoCompactRunResult> {
  if (!shouldAutoCompact(input.messages as any[], input.model, input.state)) {
    return { messages: input.messages, state: input.state, ran: false }
  }

  if (input.onPreCompact) {
    await input.onPreCompact()
  }

  try {
    const result = await compactConversation(
      input.provider,
      input.model,
      input.messages as any[],
      input.state,
      input.abortSignal,
      { trigger: 'auto_threshold' },
    )
    input.trace.compaction_count += 1
    input.trace.compactions?.push(result.trace)

    if (input.onPostCompact) {
      await input.onPostCompact()
    }

    return {
      messages: result.compactedMessages as NormalizedMessageParam[],
      state: result.state,
      ran: true,
    }
  } catch {
    // Legacy contract: a failed compaction is non-fatal — the loop just
    // continues with whatever messages were available. Keep this behavior.
    return { messages: input.messages, state: input.state, ran: false }
  }
}

/**
 * Apply micro-compaction (large tool-result truncation) to the API-bound
 * view of the messages. Does not mutate the engine's canonical message log.
 */
export function applyMicroCompactForApi(
  messages: NormalizedMessageParam[],
): NormalizedMessageParam[] {
  return microCompactMessages(normalizeMessagesForAPI(messages as any[])) as NormalizedMessageParam[]
}
