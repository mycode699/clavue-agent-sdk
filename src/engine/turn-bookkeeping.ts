/**
 * Per-turn helpers for usage / cost / trace bookkeeping and prompt-too-long
 * recovery. Slice K3: pure side-effects on the supplied state objects so the
 * engine generator stays focused on the control flow itself.
 */

import type {
  CreateMessageResponse,
  LLMProvider,
  NormalizedMessageParam,
} from '../providers/types.js'
import type { AgentRunTrace, TokenUsage } from '../types.js'
import {
  compactConversation,
  type AutoCompactState,
} from '../utils/compact.js'
import { estimateCost } from '../utils/tokens.js'

export interface CompactRecoveryInput {
  provider: LLMProvider
  model: string
  messages: NormalizedMessageParam[]
  state: AutoCompactState
  abortSignal?: AbortSignal
  trace: AgentRunTrace
}

export interface CompactRecoveryResult {
  /** True iff compaction succeeded and the caller should retry the turn. */
  recovered: boolean
  messages: NormalizedMessageParam[]
  state: AutoCompactState
}

/**
 * Recover from `prompt is too long` by triggering a compaction with the
 * `prompt_too_long` trigger. If compaction fails (or the conversation has
 * already been compacted once), returns `recovered: false` so the caller
 * surfaces the original error.
 *
 * Note: the caller is responsible for refunding the turn counter when
 * recovery succeeds — this helper does not touch turn state because it is
 * orthogonal to compaction itself.
 */
export async function tryCompactOnPromptTooLong(
  input: CompactRecoveryInput,
): Promise<CompactRecoveryResult> {
  if (input.state.compacted) {
    return { recovered: false, messages: input.messages, state: input.state }
  }
  try {
    const result = await compactConversation(
      input.provider,
      input.model,
      input.messages as any[],
      input.state,
      input.abortSignal,
      { trigger: 'prompt_too_long' },
    )
    input.trace.compaction_count += 1
    input.trace.compactions?.push(result.trace)
    return {
      recovered: true,
      messages: result.compactedMessages as NormalizedMessageParam[],
      state: result.state,
    }
  } catch {
    // Can't compact (e.g. summarizer also OOM'd) — caller surfaces original error.
    return { recovered: false, messages: input.messages, state: input.state }
  }
}

export interface TurnUsageInput {
  response: CreateMessageResponse
  successfulModel: string
  turnApiTimeMs: number
  trace: AgentRunTrace
  totalUsage: TokenUsage
  totalCost: number
  modelUsage: Record<string, { input_tokens: number; output_tokens: number }>
  turnCount: number
}

export interface TurnUsageResult {
  /** Updated total cost (caller assigns this back). */
  totalCost: number
}

/**
 * Record turn-level metrics: append a turn entry to the trace, fold per-turn
 * usage into the running totals (including cache tokens), and update per-model
 * usage + cost. Mutates `trace`, `totalUsage`, and `modelUsage` in place;
 * returns the new total cost so the caller can keep its scalar state.
 */
export function recordTurnUsage(input: TurnUsageInput): TurnUsageResult {
  const { response, successfulModel, turnApiTimeMs, trace, totalUsage, modelUsage, turnCount } = input

  const inputTokens = response.usage?.input_tokens ?? 0
  const outputTokens = response.usage?.output_tokens ?? 0
  trace.turns.push({
    turn: turnCount,
    duration_api_ms: Math.round(turnApiTimeMs),
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    tool_calls: response.content.filter((block) => block.type === 'tool_use').length,
  })

  let totalCost = input.totalCost
  if (response.usage) {
    totalUsage.input_tokens += response.usage.input_tokens
    totalUsage.output_tokens += response.usage.output_tokens
    if (response.usage.cache_creation_input_tokens) {
      totalUsage.cache_creation_input_tokens =
        (totalUsage.cache_creation_input_tokens || 0) +
        response.usage.cache_creation_input_tokens
    }
    if (response.usage.cache_read_input_tokens) {
      totalUsage.cache_read_input_tokens =
        (totalUsage.cache_read_input_tokens || 0) +
        response.usage.cache_read_input_tokens
    }
    const current = modelUsage[successfulModel] ?? { input_tokens: 0, output_tokens: 0 }
    current.input_tokens += response.usage.input_tokens
    current.output_tokens += response.usage.output_tokens
    modelUsage[successfulModel] = current
    totalCost += estimateCost(successfulModel, response.usage)
  }

  return { totalCost }
}
