/**
 * Tool-results helpers — Slice K4. After executeTools() returns we do two
 * things:
 *   1. Yield one `SDKToolResultMessage` per tool invocation (+ optional
 *      `SDKPendingInputMessage` for tools that requested user input).
 *   2. Append a single `user` message to the conversation that carries the
 *      same tool_result blocks in Anthropic's expected shape so the next
 *      turn's API call includes them.
 *
 * Both operations are driven by the same result array. Centralizing them
 * here means the engine generator only does `for (const ev of ...) yield ev`
 * and `messages.push(...)` — no content-type branching inline.
 */

import type { NormalizedMessageParam } from '../providers/types.js'
import type { SDKMessage, ToolResult } from '../types.js'
import { buildPendingInputMessage } from './message-helpers.js'

export type ToolResultWithMeta = ToolResult & { tool_name?: string }

/**
 * Build the ordered stream of SDK events to emit for a turn's tool results.
 * Pending-input notifications come before their owning tool_result so UIs
 * can surface the prompt before the answer lands.
 */
export function buildToolResultEvents(
  sessionId: string,
  runId: string,
  toolResults: ToolResultWithMeta[],
): SDKMessage[] {
  const events: SDKMessage[] = []
  for (const result of toolResults) {
    const pending = buildPendingInputMessage(sessionId, runId, result)
    if (pending) events.push(pending)
    events.push({
      type: 'tool_result',
      result: {
        tool_use_id: result.tool_use_id,
        tool_name: result.tool_name || '',
        output:
          typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content),
        evidence: result.evidence,
        quality_gates: result.quality_gates,
      },
    })
  }
  return events
}

/**
 * Build the Anthropic-shape `user` message that carries tool_result blocks
 * back into the conversation history so the next turn's LLM call sees them.
 *
 * Note: this intentionally returns a single message with N tool_result
 * blocks (Anthropic's required shape for tool_use responses), not N separate
 * messages.
 */
export function buildToolResultsUserMessage(
  toolResults: ToolResultWithMeta[],
): NormalizedMessageParam {
  return {
    role: 'user',
    content: toolResults.map((r) => ({
      type: 'tool_result' as const,
      tool_use_id: r.tool_use_id,
      content:
        typeof r.content === 'string'
          ? r.content
          : JSON.stringify(r.content),
      is_error: r.is_error,
    })) as any,
  }
}
