/**
 * Core type definitions for the Agent SDK
 */

// Content block types (provider-agnostic, compatible with Anthropic format)
export type ImageSource = import('./providers/types.js').NormalizedImageSource

export type ContentBlockParam =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'tool_result'; tool_use_id: string; content: string | any[]; is_error?: boolean }

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }
  | { type: 'tool_use'; id: string; name: string; input: any }
  | { type: 'thinking'; thinking: string }

// --------------------------------------------------------------------------
// Context Pack Types
// --------------------------------------------------------------------------

export type ContextPackSectionKind = 'date' | 'git' | 'project' | 'custom'

export interface ContextPackSection {
  kind: ContextPackSectionKind
  title: string
  content: string
  source?: string
}

export interface ContextPack {
  cwd: string
  created_at: string
  sections: ContextPackSection[]
}

export interface ContextPackOptions {
  includeDate?: boolean
  includeGit?: boolean
  includeProject?: boolean
  now?: Date
}

export type ContextPipelineTransform = (pack: ContextPack) => ContextPack | Promise<ContextPack>

export interface ContextPipeline {
  use(transform: ContextPipelineTransform): ContextPipeline
  run(cwd: string, options?: ContextPackOptions): Promise<ContextPack>
}

// --------------------------------------------------------------------------
// Message Types
// --------------------------------------------------------------------------

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
  | SDKCompactBoundaryMessage
  | SDKStatusMessage
  | SDKTaskNotificationMessage
  | SDKRateLimitEvent

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

// --------------------------------------------------------------------------
// Token Usage
// --------------------------------------------------------------------------

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

// --------------------------------------------------------------------------
// Tool Types
// --------------------------------------------------------------------------

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  call: (input: any, context: ToolContext) => Promise<ToolResult>
  safety?: ToolSafetyAnnotations
  isReadOnly?: () => boolean
  isConcurrencySafe?: () => boolean
  isEnabled?: (context?: ToolContext) => boolean
  prompt?: (context: ToolContext) => Promise<string>
}

export interface ToolSafetyAnnotations {
  /** Tool only reads local or external state. Defaults to ToolDefinition.isReadOnly() when omitted. */
  read?: boolean
  /** Tool can modify local files, in-memory runtime state, or other local workspace state. */
  write?: boolean
  /** Tool can execute shell commands or arbitrary local processes. */
  shell?: boolean
  /** Tool can call remote network services. */
  network?: boolean
  /** Tool can affect systems outside the local workspace, such as messages, cron, MCP, or remote triggers. */
  externalState?: boolean
  /** Tool can delete, stop, overwrite, or otherwise perform hard-to-reverse operations. */
  destructive?: boolean
  /** Repeating the same call should normally be safe and produce the same effect. */
  idempotent?: boolean
  /** Tool should require explicit approval unless the host selects a high-trust policy. */
  approvalRequired?: boolean
}

export type EvidenceSource = 'tool' | 'skill' | 'hook' | 'agent' | 'eval' | 'external'

export interface Evidence {
  /** Stable evidence category, such as test, build, trace, review, or artifact. */
  type: string
  /** Human-readable evidence summary. */
  summary: string
  /** Component that produced the evidence. */
  source?: EvidenceSource | string
  /** Tool call, skill, hook, or run id that produced this evidence. */
  id?: string
  /** Optional file path, URL, or artifact pointer. */
  location?: string
  /** Additional structured metadata for consumers. */
  metadata?: Record<string, unknown>
}

export type QualityGateStatus = 'passed' | 'failed' | 'skipped' | 'pending'

export interface QualityGateResult {
  /** Stable gate name, such as build, tests, lint, review, or skill:<name>. */
  name: string
  status: QualityGateStatus
  summary?: string
  evidence?: Evidence[]
  metadata?: Record<string, unknown>
}

export interface QualityGatePolicy {
  /** Gate names that must be present and must not have a failing status. Omitted means evaluate all reported gates. */
  required?: string[]
  /** Gate statuses that should make terminal success fail. Defaults to failed. */
  failStatuses?: QualityGateStatus[]
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
}

export interface ToolContext {
  cwd: string
  abortSignal?: AbortSignal
  /** Isolates module-level tool state for hosts running multiple SDK instances in one process. */
  runtimeNamespace?: string
  /** Tool names available to the current runtime/tool execution turn. */
  availableTools?: string[]
  /** Parent agent's LLM provider (inherited by subagents) */
  provider?: import('./providers/types.js').LLMProvider
  /** Parent agent's model ID */
  model?: string
  /** Parent agent's API type */
  apiType?: import('./providers/types.js').ApiType
  /** Query engine policy inherited by nested agents */
  policy?: ToolPolicy
}

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string | any[]
  is_error?: boolean
  evidence?: Evidence[]
  quality_gates?: QualityGateResult[]
}

// --------------------------------------------------------------------------
// Permission Types
// --------------------------------------------------------------------------

export type PermissionMode =
  | 'trustedAutomation'
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export interface AgentRunToolTrace {
  tool_use_id: string
  tool_name: string
  duration_ms: number
  is_error: boolean
  concurrency_safe: boolean
}

export interface AgentRunTurnTrace {
  turn: number
  duration_api_ms: number
  input_tokens: number
  output_tokens: number
  tool_calls: number
}

export type AgentRunMemoryValidationState = 'validated' | 'unvalidated'
export type AgentRunMemoryInjectionStatus = 'off' | 'empty' | 'injected'

export interface AgentRunMemorySelectionTrace {
  id: string
  type: import('./memory.js').MemoryType
  scope: import('./memory.js').MemoryScope
  title: string
  score: number
  score_reasons?: string[]
  validation_state?: AgentRunMemoryValidationState
  tags?: string[]
  source?: string
  confidence?: import('./memory.js').MemoryConfidence
  last_validated_at?: string
  repo_path?: string
  session_id?: string
}

export type AgentRunMemorySelectionSource = 'targeted' | 'repo_fallback' | 'off' | 'empty'

export interface AgentRunMemoryRetrievalStep {
  source: 'targeted' | 'repo_fallback'
  query?: string
  repo_path?: string
  candidate_count: number
  selected_count: number
}

export interface AgentRunMemoryTrace {
  policy: MemoryPolicyMode
  query?: string
  repo_path?: string
  selected_ids: string[]
  selected?: AgentRunMemorySelectionTrace[]
  injected_count: number
  injection_status?: AgentRunMemoryInjectionStatus
  selection_source?: AgentRunMemorySelectionSource
  retrieval_steps?: AgentRunMemoryRetrievalStep[]
  retrieved_before_first_model_call: boolean
}

export type AgentRunToolConcurrencySource = 'option' | 'env' | 'default'

export interface AgentRunTrace {
  turns: AgentRunTurnTrace[]
  tools: AgentRunToolTrace[]
  concurrency_batches: number[]
  tool_concurrency_limit: number
  tool_concurrency_source: AgentRunToolConcurrencySource
  retry_count: number
  compaction_count: number
  permission_denials: Array<{ tool: string; reason: string }>
  memory?: AgentRunMemoryTrace[]
}

export type PermissionBehavior = 'allow' | 'deny'

export type CanUseToolResult = {
  behavior: PermissionBehavior
  updatedInput?: unknown
  message?: string
}

export type CanUseToolFn = (
  tool: ToolDefinition,
  input: unknown,
) => Promise<CanUseToolResult>

export interface ToolPolicy {
  canUseTool: CanUseToolFn
  permissionMode: PermissionMode
}

export function createDefaultToolPolicy(permissionMode: PermissionMode = 'trustedAutomation'): ToolPolicy {
  const allow = (): CanUseToolResult => ({ behavior: 'allow' })
  const deny = (tool: ToolDefinition, reason: string): CanUseToolResult => ({
    behavior: 'deny',
    message: `Permission denied for ${tool.name}: ${reason}`,
  })

  return {
    canUseTool: async (tool) => {
      switch (permissionMode) {
        case 'bypassPermissions':
        case 'trustedAutomation':
          return allow()

        case 'plan':
          return isPlanModeAllowedTool(tool)
            ? allow()
            : deny(tool, 'plan mode only allows read-only and planning tools')

        case 'acceptEdits':
          return isAcceptEditsAllowedTool(tool)
            ? allow()
            : deny(tool, 'acceptEdits mode allows local file edits but blocks shell, network, external-state, destructive, or approval-required tools')

        case 'default':
          return isDefaultModeAllowedTool(tool)
            ? allow()
            : deny(tool, 'default mode only allows read-only tools unless the host selects a broader permission mode')

        case 'dontAsk':
        case 'auto':
          return isNonDestructiveTool(tool)
            ? allow()
            : deny(tool, `${permissionMode} mode blocks destructive or approval-required tools`)

        default:
          return allow()
      }
    },
    permissionMode,
  }
}

function getToolSafety(tool: ToolDefinition): Required<Pick<ToolSafetyAnnotations, 'read' | 'write' | 'shell' | 'network' | 'externalState' | 'destructive' | 'approvalRequired'>> & ToolSafetyAnnotations {
  const safety = tool.safety ?? {}
  const read = safety.read ?? tool.isReadOnly?.() === true
  const write = safety.write ?? !read

  return {
    ...safety,
    read,
    write,
    shell: safety.shell ?? false,
    network: safety.network ?? false,
    externalState: safety.externalState ?? false,
    destructive: safety.destructive ?? false,
    approvalRequired: safety.approvalRequired ?? false,
  }
}

function isPlanModeAllowedTool(tool: ToolDefinition): boolean {
  if (tool.isReadOnly?.() === true) return true
  const safety = getToolSafety(tool)
  if (safety.read && !safety.write && !safety.shell && !safety.network && !safety.externalState && !safety.destructive) {
    return true
  }

  return new Set([
    'EnterPlanMode',
    'ExitPlanMode',
    'AskUserQuestion',
    'TodoWrite',
    'Skill',
  ]).has(tool.name)
}

function isAcceptEditsAllowedTool(tool: ToolDefinition): boolean {
  const safety = getToolSafety(tool)
  if (isLocalFileEditTool(tool)) return true
  if (safety.shell || safety.network || safety.externalState || safety.destructive || safety.approvalRequired) {
    return false
  }

  return safety.read || safety.write
}

function isDefaultModeAllowedTool(tool: ToolDefinition): boolean {
  const safety = getToolSafety(tool)
  return safety.read && !safety.shell && !safety.network && !safety.externalState && !safety.destructive && !safety.approvalRequired
}

function isNonDestructiveTool(tool: ToolDefinition): boolean {
  const safety = getToolSafety(tool)
  return !safety.destructive && !safety.approvalRequired
}

function isLocalFileEditTool(tool: ToolDefinition): boolean {
  return new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'LSP']).has(tool.name)
}

// --------------------------------------------------------------------------
// MCP Types
// --------------------------------------------------------------------------

export type McpServerConfig =
  | McpStdioConfig
  | McpSseConfig
  | McpHttpConfig

export interface McpStdioConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpSseConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpHttpConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

// --------------------------------------------------------------------------
// Agent Types
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// Sandbox Types
// --------------------------------------------------------------------------

export interface SandboxSettings {
  enabled?: boolean
  autoAllowBashIfSandboxed?: boolean
  excludedCommands?: string[]
  allowUnsandboxedCommands?: boolean
  network?: SandboxNetworkConfig
  filesystem?: SandboxFilesystemConfig
  ignoreViolations?: Record<string, string[]>
  enableWeakerNestedSandbox?: boolean
  ripgrep?: { command: string; args?: string[] }
}

export interface SandboxNetworkConfig {
  allowedDomains?: string[]
  allowManagedDomainsOnly?: boolean
  allowLocalBinding?: boolean
  allowUnixSockets?: string[]
  allowAllUnixSockets?: boolean
  httpProxyPort?: number
  socksProxyPort?: number
}

export interface SandboxFilesystemConfig {
  allowWrite?: string[]
  denyWrite?: string[]
  denyRead?: string[]
}

// --------------------------------------------------------------------------
// Output Format
// --------------------------------------------------------------------------

export interface OutputFormat {
  type: 'json_schema'
  schema: Record<string, unknown>
}

// --------------------------------------------------------------------------
// Memory Types
// --------------------------------------------------------------------------

export type MemoryPolicyMode = 'off' | 'autoInject' | 'brainFirst'

export interface MemoryPolicy {
  mode?: MemoryPolicyMode
}

export interface MemoryConfig {
  enabled?: boolean
  dir?: string
  autoInject?: boolean
  policy?: MemoryPolicy
  autoSaveSessionSummary?: boolean
  maxInjectedEntries?: number
  repoPath?: string
}

export interface SessionConfig {
  dir?: string
}

// --------------------------------------------------------------------------
// Doctor / Health Check Types
// --------------------------------------------------------------------------

export type DoctorCheckStatus = 'ok' | 'warn' | 'error' | 'skipped'

export type DoctorCheckCategory =
  | 'provider'
  | 'tools'
  | 'skills'
  | 'mcp'
  | 'storage'
  | 'package'

export interface DoctorCheck {
  name: string
  category: DoctorCheckCategory
  status: DoctorCheckStatus
  message: string
  details?: Record<string, unknown>
}

export interface DoctorReport {
  status: Exclude<DoctorCheckStatus, 'skipped'>
  checked_at: string
  cwd: string
  summary: Record<DoctorCheckStatus, number>
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  workflowMode?: WorkflowMode
  cwd?: string
  model?: string
  apiType?: import('./providers/types.js').ApiType
  apiKey?: string
  baseURL?: string
  env?: Record<string, string | undefined>
  tools?: ToolDefinition[] | string[] | { type: 'preset'; preset: 'default' }
  toolsets?: ToolsetName[]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, McpServerConfig | any>
  memory?: MemoryConfig
  session?: SessionConfig
  agentJobs?: { dir?: string; runtimeNamespace?: string; staleAfterMs?: number }
  runtimeNamespace?: string
  initializeBundledSkills?: boolean
  checkPackageEntrypoints?: boolean
  packageRoot?: string
}

// --------------------------------------------------------------------------
// Benchmark Types
// --------------------------------------------------------------------------

export type BenchmarkMetricName =
  | 'readOnlyFanOut'
  | 'serialMutationOrdering'
  | 'contextBuild'
  | 'runtimeProfileResolve'
  | 'memoryQuery'
  | 'agentJobStorage'

export interface BenchmarkMetric {
  name: BenchmarkMetricName
  iterations: number
  total_ms: number
  mean_ms: number
  min_ms: number
  max_ms: number
  metadata?: Record<string, unknown>
}

export interface BenchmarkReport {
  id: string
  started_at: string
  completed_at: string
  duration_ms: number
  cwd: string
  metrics: BenchmarkMetric[]
}

export interface BenchmarkOptions {
  cwd?: string
  iterations?: number
  memory?: MemoryConfig
  agentJobs?: { dir?: string; runtimeNamespace?: string }
}

export interface SelfImprovementMemoryConfig {
  enabled?: boolean
  dir?: string
  repoPath?: string
  maxEntriesPerRun?: number
  captureSuccessfulRuns?: boolean
}

export interface SelfImprovementRetroLoopConfig {
  enabled?: boolean
  maxAttempts?: number
  retryPrompt?: string
}

export interface SelfImprovementRetroConfig {
  enabled?: boolean
  targetName?: string
  cwd?: string
  gates?: import('./retro/types.js').RetroQualityGate[]
  policy?: import('./retro/types.js').RetroPolicy
  ledger?: import('./retro/types.js').RetroLedgerOptions
  loop?: SelfImprovementRetroLoopConfig
}

export interface SelfImprovementConfig {
  enabled?: boolean
  memory?: SelfImprovementMemoryConfig
  retro?: SelfImprovementRetroConfig
}

export interface AgentSelfImprovementResult {
  savedMemories: import('./memory.js').MemoryEntry[]
  retroCycle?: import('./retro/types.js').RetroCycleResult
  retroLoop?: import('./retro/types.js').RetroLoopResult
  errors?: string[]
}

// --------------------------------------------------------------------------
// Setting Sources
// --------------------------------------------------------------------------

export type SettingSource = 'user' | 'project' | 'local'

// --------------------------------------------------------------------------
// Model Info
// --------------------------------------------------------------------------

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

export type ToolsetName =
  | 'repo-readonly'
  | 'repo-edit'
  | 'research'
  | 'planning'
  | 'tasks'
  | 'automation'
  | 'agents'
  | 'mcp'
  | 'skills'

export type WorkflowMode =
  | 'collect'
  | 'organize'
  | 'plan'
  | 'solve'
  | 'build'
  | 'verify'
  | 'review'
  | 'ship'

export interface RuntimeProfile {
  name: WorkflowMode
  description: string
  toolsets?: ToolsetName[]
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: PermissionMode
  memory?: MemoryConfig
  qualityGatePolicy?: QualityGatePolicy
  appendSystemPrompt?: string
  maxTurns?: number
}

export interface ControlledExecutionContract {
  version: string
  workflowModes: WorkflowMode[]
  messageTypes: string[]
  resultFields: string[]
  traceFields: string[]
  profileRequiredFields: string[]
}

export interface AgentOptions {
  /** Named runtime workflow profile that expands into safe defaults for tools, permissions, memory, and gates. */
  workflowMode?: WorkflowMode
  /** LLM model ID */
  model?: string
  /**
   * API type: 'anthropic-messages' or 'openai-completions'.
   * Falls back to CLAVUE_AGENT_API_TYPE env var. Default: 'anthropic-messages'.
   */
  apiType?: import('./providers/types.js').ApiType
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
  /** Structured output JSON schema */
  jsonSchema?: Record<string, unknown>
  /** Structured output format */
  outputFormat?: OutputFormat
  /** Permission handler callback */
  canUseTool?: CanUseToolFn
  /** Permission mode reported in metadata and prompts. Defaults to trustedAutomation. Tool policy is enforced by canUseTool, allowedTools, and disallowedTools. */
  permissionMode?: PermissionMode
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

// --------------------------------------------------------------------------
// Query Engine Types
// --------------------------------------------------------------------------

export interface QueryEngineConfig {
  cwd: string
  model: string
  /** Optional model to try once after the primary model fails. */
  fallbackModel?: string
  /** LLM provider instance (created from apiType) */
  provider: import('./providers/types.js').LLMProvider
  tools: ToolDefinition[]
  systemPrompt?: string
  appendSystemPrompt?: string
  /** Initial prompt for memory retrieval */
  initialPrompt?: string
  maxTurns: number
  maxToolConcurrency?: number
  maxBudgetUsd?: number
  maxTokens: number
  thinking?: ThinkingConfig
  jsonSchema?: Record<string, unknown>
  policy: ToolPolicy
  includePartialMessages: boolean
  abortSignal?: AbortSignal
  agents?: Record<string, AgentDefinition>
  /** Hook registry for lifecycle events */
  hookRegistry?: import('./hooks.js').HookRegistry
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
}
