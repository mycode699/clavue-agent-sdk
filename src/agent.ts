/**
 * Agent - High-level API
 *
 * Provides createAgent() and query() interfaces compatible with
 * clavue-agent-sdk.
 *
 * Usage:
 *   import { createAgent } from 'clavue-agent-sdk'
 *   const agent = createAgent({ model: 'claude-sonnet-4-6' })
 *   for await (const event of agent.query('Hello')) { ... }
 *
 *   // OpenAI-compatible models
 *   const agent = createAgent({
 *     apiType: 'openai-completions',
 *     model: 'gpt-4o',
 *     apiKey: 'sk-...',
 *     baseURL: 'https://api.openai.com/v1',
 *   })
 */

import type {
  AgentOptions,
  AgentRunResult,
  QueryResult,
  SDKMessage,
  ToolDefinition,
  Message,
  PermissionMode,
  TokenUsage,
  AgentRunTrace,
} from './types.js'
import { QueryEngine } from './engine.js'
import { getAllBaseTools, filterTools, getToolsetTools } from './tools/index.js'
import { connectMCPServer, type MCPConnection } from './mcp/client.js'
import { isSdkServerConfig } from './sdk-mcp-server.js'
import { registerAgents } from './tools/agent-tool.js'
import { setMcpConnections } from './tools/mcp-resource-tools.js'
import {
  saveSession,
  loadSession,
  type SessionStoreOptions,
} from './session.js'
import { saveMemory } from './memory.js'
import { persistSessionMemoryCandidates } from './memory-policy.js'
import { runSelfImprovement } from './improvement.js'
import { applyRuntimeProfile } from './runtime-profiles.js'
import { createHookRegistry, type HookRegistry } from './hooks.js'
import { initBundledSkills } from './skills/index.js'
import { createProvider, getModelCapabilities, type LLMProvider, type ApiType } from './providers/index.js'
import type { NormalizedMessageParam } from './providers/types.js'
import { AGENT_RUN_RESULT_SCHEMA_VERSION, createDefaultToolPolicy } from './types.js'
import { extractTextFromContent } from './utils/messages.js'

// --------------------------------------------------------------------------
// Agent class
// --------------------------------------------------------------------------

function resolveSelfImprovementConfig(
  value: AgentOptions['selfImprovement'],
): import('./types.js').SelfImprovementConfig | null {
  if (!value) return null
  return value === true ? { enabled: true } : value
}

export class Agent {
  private cfg: AgentOptions
  private toolPool: ToolDefinition[]
  private modelId: string
  private apiType: ApiType
  private apiCredentials: { key?: string; baseUrl?: string }
  private provider: LLMProvider
  private mcpLinks: MCPConnection[] = []
  private history: NormalizedMessageParam[] = []
  private messageLog: Message[] = []
  private setupDone: Promise<void>
  private sid: string
  private abortCtrl: AbortController | null = null
  private currentEngine: QueryEngine | null = null
  private hookRegistry: HookRegistry

  constructor(options: AgentOptions = {}) {
    // Shallow copy to avoid mutating caller's object
    this.cfg = applyRuntimeProfile(options)

    // Merge credentials from options.env map, direct options, and process.env
    this.apiCredentials = this.pickCredentials()
    this.modelId =
      this.cfg.model ??
      this.cfg.env?.CLAVUE_AGENT_MODEL ??
      this.readEnv('CLAVUE_AGENT_MODEL') ??
      'claude-sonnet-4-6'
    this.sid = this.cfg.sessionId ?? this.cfg.resume ?? crypto.randomUUID()
    this.cfg.runtimeNamespace ??= this.sid

    // Resolve API type
    this.apiType = this.resolveApiType()

    // Create LLM provider
    this.provider = createProvider(this.apiType, {
      apiKey: this.apiCredentials.key,
      baseURL: this.apiCredentials.baseUrl,
    })

    // Initialize bundled skills
    initBundledSkills()

    // Build hook registry from options
    this.hookRegistry = createHookRegistry()
    if (this.cfg.hooks) {
      // Convert AgentOptions hooks format to HookConfig
      for (const [event, defs] of Object.entries(this.cfg.hooks)) {
        for (const def of defs) {
          for (const handler of def.hooks) {
            this.hookRegistry.register(event as any, {
              matcher: def.matcher,
              timeout: def.timeout,
              handler: async (input) => {
                const result = await handler(input, input.toolUseId || '', {
                  signal: this.abortCtrl?.signal || new AbortController().signal,
                })
                return result || undefined
              },
            })
          }
        }
      }
    }

    // Build tool pool from options (supports ToolDefinition[], string[], or preset)
    this.toolPool = this.buildToolPool()

    // Kick off async setup (MCP connections, agent registration, session resume)
    this.setupDone = this.setup()
  }

  /**
   * Resolve API type from options, env, or model capability metadata.
   */
  private resolveApiType(): ApiType {
    if (this.cfg.apiType) return this.cfg.apiType

    const envType =
      this.cfg.env?.CLAVUE_AGENT_API_TYPE ??
      this.readEnv('CLAVUE_AGENT_API_TYPE')
    if (envType === 'openai-completions' || envType === 'anthropic-messages') {
      return envType
    }

    return getModelCapabilities(this.modelId).apiType
  }

  /** Pick API key and base URL from options or CLAVUE_AGENT_* env vars. */
  private pickCredentials(): { key?: string; baseUrl?: string } {
    const envMap = this.cfg.env
    return {
      key:
        this.cfg.apiKey ??
        envMap?.CLAVUE_AGENT_API_KEY ??
        envMap?.CLAVUE_AGENT_AUTH_TOKEN ??
        this.readEnv('CLAVUE_AGENT_API_KEY') ??
        this.readEnv('CLAVUE_AGENT_AUTH_TOKEN'),
      baseUrl:
        this.cfg.baseURL ??
        envMap?.CLAVUE_AGENT_BASE_URL ??
        this.readEnv('CLAVUE_AGENT_BASE_URL'),
    }
  }

  /** Read a value from process.env (returns undefined if missing). */
  private readEnv(key: string): string | undefined {
    return process.env[key] || undefined
  }

  private sessionStoreOptions(options: AgentOptions = this.cfg): SessionStoreOptions | undefined {
    return options.session?.dir ? { dir: options.session.dir } : undefined
  }

  /** Assemble the available tool set based on options. */
  private buildToolPool(): ToolDefinition[] {
    const raw = this.cfg.tools
    let pool: ToolDefinition[]

    if (!raw || (typeof raw === 'object' && !Array.isArray(raw) && 'type' in raw)) {
      pool = getAllBaseTools()
    } else if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'string') {
      pool = filterTools(getAllBaseTools(), raw as string[])
    } else {
      pool = raw as ToolDefinition[]
    }

    return this.filterConfiguredTools(pool, this.cfg)
  }

  private filterConfiguredTools(tools: ToolDefinition[], options: Pick<AgentOptions, 'toolsets' | 'allowedTools' | 'disallowedTools'>): ToolDefinition[] {
    const toolsetTools = getToolsetTools(options.toolsets)
    const allowedTools = toolsetTools.length > 0
      ? [...new Set([...toolsetTools, ...(options.allowedTools ?? [])])]
      : options.allowedTools

    return filterTools(tools, allowedTools, options.disallowedTools)
  }

  /**
   * Async initialization: connect MCP servers, register agents, resume sessions.
   */
  private async setup(): Promise<void> {
    // Register custom agent definitions
    if (this.cfg.agents) {
      registerAgents(this.cfg.agents, { runtimeNamespace: this.cfg.runtimeNamespace })
    }

    // Connect MCP servers (supports stdio, SSE, HTTP, and in-process SDK servers)
    if (this.cfg.mcpServers) {
      for (const [name, config] of Object.entries(this.cfg.mcpServers)) {
        try {
          if (isSdkServerConfig(config)) {
            // In-process SDK MCP server - directly add tools
            this.toolPool = [...this.toolPool, ...config.tools]
          } else {
            // External MCP server
            const connection = await connectMCPServer(name, config)
            this.mcpLinks.push(connection)
            setMcpConnections(this.mcpLinks, { runtimeNamespace: this.cfg.runtimeNamespace })

            if (connection.status === 'connected' && connection.tools.length > 0) {
              this.toolPool = [...this.toolPool, ...connection.tools]
            }
          }
        } catch (err: any) {
          console.error(`[MCP] Failed to connect to "${name}": ${err.message}`)
        }
      }
    }

    // Resume or continue session
    if (this.cfg.resume) {
      const sessionData = await loadSession(this.cfg.resume, this.sessionStoreOptions())
      if (sessionData) {
        this.history = sessionData.messages
        this.sid = this.cfg.resume
      }
    }
  }

  /**
   * Run a query with streaming events.
   */
  async *query(
    prompt: string,
    overrides?: Partial<AgentOptions>,
  ): AsyncGenerator<SDKMessage, void> {
    await this.setupDone

    const opts = applyRuntimeProfile({ ...this.cfg, ...overrides, runtimeNamespace: this.cfg.runtimeNamespace })
    const cwd = opts.cwd || process.cwd()

    // Create abort controller for this query
    this.abortCtrl = opts.abortController || new AbortController()
    if (opts.abortSignal) {
      opts.abortSignal.addEventListener('abort', () => this.abortCtrl?.abort(), { once: true })
    }

    // Resolve systemPrompt (handle preset object)
    let systemPrompt: string | undefined
    let appendSystemPrompt = opts.appendSystemPrompt
    if (typeof opts.systemPrompt === 'object' && opts.systemPrompt?.type === 'preset') {
      systemPrompt = undefined // Use engine default (default style)
      if (opts.systemPrompt.append) {
        appendSystemPrompt = (appendSystemPrompt || '') + '\n' + opts.systemPrompt.append
      }
    } else {
      systemPrompt = opts.systemPrompt as string | undefined
    }

    // Resolve permission metadata and tool policy
    const policy = createDefaultToolPolicy(opts.permissionMode)
    if (opts.canUseTool) {
      const builtInCanUseTool = policy.canUseTool
      policy.canUseTool = async (tool, input) => {
        const builtInDecision = await builtInCanUseTool(tool, input)
        if (builtInDecision.behavior === 'deny') return builtInDecision

        const hostDecision = await opts.canUseTool!(tool, builtInDecision.updatedInput ?? input)
        const hostSource = hostDecision.source ?? 'host_canUseTool'
        if (hostDecision.updatedInput === undefined && builtInDecision.updatedInput !== undefined) {
          return { ...hostDecision, source: hostSource, updatedInput: builtInDecision.updatedInput }
        }
        return { ...hostDecision, source: hostSource }
      }
    }

    // Resolve tools with profile-expanded query options.
    let tools = this.filterConfiguredTools(this.toolPool, opts)
    if (overrides?.tools) {
      const ot = overrides.tools
      if (Array.isArray(ot) && ot.length > 0 && typeof ot[0] === 'string') {
        tools = filterTools(this.toolPool, ot as string[])
      } else if (Array.isArray(ot)) {
        tools = ot as ToolDefinition[]
      }
    }

    // Recreate provider if overrides change credentials or apiType
    let provider = this.provider
    if (overrides?.apiType || overrides?.apiKey || overrides?.baseURL) {
      const resolvedApiType = overrides.apiType ?? this.apiType
      provider = createProvider(resolvedApiType, {
        apiKey: overrides.apiKey ?? this.apiCredentials.key,
        baseURL: overrides.baseURL ?? this.apiCredentials.baseUrl,
      })
    }

    // Create query engine with current conversation state
    const engine = new QueryEngine({
      cwd,
      model: opts.model || this.modelId,
      fallbackModel: opts.fallbackModel,
      provider,
      tools,
      systemPrompt,
      appendSystemPrompt,
      maxTurns: opts.maxTurns ?? 10,
      maxToolConcurrency: opts.maxToolConcurrency,
      maxBudgetUsd: opts.maxBudgetUsd,
      maxTokens: opts.maxTokens ?? 16384,
      thinking: opts.thinking,
      jsonSchema: opts.jsonSchema,
      policy,
      autonomyMode: opts.autonomyMode,
      includePartialMessages: opts.includePartialMessages ?? false,
      abortSignal: this.abortCtrl.signal,
      agents: opts.agents,
      hookRegistry: this.hookRegistry,
      sessionId: this.sid,
      runtimeNamespace: opts.runtimeNamespace,
      memory: opts.memory,
      evidence: opts.evidence,
      quality_gates: opts.quality_gates,
      qualityGatePolicy: opts.qualityGatePolicy,
    })
    this.currentEngine = engine

    // Inject existing conversation history
    for (const msg of this.history) {
      (engine as any).messages.push(msg)
    }

    // Run the engine
    for await (const event of engine.submitMessage(prompt)) {
      yield event

      // Track assistant messages for multi-turn persistence
      if (event.type === 'assistant') {
        const uuid = crypto.randomUUID()
        const timestamp = new Date().toISOString()
        this.messageLog.push({
          type: 'assistant',
          message: event.message,
          uuid,
          timestamp,
        })
      }
    }

    // Persist conversation state for multi-turn
    this.history = engine.getMessages()

    // Add user message to tracked messages
    const userUuid = crypto.randomUUID()
    this.messageLog.push({
      type: 'user',
      message: { role: 'user', content: prompt },
      uuid: userUuid,
      timestamp: new Date().toISOString(),
    })
  }

  /**
   * Execute a prompt and return a structured run artifact.
   */
  async run(
    text: string,
    overrides?: Partial<AgentOptions>,
  ): Promise<AgentRunResult> {
    const runId = crypto.randomUUID()
    const startedAt = new Date().toISOString()
    const t0 = performance.now()
    const events: SDKMessage[] = []
    let finalText = ''
    let finalSubtype = 'success'
    let stopReason: string | null = null
    let totalCostUsd = 0
    let durationApiMs = 0
    let numTurns = 0
    let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
    let trace: AgentRunTrace | undefined
    let evidence: AgentRunResult['evidence']
    let qualityGates: AgentRunResult['quality_gates']
    let errors: string[] | undefined

    for await (const ev of this.query(text, overrides)) {
      events.push(ev)

      switch (ev.type) {
        case 'assistant': {
          const text = extractTextFromContent(ev.message.content as any[])
          if (text) {
            finalText = text
          }
          break
        }
        case 'result': {
          finalSubtype = ev.subtype
          stopReason = ev.stop_reason ?? null
          totalCostUsd = ev.total_cost_usd ?? ev.cost ?? 0
          durationApiMs = ev.duration_api_ms ?? 0
          numTurns = ev.num_turns ?? 0
          usage = ev.usage ?? usage
          trace = ev.trace
          evidence = ev.evidence
          qualityGates = ev.quality_gates
          errors = ev.errors
          break
        }
      }
    }

    const completedAt = new Date().toISOString()
    const durationMs = Math.round(performance.now() - t0)
    const result: AgentRunResult = {
      schema_version: AGENT_RUN_RESULT_SCHEMA_VERSION,
      id: runId,
      session_id: this.sid,
      status: finalSubtype === 'success' ? 'completed' : 'errored',
      subtype: finalSubtype,
      text: finalText,
      usage,
      num_turns: numTurns,
      duration_ms: durationMs,
      duration_api_ms: durationApiMs,
      total_cost_usd: totalCostUsd,
      stop_reason: stopReason,
      started_at: startedAt,
      completed_at: completedAt,
      messages: [...this.messageLog],
      events,
      errors,
      evidence,
      quality_gates: qualityGates,
      trace,
    }

    const selfImprovement = resolveSelfImprovementConfig(overrides?.selfImprovement ?? this.cfg.selfImprovement)
    if (selfImprovement && selfImprovement.enabled !== false) {
      const runOverrides = overrides ?? {}
      result.self_improvement = await runSelfImprovement(result, selfImprovement, {
        cwd: overrides?.cwd || this.cfg.cwd || process.cwd(),
        sessionId: this.sid,
        memory: overrides?.memory ?? this.cfg.memory,
        onAttemptRetry: selfImprovement.retro?.loop?.enabled
          ? async () => this.run(
              selfImprovement.retro?.loop?.retryPrompt || text,
              {
                ...runOverrides,
                selfImprovement: false,
              },
            )
          : undefined,
      })
    }

    return result
  }

  /**
   * Convenience method: send a prompt and collect the final answer as a single object.
   * Internally reuses the structured run artifact.
   */
  async prompt(
    text: string,
    overrides?: Partial<AgentOptions>,
  ): Promise<QueryResult> {
    const run = await this.run(text, overrides)

    return {
      text: run.text,
      usage: run.usage,
      num_turns: run.num_turns,
      duration_ms: run.duration_ms,
      messages: run.messages,
    }
  }

  /**
   * Get conversation messages.
   */
  getMessages(): Message[] {
    return [...this.messageLog]
  }

  /**
   * Reset conversation history.
   */
  clear(): void {
    this.history = []
    this.messageLog = []
  }

  /**
   * Interrupt the current query.
   */
  async interrupt(): Promise<void> {
    this.abortCtrl?.abort()
  }

  /**
   * Change the model during a session.
   */
  async setModel(model?: string): Promise<void> {
    if (model) {
      this.modelId = model
      this.cfg.model = model
    }
  }

  /**
   * Change the permission mode during a session.
   */
  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.cfg.permissionMode = mode
  }

  /**
   * Set maximum thinking tokens.
   */
  async setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void> {
    if (maxThinkingTokens === null) {
      this.cfg.thinking = { type: 'disabled' }
    } else {
      this.cfg.thinking = { type: 'enabled', budgetTokens: maxThinkingTokens }
    }
  }

  /**
   * Get the session ID.
   */
  getSessionId(): string {
    return this.sid
  }

  /**
   * Get the current API type.
   */
  getApiType(): ApiType {
    return this.apiType
  }

  /**
   * Stop a background task.
   */
  async stopTask(taskId: string): Promise<void> {
    const { stopAgentJob } = await import('./agent-jobs.js')
    const stoppedJob = await stopAgentJob(taskId, undefined, { runtimeNamespace: this.cfg.runtimeNamespace })
    if (stoppedJob) return

    const { getTask } = await import('./tools/task-tools.js')
    const task = getTask(taskId, { runtimeNamespace: this.cfg.runtimeNamespace })
    if (task) {
      task.status = 'cancelled'
    }
  }

  /**
   * Close MCP connections and clean up.
   * Optionally persist session to disk.
   */
  async close(): Promise<void> {
    const cwd = this.cfg.cwd || process.cwd()

    // Persist session if enabled
    if (this.cfg.persistSession !== false && this.history.length > 0) {
      try {
        await saveSession(
          this.sid,
          this.history,
          {
            cwd,
            model: this.modelId,
            summary: undefined,
          },
          this.sessionStoreOptions(),
        )
      } catch {
        // Session persistence is best-effort
      }
    }

    if (this.cfg.memory?.enabled && this.cfg.memory.autoSaveSessionSummary !== false && this.messageLog.length > 0) {
      try {
        const lastUserMessage = [...this.messageLog]
          .reverse()
          .find((message) => message.type === 'user')
        const lastAssistantMessage = [...this.messageLog]
          .reverse()
          .find((message) => message.type === 'assistant')

        const userText = typeof lastUserMessage?.message.content === 'string'
          ? lastUserMessage.message.content
          : ''
        const assistantText = lastAssistantMessage
          ? extractTextFromContent(lastAssistantMessage.message.content)
          : ''
        const repoPath = this.cfg.memory.repoPath || cwd
        const storeOptions = { dir: this.cfg.memory.dir }

        await persistSessionMemoryCandidates(this.messageLog, {
          repoPath,
          sessionId: this.sid,
        }, storeOptions)

        if (userText || assistantText) {
          await saveMemory(
            {
              id: `session-${this.sid}`,
              type: 'decision',
              scope: 'session',
              title: `Session summary for ${this.sid}`,
              content: `Last user request: ${userText || '(none)'}\n\nLast assistant response: ${assistantText || '(none)'}`,
              repoPath,
              sessionId: this.sid,
              confidence: 'medium',
              source: 'auto-saved session summary',
              tags: ['session', 'summary'],
            },
            storeOptions,
          )
        }
      } catch {
        // Memory persistence is best-effort
      }
    }

    for (const conn of this.mcpLinks) {
      await conn.close()
    }
    this.mcpLinks = []
    setMcpConnections([], { runtimeNamespace: this.cfg.runtimeNamespace })
  }
}

// --------------------------------------------------------------------------
// Factory function
// --------------------------------------------------------------------------

/** Factory: shorthand for `new Agent(options)`. */
export function createAgent(options: AgentOptions = {}): Agent {
  return new Agent(options)
}

// --------------------------------------------------------------------------
// Standalone query — one-shot convenience wrapper
// --------------------------------------------------------------------------

/**
 * Execute a single agentic query without managing an Agent instance.
 * The agent is created, used, and cleaned up automatically.
 */
export async function* query(params: {
  prompt: string
  options?: AgentOptions
}): AsyncGenerator<SDKMessage, void> {
  const ephemeral = createAgent(params.options)
  try {
    yield* ephemeral.query(params.prompt)
  } finally {
    await ephemeral.close()
  }
}

/**
 * Execute a single agent run and return a structured run artifact.
 */
export async function run(params: {
  prompt: string
  options?: AgentOptions
}): Promise<AgentRunResult> {
  const ephemeral = createAgent(params.options)
  try {
    return await ephemeral.run(params.prompt)
  } finally {
    await ephemeral.close()
  }
}
