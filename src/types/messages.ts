/**
 * Conversation message envelopes and SDK streaming event types.
 */

import type { ContentBlock, ContentBlockParam } from './content.js'
import type { TokenUsage } from './token-usage.js'
import type { Evidence, QualityGateResult } from './evidence.js'
import type { PermissionMode } from './permissions.js'
import type { AgentAutonomyMode } from './runtime.js'
import type { AgentRunTrace } from './trace.js'

export type MessageRole = 'user' | 'assistant'

export interface ConversationMessage {
  role: MessageRole
  content: string | ContentBlockParam[]
}

export interface UserMessage {
  type: 'user'
  message: ConversationMessage
  uuid: string
  timestamp: string
}

export interface AssistantMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  uuid: string
  timestamp: string
  usage?: TokenUsage
  cost?: number
}

export type Message = UserMessage | AssistantMessage

// --------------------------------------------------------------------------
// SDK Message Types (streaming events)
// --------------------------------------------------------------------------

export type SDKMessage =
  | SDKAssistantMessage
  | SDKToolResultMessage
  | SDKResultMessage
  | SDKPartialMessage
  | SDKSystemMessage
  | SDKPhaseMessage
  | SDKPendingInputMessage
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKTaskNotificationMessage
  | SDKRateLimitEvent

export type SDKRunPhase =
  | 'intake'
  | 'context'
  | 'model_request'
  | 'model_response'
  | 'tool_execution'
  | 'verification'
  | 'finalize'

export interface SDKAssistantMessage {
  type: 'assistant'
  uuid?: string
  session_id?: string
  message: {
    role: 'assistant'
    content: ContentBlock[]
  }
  parent_tool_use_id?: string | null
}

export interface SDKToolResultMessage {
  type: 'tool_result'
  result: {
    tool_use_id: string
    tool_name: string
    output: string
    evidence?: Evidence[]
    quality_gates?: QualityGateResult[]
  }
}

export interface SDKResultMessage {
  type: 'result'
  schema_version: string
  subtype: 'success' | 'error_max_turns' | 'error_during_execution' | 'error_max_budget_usd' | string
  uuid?: string
  session_id?: string
  is_error?: boolean
  num_turns?: number
  result?: string
  stop_reason?: string | null
  total_cost_usd?: number
  duration_ms?: number
  duration_api_ms?: number
  usage?: TokenUsage
  model_usage?: Record<string, { input_tokens: number; output_tokens: number }>
  permission_denials?: Array<{ tool: string; reason: string }>
  structured_output?: unknown
  /** Evidence captured during the run for auditability. */
  evidence?: Evidence[]
  /** Quality gate results captured during the run. */
  quality_gates?: QualityGateResult[]
  /** Structured execution trace for observability and performance analysis. */
  trace?: AgentRunTrace
  errors?: string[]
  /** @deprecated Use total_cost_usd */
  cost?: number
}

export interface SDKPartialMessage {
  type: 'partial_message'
  partial: {
    type: 'text' | 'tool_use'
    text?: string
    name?: string
    input?: string
  }
}

/** Emitted once at session start with initialization info. */
export interface SDKSystemMessage {
  type: 'system'
  subtype: 'init'
  uuid?: string
  session_id: string
  tools: string[]
  model: string
  cwd: string
  mcp_servers: Array<{ name: string; status: string }>
  permission_mode: PermissionMode
  autonomy_mode?: AgentAutonomyMode
}

export type PendingInputDefaultBehavior = 'continue_without_answer' | 'decline' | 'timeout'

export interface PendingInputAnswer {
  value: string | string[]
}

export interface PendingInputQuestion {
  id: string
  prompt: string
  options?: string[]
  allow_multiselect: boolean
  default_behavior: PendingInputDefaultBehavior
  timeout_ms?: number
}

export interface SDKPhaseMessage {
  type: 'system'
  subtype: 'phase'
  phase: SDKRunPhase
  run_id: string
  session_id: string
  turn?: number
  tool_use_id?: string
}

export interface SDKPendingInputMessage {
  type: 'system'
  subtype: 'pending_input'
  run_id: string
  session_id: string
  tool_use_id: string
  question: PendingInputQuestion
}

/** Marks a compaction boundary in the conversation. */
export interface SDKCompactBoundaryMessage {
  type: 'system'
  subtype: 'compact_boundary'
  summary?: string
}

/** Status update during long operations. */
export interface SDKStatusMessage {
  type: 'system'
  subtype: 'status'
  message: string
}

/** Task lifecycle notification. */
export interface SDKTaskNotificationMessage {
  type: 'system'
  subtype: 'task_notification'
  task_id: string
  status: string
  message?: string
}

/** Rate limit event. */
export interface SDKRateLimitEvent {
  type: 'system'
  subtype: 'rate_limit'
  retry_after_ms?: number
  message: string
}
