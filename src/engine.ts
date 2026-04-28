/**
 * QueryEngine - Core agentic loop
 *
 * Manages the full conversation lifecycle:
 * 1. Take user prompt
 * 2. Build system prompt with context (git status, project context, tools)
 * 3. Call LLM API with tools (via provider abstraction)
 * 4. Stream response
 * 5. Execute tool calls (concurrent for read-only, serial for mutations)
 * 6. Send results back, repeat until done
 * 7. Auto-compact when context exceeds threshold
 * 8. Retry with exponential backoff on transient errors
 */

import type {
  SDKMessage,
  QueryEngineConfig,
  ToolDefinition,
  ToolResult,
  ToolContext,
  TokenUsage,
  AgentRunTrace,
  AgentRunToolTrace,
  Evidence,
  QualityGateResult,
} from './types.js'
import type {
  LLMProvider,
  CreateMessageResponse,
  NormalizedMessageParam,
  NormalizedTool,
} from './providers/types.js'
import {
  estimateMessagesTokens,
  estimateCost,
  getAutoCompactThreshold,
} from './utils/tokens.js'
import {
  shouldAutoCompact,
  compactConversation,
  microCompactMessages,
  createAutoCompactState,
  type AutoCompactState,
} from './utils/compact.js'
import {
  withRetry,
  isPromptTooLongError,
} from './utils/retry.js'
import { getSystemContext, getUserContext } from './utils/context.js'
import { normalizeMessagesForAPI } from './utils/messages.js'
import type { HookRegistry, HookInput, HookOutput } from './hooks.js'
import { queryMemories, type MemoryEntry } from './memory.js'

// ============================================================================
// Tool format conversion
// ============================================================================

/** Convert a ToolDefinition to the normalized provider tool format. */
function toProviderTool(tool: ToolDefinition): NormalizedTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

// ============================================================================
// ToolUseBlock (internal type for extracted tool_use blocks)
// ============================================================================

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

interface SkillActivation {
  type: 'clavue.skill.activation'
  version: 1
  success: true
  skillName?: string
  commandName?: string
  status?: 'inline' | 'forked'
  prompt?: string
  allowedTools?: string[]
  model?: string
}

function getMemoryPriority(memory: MemoryEntry): number {
  switch (memory.type) {
    case 'feedback':
      return 0
    case 'decision':
      return 1
    case 'improvement':
      return 2
    case 'project':
      return 3
    case 'reference':
      return 4
    case 'user':
      return 5
    default:
      return 6
  }
}

function formatInjectedMemories(memories: MemoryEntry[]): string {
  const lines: string[] = []

  for (const memory of [...memories].sort((a, b) => getMemoryPriority(a) - getMemoryPriority(b))) {
    const metadata = [memory.type, memory.scope, memory.confidence]
      .filter(Boolean)
      .join(' / ')
    lines.push(`- ${memory.title}${metadata ? ` (${metadata})` : ''}`)
    lines.push(`  ${memory.content}`)
    if (memory.tags && memory.tags.length > 0) {
      lines.push(`  tags: ${memory.tags.join(', ')}`)
    }
  }

  return lines.join('\n')
}

function getMaxToolConcurrency(): number {
  const parsed = Number.parseInt(process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY || '10', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 10
}

function canRunConcurrently(tool?: ToolDefinition): boolean {
  return tool?.isReadOnly?.() === true && tool.isConcurrencySafe?.() === true
}

function filterToolsForSkill(tools: ToolDefinition[], allowedTools?: string[]): ToolDefinition[] {
  if (!allowedTools || allowedTools.length === 0) return tools

  const allowed = new Set([...allowedTools, 'Skill'])
  return tools.filter((tool) => allowed.has(tool.name))
}

function parseSkillActivation(result: ToolResult): SkillActivation | undefined {
  if (result.is_error || typeof result.content !== 'string') return undefined

  try {
    const parsed = JSON.parse(result.content) as Partial<SkillActivation>
    if (
      parsed?.type !== 'clavue.skill.activation' ||
      parsed.version !== 1 ||
      parsed.success !== true ||
      typeof parsed.prompt !== 'string'
    ) {
      return undefined
    }

    return {
      type: 'clavue.skill.activation',
      version: 1,
      success: true,
      skillName: typeof parsed.skillName === 'string' ? parsed.skillName : parsed.commandName,
      commandName: typeof parsed.commandName === 'string' ? parsed.commandName : parsed.skillName,
      status: parsed.status === 'forked' ? 'forked' : 'inline',
      prompt: parsed.prompt,
      allowedTools: Array.isArray(parsed.allowedTools)
        ? parsed.allowedTools.filter((name): name is string => typeof name === 'string')
        : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
    }
  } catch {
    return undefined
  }
}

function createToolContext(config: QueryEngineConfig): ToolContext {
  return {
    cwd: config.cwd,
    abortSignal: config.abortSignal,
    provider: config.provider,
    model: config.model,
    apiType: config.provider.apiType,
    policy: config.policy,
    runtimeNamespace: config.runtimeNamespace,
  }
}

async function collectToolPromptFragments(config: QueryEngineConfig): Promise<string[]> {
  const context = createToolContext(config)
  const fragments: string[] = []
  const maxChars = 8_000
  const maxFragmentChars = 2_000
  let used = 0

  for (const tool of config.tools) {
    if (!tool.prompt) continue
    if (tool.isEnabled && !tool.isEnabled(context)) continue

    try {
      const prompt = (await tool.prompt(context)).trim()
      if (!prompt) continue

      const trimmedPrompt = prompt.length > maxFragmentChars
        ? `${prompt.slice(0, maxFragmentChars)}\n...(tool guidance truncated)...`
        : prompt
      const fragment = `## ${tool.name}\n${trimmedPrompt}`
      if (used + fragment.length > maxChars) continue
      fragments.push(fragment)
      used += fragment.length
    } catch {
      // Tool prompt fragments are best-effort and should not block a run.
    }
  }

  return fragments
}

async function getInjectedMemories(config: QueryEngineConfig): Promise<MemoryEntry[]> {
  if (!config.memory?.enabled || config.memory.autoInject === false) {
    return []
  }

  const repoPath = config.memory.repoPath || config.cwd
  const text = typeof config.initialPrompt === 'string' ? config.initialPrompt : undefined
  const limit = config.memory.maxInjectedEntries ?? 5
  const store = { dir: config.memory.dir }

  const targeted = await queryMemories(
    {
      repoPath,
      text,
      limit,
    },
    store,
  )

  if (targeted.length > 0) {
    return targeted
  }

  return queryMemories(
    {
      repoPath,
      limit,
    },
    store,
  )
}

// ============================================================================
// System Prompt Builder
// ============================================================================

async function buildSystemPrompt(config: QueryEngineConfig): Promise<string> {
  if (config.systemPrompt) {
    const base = config.systemPrompt
    return config.appendSystemPrompt
      ? base + '\n\n' + config.appendSystemPrompt
      : base
  }

  const parts: string[] = [
    config.policy.permissionMode === 'trustedAutomation'
      ? 'You are running in trusted automation mode inside the host application.'
      : `You are running with permission mode ${config.policy.permissionMode} inside the host application.`,
    'Use the available tools to complete the user\'s task. Inspect the project, make focused changes, and verify concrete results before claiming completion.',
  ]

  if (config.policy.permissionMode === 'trustedAutomation') {
    parts.push('Prefer direct execution over asking for confirmation. Ask the user only when requirements are genuinely ambiguous or an action is destructive, hard to reverse, or affects shared external state.')
  } else {
    parts.push('Tool access is governed by the host application\'s available tool set, canUseTool policy, and hooks.')
  }

  parts.push(
    'Keep changes surgical and goal-driven: understand the existing code first, reuse existing patterns, avoid speculative abstractions, and do not expand scope beyond the request.',
  )

  // List available tools with descriptions
  parts.push('\n# Available Tools\n')
  for (const tool of config.tools) {
    parts.push(`- **${tool.name}**: ${tool.description}`)
  }

  const toolPromptFragments = await collectToolPromptFragments(config)
  if (toolPromptFragments.length > 0) {
    parts.push('\n# Tool Guidance\n')
    parts.push(toolPromptFragments.join('\n\n'))
  }

  // Add agent definitions
  if (config.agents && Object.keys(config.agents).length > 0) {
    parts.push('\n# Available Subagents\n')
    for (const [name, def] of Object.entries(config.agents)) {
      parts.push(`- **${name}**: ${def.description}`)
    }
  }

  // System context (git status, etc.)
  try {
    const sysCtx = await getSystemContext(config.cwd)
    if (sysCtx) {
      parts.push('\n# Environment\n')
      parts.push(sysCtx)
    }
  } catch {
    // Context is best-effort
  }

  // User context (AGENT.md, date)
  try {
    const userCtx = await getUserContext(config.cwd)
    if (userCtx) {
      parts.push('\n# Project Context\n')
      parts.push(userCtx)
    }
  } catch {
    // Context is best-effort
  }

  const injectedMemories = await getInjectedMemories(config)
  if (injectedMemories.length > 0) {
    parts.push('\n# Relevant Memory\n')
    parts.push(formatInjectedMemories(injectedMemories))
  }

  // Working directory
  parts.push(`\n# Working Directory\n${config.cwd}`)

  if (config.appendSystemPrompt) {
    parts.push('\n' + config.appendSystemPrompt)
  }

  return parts.join('\n')
}

// ============================================================================
// QueryEngine
// ============================================================================

export class QueryEngine {
  private config: QueryEngineConfig
  private provider: LLMProvider
  public messages: NormalizedMessageParam[] = []
  private totalUsage: TokenUsage = { input_tokens: 0, output_tokens: 0 }
  private modelUsage: Record<string, { input_tokens: number; output_tokens: number }> = {}
  private totalCost = 0
  private turnCount = 0
  private trace: AgentRunTrace = {
    turns: [],
    tools: [],
    concurrency_batches: [],
    retry_count: 0,
    compaction_count: 0,
    permission_denials: [],
  }
  private compactState: AutoCompactState
  private sessionId: string
  private apiTimeMs = 0
  private hookRegistry?: HookRegistry
  private activeSkill?: SkillActivation
  private evidence: Evidence[] = []
  private qualityGates: QualityGateResult[] = []

  constructor(config: QueryEngineConfig) {
    this.config = { ...config, runtimeNamespace: config.runtimeNamespace ?? config.sessionId }
    this.evidence = [...(config.evidence ?? [])]
    this.qualityGates = [...(config.quality_gates ?? [])]
    this.provider = config.provider
    this.compactState = createAutoCompactState()
    this.sessionId = config.sessionId || crypto.randomUUID()
    this.hookRegistry = config.hookRegistry
  }

  /**
   * Execute hooks for a lifecycle event.
   * Returns hook outputs; never throws.
   */
  private async executeHooks(
    event: import('./hooks.js').HookEvent,
    extra?: Partial<HookInput>,
  ): Promise<HookOutput[]> {
    if (!this.hookRegistry?.hasHooks(event)) return []
    try {
      return await this.hookRegistry.execute(event, {
        event,
        sessionId: this.sessionId,
        cwd: this.config.cwd,
        ...extra,
      })
    } catch {
      return []
    }
  }

  private recordModelUsage(model: string, usage: TokenUsage): void {
    const current = this.modelUsage[model] ?? { input_tokens: 0, output_tokens: 0 }
    current.input_tokens += usage.input_tokens
    current.output_tokens += usage.output_tokens
    this.modelUsage[model] = current
  }

  /**
   * Submit a user message and run the agentic loop.
   * Yields SDKMessage events as the agent works.
   */
  async *submitMessage(
    prompt: string | any[],
  ): AsyncGenerator<SDKMessage> {
    // Hook: SessionStart
    await this.executeHooks('SessionStart')

    // Hook: UserPromptSubmit
    const userHookResults = await this.executeHooks('UserPromptSubmit', {
      toolInput: prompt,
    })
    // Check if any hook blocks the submission
    if (userHookResults.some((r) => r.block)) {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        is_error: true,
        usage: this.totalUsage,
        num_turns: 0,
        cost: 0,
        errors: ['Blocked by UserPromptSubmit hook'],
      }
      return
    }

    // Add user message
    this.messages.push({ role: 'user', content: prompt as any })

    // Build system prompt
    this.config.initialPrompt = typeof prompt === 'string' ? prompt : undefined
    let systemPrompt = await buildSystemPrompt(this.config)

    // Emit init system message
    yield {
      type: 'system',
      subtype: 'init',
      session_id: this.sessionId,
      tools: this.config.tools.map(t => t.name),
      model: this.config.model,
      cwd: this.config.cwd,
      mcp_servers: [],
      permission_mode: this.config.policy.permissionMode,
    } as SDKMessage

    // Agentic loop
    let turnsRemaining = this.config.maxTurns
    let budgetExceeded = false
    let completedNormally = false
    let maxOutputRecoveryAttempts = 0
    const MAX_OUTPUT_RECOVERY = 3

    while (turnsRemaining > 0) {
      if (this.config.abortSignal?.aborted) break

      // Check budget
      if (this.config.maxBudgetUsd && this.totalCost >= this.config.maxBudgetUsd) {
        budgetExceeded = true
        break
      }

      // Auto-compact if context is too large
      if (shouldAutoCompact(this.messages as any[], this.config.model, this.compactState)) {
        await this.executeHooks('PreCompact')
        try {
          const result = await compactConversation(
            this.provider,
            this.config.model,
            this.messages as any[],
            this.compactState,
            this.config.abortSignal,
          )
          this.messages = result.compactedMessages as NormalizedMessageParam[]
          this.compactState = result.state
          this.trace.compaction_count += 1
          await this.executeHooks('PostCompact')
        } catch {
          // Continue with uncompacted messages
        }
      }

      // Micro-compact: truncate large tool results
      const apiMessages = microCompactMessages(
        normalizeMessagesForAPI(this.messages as any[]),
      ) as NormalizedMessageParam[]

      this.turnCount++
      turnsRemaining--

      const activeSkill = this.activeSkill
      const activeTools = activeSkill
        ? filterToolsForSkill(this.config.tools, activeSkill.allowedTools)
        : this.config.tools
      const providerTools = activeTools.map(toProviderTool)
      const requestModel = activeSkill?.model || this.config.model
      const requestSystemPrompt = activeSkill
        ? `${systemPrompt}\n\n# Active Skill: ${activeSkill.skillName || activeSkill.commandName || 'unknown'}\n${activeSkill.prompt}\n\nRemain within this active skill until the current workflow is complete. Use only the tools available for this request.`
        : systemPrompt

      // Make API call with retry via provider
      let response: CreateMessageResponse
      let apiAttempts = 0
      const apiStart = performance.now()
      try {
        response = await withRetry(
          async () => {
            apiAttempts += 1
            return this.provider.createMessage({
              model: requestModel,
              maxTokens: this.config.maxTokens,
              system: requestSystemPrompt,
              messages: apiMessages,
              tools: providerTools.length > 0 ? providerTools : undefined,
              thinking:
                this.config.thinking?.type === 'enabled' &&
                this.config.thinking.budgetTokens
                  ? {
                      type: 'enabled',
                      budget_tokens: this.config.thinking.budgetTokens,
                    }
                  : undefined,
              abortSignal: this.config.abortSignal,
            })
          },
          undefined,
          this.config.abortSignal,
        )
        this.trace.retry_count += Math.max(0, apiAttempts - 1)
      } catch (err: any) {
        this.trace.retry_count += Math.max(0, apiAttempts - 1)
        // Handle prompt-too-long by compacting
        if (isPromptTooLongError(err) && !this.compactState.compacted) {
          try {
            const result = await compactConversation(
              this.provider,
              this.config.model,
              this.messages as any[],
              this.compactState,
              this.config.abortSignal,
            )
            this.messages = result.compactedMessages as NormalizedMessageParam[]
            this.compactState = result.state
            this.trace.compaction_count += 1
            turnsRemaining++ // Retry this turn
            this.turnCount--
            continue
          } catch {
            // Can't compact, give up
          }
        }

        yield {
          type: 'result',
          subtype: 'error',
          session_id: this.sessionId,
          is_error: true,
          usage: this.totalUsage,
          num_turns: this.turnCount,
          total_cost_usd: this.totalCost,
          duration_api_ms: Math.round(this.apiTimeMs + performance.now() - apiStart),
          model_usage: this.getModelUsage(),
          permission_denials: this.trace.permission_denials,
          evidence: this.getEvidence(),
          quality_gates: this.getQualityGates(),
          trace: this.getTrace(),
          errors: [err?.message || String(err)],
          cost: this.totalCost,
        }
        return
      }

      // Track API timing
      const turnApiTimeMs = performance.now() - apiStart
      this.apiTimeMs += turnApiTimeMs

      const inputTokens = response.usage?.input_tokens ?? 0
      const outputTokens = response.usage?.output_tokens ?? 0
      this.trace.turns.push({
        turn: this.turnCount,
        duration_api_ms: Math.round(turnApiTimeMs),
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        tool_calls: response.content.filter((block) => block.type === 'tool_use').length,
      })

      // Track usage (normalized by provider)
      if (response.usage) {
        this.totalUsage.input_tokens += response.usage.input_tokens
        this.totalUsage.output_tokens += response.usage.output_tokens
        if (response.usage.cache_creation_input_tokens) {
          this.totalUsage.cache_creation_input_tokens =
            (this.totalUsage.cache_creation_input_tokens || 0) +
            response.usage.cache_creation_input_tokens
        }
        if (response.usage.cache_read_input_tokens) {
          this.totalUsage.cache_read_input_tokens =
            (this.totalUsage.cache_read_input_tokens || 0) +
            response.usage.cache_read_input_tokens
        }
        this.recordModelUsage(requestModel, response.usage)
        this.totalCost += estimateCost(requestModel, response.usage)
      }

      // Add assistant message to conversation
      this.messages.push({ role: 'assistant', content: response.content as any })

      // Yield assistant message
      yield {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: response.content as any,
        },
      }

      // Check for tool use before max_output_tokens recovery so tool protocols
      // always receive tool results immediately after assistant tool calls.
      const toolUseBlocks = response.content.filter(
        (block): block is ToolUseBlock => block.type === 'tool_use',
      )

      // Handle max_output_tokens recovery only for plain assistant output.
      if (
        toolUseBlocks.length === 0 &&
        response.stopReason === 'max_tokens' &&
        maxOutputRecoveryAttempts < MAX_OUTPUT_RECOVERY
      ) {
        maxOutputRecoveryAttempts++
        this.messages.push({
          role: 'user',
          content: 'Please continue from where you left off.',
        })
        continue
      }

      if (toolUseBlocks.length === 0) {
        this.activeSkill = undefined
        completedNormally = true
        break // No tool calls - agent is done
      }

      // Reset max_output recovery counter on successful tool use
      maxOutputRecoveryAttempts = 0

      // Execute tools while preserving model-requested ordering around mutations.
      const toolResults = await this.executeTools(toolUseBlocks)

      // Yield tool results
      for (const result of toolResults) {
        yield {
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
        }
      }

      // Add tool results to conversation
      this.messages.push({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.tool_use_id,
          content:
            typeof r.content === 'string'
              ? r.content
              : JSON.stringify(r.content),
          is_error: r.is_error,
        })),
      })

      if (response.stopReason === 'end_turn') {
        completedNormally = true
        break
      }
    }

    // Hook: Stop (end of agentic loop)
    await this.executeHooks('Stop')

    // Hook: SessionEnd
    await this.executeHooks('SessionEnd')

    // Yield enriched final result
    const endSubtype = budgetExceeded
      ? 'error_max_budget_usd'
      : completedNormally
        ? 'success'
        : 'error_max_turns'

    yield {
      type: 'result',
      subtype: endSubtype,
      session_id: this.sessionId,
      is_error: endSubtype !== 'success',
      num_turns: this.turnCount,
      total_cost_usd: this.totalCost,
      duration_api_ms: Math.round(this.apiTimeMs),
      usage: this.totalUsage,
      model_usage: this.getModelUsage(),
      permission_denials: this.trace.permission_denials,
      evidence: this.getEvidence(),
      quality_gates: this.getQualityGates(),
      trace: this.getTrace(),
      cost: this.totalCost,
    }
  }

  /**
   * Execute tool calls with concurrency control.
   *
   * Consecutive read-only concurrency-safe tools run concurrently (up to 10 at a time).
   * Mutation tools run sequentially and preserve model-requested ordering.
   */
  private async executeTools(
    toolUseBlocks: ToolUseBlock[],
  ): Promise<(ToolResult & { tool_name?: string })[]> {
    const context: ToolContext = {
      ...createToolContext(this.config),
      provider: this.provider,
      apiType: this.provider.apiType,
    }

    const maxConcurrency = getMaxToolConcurrency()
    const toolsForThisTurn = this.activeSkill
      ? filterToolsForSkill(this.config.tools, this.activeSkill.allowedTools)
      : this.config.tools
    const toolsByName = new Map(toolsForThisTurn.map((tool) => [tool.name, tool]))
    const results: (ToolResult & { tool_name?: string })[] = []
    let concurrentRun: Array<{ block: ToolUseBlock; tool?: ToolDefinition }> = []

    const flushConcurrentRun = async () => {
      for (let i = 0; i < concurrentRun.length; i += maxConcurrency) {
        const batch = concurrentRun.slice(i, i + maxConcurrency)
        this.trace.concurrency_batches.push(batch.length)
        const batchTraces: AgentRunToolTrace[] = []
        const batchResults = await Promise.all(
          batch.map((item, index) =>
            this.executeSingleTool(item.block, item.tool, context, (trace) => {
              batchTraces[index] = trace
            }),
          ),
        )
        this.trace.tools.push(...batchTraces)
        results.push(...batchResults)
      }
      concurrentRun = []
    }

    for (const block of toolUseBlocks) {
      const tool = toolsByName.get(block.name)
      if (canRunConcurrently(tool)) {
        concurrentRun.push({ block, tool })
        continue
      }

      await flushConcurrentRun()
      this.trace.concurrency_batches.push(1)
      results.push(await this.executeSingleTool(block, tool, context))
    }

    await flushConcurrentRun()

    return results
  }

  /**
   * Execute a single tool with permission checking.
   */
  private async executeSingleTool(
    block: ToolUseBlock,
    tool: ToolDefinition | undefined,
    context: ToolContext,
    recordTrace: ((trace: AgentRunToolTrace) => void) | true = true,
  ): Promise<ToolResult & { tool_name?: string }> {
    const start = performance.now()
    let result: ToolResult & { tool_name?: string } | undefined

    try {
      if (!tool) {
        result = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: Unknown tool "${block.name}"`,
          is_error: true,
          tool_name: block.name,
        }
        return result
      }

      // Check enabled
      if (tool.isEnabled && !tool.isEnabled(context)) {
        result = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: Tool "${block.name}" is not enabled`,
          is_error: true,
          tool_name: block.name,
        }
        return result
      }

      // Check permissions
      try {
        const permission = await this.config.policy.canUseTool(tool, block.input)
        if (permission.behavior === 'deny') {
          const reason = permission.message || `Permission denied for tool "${block.name}"`
          this.trace.permission_denials.push({ tool: block.name, reason })
          result = {
            type: 'tool_result',
            tool_use_id: block.id,
            content: reason,
            is_error: true,
            tool_name: block.name,
          }
          return result
        }
        if (permission.updatedInput !== undefined) {
          block = { ...block, input: permission.updatedInput }
        }
      } catch (err: any) {
        const reason = `Permission check error: ${err.message}`
        this.trace.permission_denials.push({ tool: block.name, reason })
        result = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: reason,
          is_error: true,
          tool_name: block.name,
        }
        return result
      }

      // Hook: PreToolUse
      const preHookResults = await this.executeHooks('PreToolUse', {
        toolName: block.name,
        toolInput: block.input,
        toolUseId: block.id,
      })
      // Check if any hook blocks this tool
      if (preHookResults.some((r) => r.block)) {
        const msg = preHookResults.find((r) => r.message)?.message || 'Blocked by PreToolUse hook'
        result = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: msg,
          is_error: true,
          tool_name: block.name,
        }
        return result
      }

      // Execute the tool
      try {
        const toolResult = await tool.call(block.input, context)
        if (toolResult.evidence) {
          this.evidence.push(...toolResult.evidence)
        }
        if (toolResult.quality_gates) {
          this.qualityGates.push(...toolResult.quality_gates)
        }

        const activation = tool.name === 'Skill' ? parseSkillActivation(toolResult) : undefined
        if (activation?.status === 'inline') {
          this.activeSkill = activation
        }

        // Hook: PostToolUse
        await this.executeHooks('PostToolUse', {
          toolName: block.name,
          toolInput: block.input,
          toolOutput: typeof toolResult.content === 'string' ? toolResult.content : JSON.stringify(toolResult.content),
          toolUseId: block.id,
        })

        result = { ...toolResult, tool_use_id: block.id, tool_name: block.name }
        return result
      } catch (err: any) {
        // Hook: PostToolUseFailure
        await this.executeHooks('PostToolUseFailure', {
          toolName: block.name,
          toolInput: block.input,
          toolUseId: block.id,
          error: err.message,
        })

        result = {
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Tool execution error: ${err.message}`,
          is_error: true,
          tool_name: block.name,
        }
        return result
      }
    } finally {
      const trace = {
        tool_use_id: block.id,
        tool_name: block.name,
        duration_ms: Math.round(performance.now() - start),
        is_error: result?.is_error === true,
        concurrency_safe: canRunConcurrently(tool),
      }
      if (recordTrace === true) {
        this.trace.tools.push(trace)
      } else {
        recordTrace(trace)
      }
    }
  }

  /**
   * Get current messages for session persistence.
   */
  getMessages(): NormalizedMessageParam[] {
    return [...this.messages]
  }

  /**
   * Get total usage across all turns.
   */
  getUsage(): TokenUsage {
    return { ...this.totalUsage }
  }

  /**
   * Get total cost.
   */
  getCost(): number {
    return this.totalCost
  }

  /**
   * Get a defensive copy of usage grouped by the actual model used per turn.
   */
  getModelUsage(): Record<string, { input_tokens: number; output_tokens: number }> {
    const usage: Record<string, { input_tokens: number; output_tokens: number }> = {}
    for (const [model, value] of Object.entries(this.modelUsage)) {
      usage[model] = { ...value }
    }
    return usage
  }

  /**
   * Get a defensive copy of run evidence.
   */
  getEvidence(): Evidence[] {
    return this.evidence.map((entry) => {
      const copy: Evidence = { ...entry }
      if (entry.metadata) copy.metadata = { ...entry.metadata }
      return copy
    })
  }

  /**
   * Get a defensive copy of quality gate results.
   */
  getQualityGates(): QualityGateResult[] {
    return this.qualityGates.map((gate) => {
      const copy: QualityGateResult = { ...gate }
      if (gate.evidence) {
        copy.evidence = gate.evidence.map((entry) => {
          const evidence: Evidence = { ...entry }
          if (entry.metadata) evidence.metadata = { ...entry.metadata }
          return evidence
        })
      }
      if (gate.metadata) copy.metadata = { ...gate.metadata }
      return copy
    })
  }

  /**
   * Get a defensive copy of the run trace.
   */
  getTrace(): AgentRunTrace {
    return {
      turns: this.trace.turns.map((turn) => ({ ...turn })),
      tools: this.trace.tools.map((tool) => ({ ...tool })),
      concurrency_batches: [...this.trace.concurrency_batches],
      retry_count: this.trace.retry_count,
      compaction_count: this.trace.compaction_count,
      permission_denials: this.trace.permission_denials.map((denial) => ({ ...denial })),
    }
  }
}
