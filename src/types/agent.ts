/**
 * Agent configuration, run result, subagent definition, thinking config,
 * and query result types.
 */

import type { CanUseToolFn } from './tools.js'
import type { ToolDefinition } from './tools.js'
import type { Evidence, QualityGateResult, QualityGatePolicy } from './evidence.js'
import type { Message, SDKMessage } from './messages.js'
import type { MemoryConfig, SessionConfig } from './memory.js'
import type { McpServerConfig } from './mcp.js'
import type { OutputFormat, OutputSchema } from './content.js'
import type { PermissionMode } from './permissions.js'
import type { AgentAutonomyMode, AgentSelfImprovementResult, SelfImprovementConfig, SettingSource, ToolsetName, WorkflowMode } from './runtime.js'
import type { SandboxSettings } from './sandbox.js'
import type { TokenUsage } from './token-usage.js'
import type { AgentRunTrace } from './trace.js'

export interface AgentDefinition {
  description: string
  prompt: string
  tools?: string[]
  disallowedTools?: string[]
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit' | string
  mcpServers?: Array<string | { name: string; tools?: string[] }>
  skills?: string[]
  maxTurns?: number
  criticalSystemReminder_EXPERIMENTAL?: string
}

export interface ThinkingConfig {
  type: 'adaptive' | 'enabled' | 'disabled'
  budgetTokens?: number
}

/**
 * Named shorthand for common `AgentOptions` combinations.
 *
 * - `'autonomous'`: trusted automation + auto-inject memory, high maxTurns.
 * - `'interactive'`: `plan` permission mode + supervised autonomy, lower maxTurns.
 * - `'sandboxed'`: `bypassPermissions` denied; read-only tools, memory off.
 * - `'minimal'`: zero memory / zero skills / zero hooks — bare engine shell.
 *
 * Expanded by `createAgent()` before any other field merges. Explicit fields
 * on the same call always win over preset defaults.
 */
export type AgentPreset = 'autonomous' | 'interactive' | 'sandboxed' | 'minimal'

export interface AgentOptions {
  /**
   * Named preset expanded into safe defaults for permission mode, autonomy,
   * memory, and turn budget. Explicit fields passed alongside always win.
   * See {@link AgentPreset} for semantics of each preset.
   */
  profile?: AgentPreset
  /** Named runtime workflow profile that expands into safe defaults for tools, permissions, memory, and gates. */
  workflowMode?: WorkflowMode
  /** LLM model ID */
  model?: string
  /**
   * API type: 'anthropic-messages' or 'openai-completions'.
   * Falls back to CLAVUE_AGENT_API_TYPE, then deterministic model capability inference.
   */
  apiType?: import('../providers/types.js').ApiType
  /** API key. Falls back to CLAVUE_AGENT_API_KEY env var. */
  apiKey?: string
  /** API base URL override */
  baseURL?: string
  /** Working directory for file/shell tools */
  cwd?: string
  /** System prompt override or preset */
  systemPrompt?: string | { type: 'preset'; preset: 'default'; append?: string }
  /** Append to default system prompt */
  appendSystemPrompt?: string
  /** Available tools (ToolDefinition[] or string[] preset) */
  tools?: ToolDefinition[] | string[] | { type: 'preset'; preset: 'default' }
  /** Maximum number of agentic turns per query */
  maxTurns?: number
  /** Maximum concurrent read-only concurrency-safe tool calls per query */
  maxToolConcurrency?: number
  /** Maximum USD budget per query */
  maxBudgetUsd?: number
  /** Extended thinking configuration */
  thinking?: ThinkingConfig
  /** Maximum thinking tokens (deprecated, use thinking.budgetTokens) */
  maxThinkingTokens?: number
  /**
   * Structured output JSON schema.
   * @deprecated Use `outputSchema` instead. When both are set, `outputSchema`
   * wins. `jsonSchema` is forwarded as `{ schema: jsonSchema }` for
   * backward compatibility.
   */
  jsonSchema?: Record<string, unknown>
  /** Structured output constraint forwarded to the provider. Translated into
   *  `tool_choice` (Anthropic) or `response_format` / `text.format` (OpenAI). */
  outputSchema?: OutputSchema
  /** Structured output format */
  outputFormat?: OutputFormat
  /** Permission handler callback */
  canUseTool?: CanUseToolFn
  /** Permission mode reported in metadata and prompts. Defaults to trustedAutomation. Tool policy is enforced by canUseTool, allowedTools, and disallowedTools. */
  permissionMode?: PermissionMode
  /** Controls how proactively the agent proceeds before asking the user. Does not bypass tool permissions. */
  autonomyMode?: AgentAutonomyMode
  /** Abort controller for cancellation */
  abortController?: AbortController
  /** Abort signal for cancellation */
  abortSignal?: AbortSignal
  /** Whether to include partial streaming events */
  includePartialMessages?: boolean
  /** Environment variables */
  env?: Record<string, string | undefined>
  /** Structured memory configuration */
  memory?: MemoryConfig
  /** Session persistence configuration */
  session?: SessionConfig
  /** Optional namespace for process-local tool registries and coordination state. */
  runtimeNamespace?: string
  /** Evidence already known when a run starts. */
  evidence?: Evidence[]
  /** Quality gates already known when a run starts. */
  quality_gates?: QualityGateResult[]
  /** Policy for turning quality gate results into terminal run failure. */
  qualityGatePolicy?: QualityGatePolicy
  /**
   * Optional v3.4 guardrail registry. When set, every tool call is
   * evaluated for `tool_input` (pre-call) and `tool_output` (post-call)
   * scopes. Blocking violations short-circuit the call and return an
   * `is_error: true` ToolResult so the model can replan.
   */
  guardrails?: import('../guardrails/runtime.js').GuardrailRegistry
  /**
   * RFC D2 follow-up — policy hook for tool-scope violations. Returning
   * `'skip'` (default if omitted) injects a denied ToolResult; `'abort'`
   * terminates the run with `error_guardrail_abort`; `'continue'` lets the
   * call/result proceed unchanged (audit-only). Throwing → `'abort'`.
   */
  onToolViolation?: import('../guardrails/types.js').OnToolViolationFn
  /**
   * Optional v3.3 trace store. When provided alongside `guardrails`, every
   * tool-scope guardrail evaluation is appended as a `guardrail` event.
   * Caller owns `startRun()` / `endRun()`.
   */
  trace?: import('../tracing/runtime.js').TraceStore
  /** Automated run learning and retro/eval feedback loop. */
  selfImprovement?: boolean | SelfImprovementConfig
  /** Named built-in capability profiles that expand into allowed tool names */
  toolsets?: ToolsetName[]
  /** Tool names to pre-approve without prompting */
  allowedTools?: string[]
  /** Tool names to deny */
  disallowedTools?: string[]
  /** MCP server configurations */
  mcpServers?: Record<string, McpServerConfig | any> // supports McpSdkServerConfig
  /** Custom subagent definitions */
  agents?: Record<string, AgentDefinition>
  /** Maximum tokens for responses */
  maxTokens?: number
  /** Effort level for reasoning */
  effort?: 'low' | 'medium' | 'high' | 'max'
  /** Fallback model for retryable provider errors after primary model failure. */
  fallbackModel?: string
  /** Continue the most recent session in cwd */
  continue?: boolean
  /** Resume a specific session by ID */
  resume?: string
  /** Fork a session instead of continuing it */
  forkSession?: boolean
  /** Persist session to disk */
  persistSession?: boolean
  /** Explicit session ID */
  sessionId?: string
  /** Enable file checkpointing (for rewindFiles) */
  enableFileCheckpointing?: boolean
  /** Sandbox configuration */
  sandbox?: SandboxSettings
  /** Load settings from filesystem */
  settingSources?: SettingSource[]
  /** Plugin configurations */
  plugins?: Array<{ name: string; config?: Record<string, unknown> }>
  /** Additional working directories */
  additionalDirectories?: string[]
  /** Default agent to use */
  agent?: string
  /** Debug mode */
  debug?: boolean
  /** Debug log file */
  debugFile?: string
  /** Tool-specific configuration */
  toolConfig?: Record<string, unknown>
  /** Enable prompt suggestions */
  promptSuggestions?: boolean
  /** Strict MCP config validation */
  strictMcpConfig?: boolean
  /** Extra CLI arguments */
  extraArgs?: Record<string, string | null>
  /** SDK betas to enable */
  betas?: string[]
  /** Permission prompt tool name override */
  permissionPromptToolName?: string
  /** Hook configurations */
  hooks?: Record<string, Array<{
    matcher?: string
    hooks: Array<(input: any, toolUseId: string, context: { signal: AbortSignal }) => Promise<any>>
    timeout?: number
  }>>
}

export type AgentRunStatus = 'completed' | 'errored'

export interface AgentRunResult {
  schema_version: string
  /** Unique ID for this run artifact */
  id: string
  /** Session ID the run belongs to */
  session_id: string
  /** High-level terminal status */
  status: AgentRunStatus
  /** Final result subtype from the engine */
  subtype: string
  /** Final text output from the assistant */
  text: string
  /** Token usage */
  usage: TokenUsage
  /** Number of agentic turns */
  num_turns: number
  /** Wall-clock duration in milliseconds */
  duration_ms: number
  /** Aggregate provider API time in milliseconds */
  duration_api_ms: number
  /** Total estimated cost in USD */
  total_cost_usd: number
  /** Provider stop reason when available */
  stop_reason: string | null
  /** ISO timestamp when the run started */
  started_at: string
  /** ISO timestamp when the run completed */
  completed_at: string
  /** All conversation messages captured for this run */
  messages: Message[]
  /** Streaming events emitted during the run */
  events: SDKMessage[]
  /** Engine errors when available */
  errors?: string[]
  /** Evidence captured during the run for auditability. */
  evidence?: Evidence[]
  /** Quality gate results captured during the run. */
  quality_gates?: QualityGateResult[]
  /** Structured execution trace for observability and performance analysis. */
  trace?: AgentRunTrace
  /** Auto-learning artifacts captured after the run when selfImprovement is enabled. */
  self_improvement?: AgentSelfImprovementResult
}

export interface QueryResult {
  /** Final text output from the assistant */
  text: string
  /** Token usage */
  usage: TokenUsage
  /** Number of agentic turns */
  num_turns: number
  /** Duration in milliseconds */
  duration_ms: number
  /** All conversation messages */
  messages: Message[]
}
