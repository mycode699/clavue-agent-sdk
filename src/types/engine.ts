/**
 * QueryEngineConfig — the wiring shape consumed by `QueryEngine`.
 */

import type { AgentDefinition } from './agent.js'
import type { Evidence, QualityGateResult, QualityGatePolicy } from './evidence.js'
import type { MemoryConfig } from './memory.js'
import type { OutputSchema } from './content.js'
import type { ThinkingConfig } from './agent.js'
import type { SandboxSettings } from './sandbox.js'
import type { ToolDefinition, ToolPolicy } from './tools.js'
import type { AgentAutonomyMode } from './runtime.js'

export interface QueryEngineConfig {
  cwd: string
  model: string
  /**
   * Optional fallback model(s) tried in order after the primary model
   * fails with a retryable error. Single string = one attempt; array =
   * multi-provider chain (Tier A #3).
   */
  fallbackModel?: string | string[]
  /** LLM provider instance (created from apiType) */
  provider: import('../providers/types.js').LLMProvider
  tools: ToolDefinition[]
  systemPrompt?: string
  appendSystemPrompt?: string
  /** Initial prompt for memory retrieval */
  initialPrompt?: string
  maxTurns: number
  maxToolConcurrency?: number
  /**
   * Tier A #2 opt-in. See `AgentOptions.adaptiveToolConcurrency`. The
   * engine instantiates an AIMD controller when this is set; otherwise it
   * uses a static no-op pass-through.
   */
  adaptiveToolConcurrency?: boolean | { min?: number; max?: number; initial?: number }
  maxBudgetUsd?: number
  maxTokens: number
  thinking?: ThinkingConfig
  /** @deprecated Use `outputSchema` instead. */
  jsonSchema?: Record<string, unknown>
  /** Structured output constraint forwarded to the provider. */
  outputSchema?: OutputSchema
  policy: ToolPolicy
  autonomyMode?: AgentAutonomyMode
  includePartialMessages: boolean
  abortSignal?: AbortSignal
  agents?: Record<string, AgentDefinition>
  /** Hook registry for lifecycle events */
  hookRegistry?: import('../hooks.js').HookRegistry
  /** Session ID for hook context */
  sessionId?: string
  /** Namespace for process-local tool state */
  runtimeNamespace?: string
  /** Structured memory configuration */
  memory?: MemoryConfig
  /** Evidence already known when this engine run starts. */
  evidence?: Evidence[]
  /** Quality gates already known when this engine run starts. */
  quality_gates?: QualityGateResult[]
  /** Policy for turning quality gate results into terminal run failure. */
  qualityGatePolicy?: QualityGatePolicy
  /**
   * Optional v3.4 guardrail registry. When provided, the engine evaluates
   * every tool dispatch against `tool_input` (pre-call) and `tool_output`
   * (post-call) scopes. A blocking violation short-circuits the call and
   * returns an `is_error: true` ToolResult containing the violation
   * messages — the model loop sees a denied tool and may replan (RFC D2
   * default = `'skip'`). `'abort'` / `'continue'` policy callbacks are
   * follow-ups (see docs/v3_rfc.md).
   */
  guardrails?: import('../guardrails/runtime.js').GuardrailRegistry
  /**
   * RFC D2 follow-up — policy callback for tool-scope guardrail
   * violations. See `AgentOptions.onToolViolation`.
   */
  onToolViolation?: import('../guardrails/types.js').OnToolViolationFn
  /**
   * Optional v3.3 trace store. When provided alongside `guardrails`, every
   * tool-scope evaluation is appended as a `guardrail` event with
   * `tool.name` set, mirroring the graph runtime integration.
   */
  trace?: import('../tracing/runtime.js').TraceStore
  /**
   * M3 sandbox — when `enabled`, the engine forwards this to every tool
   * context so shell-executing tools (BashTool first) can wrap spawns
   * with `sandbox-exec` (macOS) / `bwrap` (Linux). Unsupported platforms
   * fall through to unsandboxed execution with a notice.
   */
  sandbox?: SandboxSettings
}
