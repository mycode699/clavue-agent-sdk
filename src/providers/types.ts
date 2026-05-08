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
  | 'network'
  | 'unsupported'
  | 'unsupported_capability'
  | 'content_filter'
  | 'context_overflow'
  | 'tool_protocol_error'
  | 'provider_conversion_error'
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
  model?: string
  capability?: ModelCapabilityName
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
// Structured Output Schema
// --------------------------------------------------------------------------

/**
 * Structured output constraint passed through to the provider. Each provider
 * translates this into its native shape:
 *
 *   - Anthropic: synthesizes a single tool whose `input_schema` is `schema`,
 *     and forces `tool_choice: { type: 'tool', name }`. The model's JSON
 *     output appears as that tool's input.
 *   - OpenAI: maps to `response_format: { type: 'json_schema', json_schema:
 *     { name, schema, strict } }` on the Chat Completions / Responses APIs.
 */
export interface OutputSchema {
  /** Schema name. Used as the synthesized tool name (Anthropic) or
   *  `response_format.json_schema.name` (OpenAI). Defaults to `_output`. */
  name?: string
  /** A JSON Schema object describing the expected structured output. */
  schema: Record<string, unknown>
  /** OpenAI-only hint: pass `strict: true` for guaranteed-conforming output.
   *  Anthropic ignores this field. Default: true on OpenAI. */
  strict?: boolean
  /** Optional human-readable description forwarded to the provider. */
  description?: string
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
  /** Optional structured output constraint. Providers translate this to
   *  their native equivalent (tool_choice on Anthropic, response_format on
   *  OpenAI). When set, the model is required to produce JSON conforming to
   *  `schema`. */
  outputSchema?: OutputSchema
  /** Optional streaming callbacks. When set on a provider that supports
   *  streaming, the provider will use its native streaming API and emit
   *  partial deltas as they arrive. The final aggregated response is still
   *  returned from createMessage(). When undefined, providers fall back to
   *  the non-streaming endpoint. */
  stream?: StreamCallbacks
}

/** Provider-emitted streaming events. Phase 1 surface focuses on text deltas
 *  (covers ~80% of perceived TTFT improvement). Tool-use deltas and a
 *  generic `event` channel are reserved for phase 2. */
export interface StreamCallbacks {
  /** Called for each incremental text fragment as it arrives. Implementations
   *  must not throw — exceptions are swallowed by the provider. */
  onText?: (delta: string) => void
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
