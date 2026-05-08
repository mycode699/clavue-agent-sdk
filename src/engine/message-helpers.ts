/**
 * Pure SDK message shape constructors. Extracted from `QueryEngine` to
 * keep the class focused on orchestration, not on assembling static
 * event payloads.
 */

import type {
  SDKPendingInputMessage,
  SDKPhaseMessage,
  SDKRunPhase,
  ToolResult,
} from '../types.js'

export function buildPhaseMessage(
  sessionId: string,
  runId: string,
  phase: SDKRunPhase,
  turn?: number,
  toolUseId?: string,
): SDKPhaseMessage {
  return {
    type: 'system',
    subtype: 'phase',
    phase,
    run_id: runId,
    session_id: sessionId,
    ...(turn === undefined ? {} : { turn }),
    ...(toolUseId === undefined ? {} : { tool_use_id: toolUseId }),
  }
}

export function buildPendingInputMessage(
  sessionId: string,
  runId: string,
  result: ToolResult & { tool_name?: string },
): SDKPendingInputMessage | undefined {
  if (!result.pending_input) return undefined
  return {
    type: 'system',
    subtype: 'pending_input',
    run_id: runId,
    session_id: sessionId,
    tool_use_id: result.tool_use_id,
    question: result.pending_input,
  }
}
