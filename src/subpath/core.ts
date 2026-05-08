/**
 * Subpath barrel: `clavue-agent-sdk/core`
 *
 * Narrow entry point for callers that only need the high-level Agent API
 * + core engine wiring without pulling in the full kitchen-sink barrel.
 *
 * No source code lives here — each export is re-exported from its
 * canonical module so behavior stays identical to the root barrel.
 */

export { Agent, createAgent, query, run } from '../agent.js'
export { QueryEngine } from '../engine.js'
export { connectMCPServer, closeAllConnections } from '../mcp/client.js'
export type { MCPConnection } from '../mcp/client.js'

// Provider abstraction
export {
  AnthropicProvider,
  OpenAIProvider,
  createProvider,
  decideModelCapability,
  getModelCapabilities,
  normalizeModelId,
} from '../providers/index.js'
export type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  StreamCallbacks,
  NormalizedMessageParam,
  NormalizedTool,
  ApiType,
  ModelCapabilities,
  ModelCapabilityDecision,
  ProviderError,
  ProviderErrorCategory,
} from '../providers/types.js'

// Token + compaction primitives
export {
  estimateMessagesTokens,
  estimateCost,
  getAutoCompactThreshold,
  AUTOCOMPACT_BUFFER_FRACTION,
} from '../utils/tokens.js'
export {
  shouldAutoCompact,
  compactConversation,
  microCompactMessages,
  createAutoCompactState,
} from '../utils/compact.js'
export type { AutoCompactState } from '../utils/compact.js'

// Retry primitives
export { withRetry, isRetryableError, isPromptTooLongError } from '../utils/retry.js'
