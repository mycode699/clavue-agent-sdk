/**
 * LLM Provider Abstraction Types
 *
 * Defines a provider interface that normalizes API differences between
 * Anthropic Messages API and OpenAI Chat Completions API.
 *
 * Internally the SDK uses Anthropic-like message format as the canonical
 * representation. Providers convert to/from their native API format.
 */

// --------------------------------------------------------------------------
// API Type
// --------------------------------------------------------------------------

export type ApiType = 'anthropic-messages' | 'openai-completions'

export type ModelTransport = 'messages' | 'chat_completions' | 'responses'

export type ProviderErrorCategory =
  | 'authentication'
  | 'authorization'
  | 'rate_limit'
  | 'timeout'
  | 'aborted'
  | 'unsupported'
  | 'provider_error'
  | 'invalid_request'
  | 'unknown'

export interface ProviderError extends Error {
  provider: 'anthropic' | 'openai' | string
  category: ProviderErrorCategory
  status?: number
  headers?: Record<string, string>
  body?: string
  error?: unknown
}

export interface ModelCapabilityOptions {
  apiType?: ApiType
}

export type ModelCapabilityName =
  | 'tools'
  | 'images'
  | 'thinking'
  | 'json_schema'
  | 'streaming'

export type ModelCapabilitySupport = 'supported' | 'unsupported' | 'unknown'

export interface ModelCapabilityDecision {
  model: string
  normalizedModel: string
  apiType: ApiType
  capability: ModelCapabilityName
  supported: boolean
  support: ModelCapabilitySupport
  reason: string
}

export interface ModelCapabilities {
  model: string
  normalizedModel: string
  apiType: ApiType
  transport: ModelTransport
  known: boolean
  supportsTools: boolean
  supportsImages: boolean
  supportsThinking: boolean
  supportsJsonSchema: boolean
  supportsStreaming: boolean
  contextWindow?: number
  pricing?: {
    inputPerMillionUsd: number
    outputPerMillionUsd: number
  }
  fallback?: {
    responsesToChatCompletionsStatuses?: number[]
  }
}

// --------------------------------------------------------------------------
// Normalized Request
// --------------------------------------------------------------------------

export interface CreateMessageParams {
  model: string
  maxTokens: number
  system: string
  messages: NormalizedMessageParam[]
  tools?: NormalizedTool[]
  thinking?: { type: string; budget_tokens?: number }
  abortSignal?: AbortSignal
}

/**
 * Normalized message format (Anthropic-like).
 * This is the internal representation used throughout the SDK.
 */
export interface NormalizedMessageParam {
  role: 'user' | 'assistant'
  content: string | NormalizedContentBlock[]
}

export type NormalizedImageSource =
  | { type: 'url'; url: string; detail?: string; [key: string]: any }
  | { type: 'base64'; media_type: string; data: string; [key: string]: any }
  | { type: 'data_url'; url: string; media_type?: string; data?: string; [key: string]: any }
  | Record<string, any>

export type NormalizedContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }
  | { type: 'image'; source: NormalizedImageSource }
  | { type: 'thinking'; thinking: string }

export interface NormalizedTool {
  name: string
  description: string
  input_schema: {
    type: 'object'
    properties: Record<string, any>
    required?: string[]
  }
}

// --------------------------------------------------------------------------
// Normalized Response
// --------------------------------------------------------------------------

export interface CreateMessageResponse {
  content: NormalizedResponseBlock[]
  stopReason: 'end_turn' | 'max_tokens' | 'tool_use' | string
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens?: number
    cache_read_input_tokens?: number
  }
}

export type NormalizedResponseBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'image'; source: NormalizedImageSource }

// --------------------------------------------------------------------------
// Provider Interface
// --------------------------------------------------------------------------

export interface LLMProvider {
  /** The API type this provider implements. */
  readonly apiType: ApiType

  /** Send a message and get a response. */
  createMessage(params: CreateMessageParams): Promise<CreateMessageResponse>
}
