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

import {
  AGENT_RUN_TRACE_SCHEMA_VERSION,
  SDK_EVENT_SCHEMA_VERSION,
  type SDKMessage,
  type QueryEngineConfig,
  type ToolDefinition,
  type ToolResult,
  type ToolContext,
  type TokenUsage,
  type QualityGatePolicy,
  type AgentRunTrace,
  type AgentRunToolTrace,
  type Evidence,
  type QualityGateResult,
  type AgentRunMemoryTrace,
  type AgentRunMemorySelectionTrace,
  type AgentRunPolicyDecisionTrace,
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
  compactConversation,
  createAutoCompactState,
  type AutoCompactState,
} from './utils/compact.js'
import {
  isPromptTooLongError,
} from './utils/retry.js'
import { GuardrailAbortError } from './guardrails/errors.js'
import type {
  GuardrailEvaluation,
  ToolGuardrailAction,
  ToolGuardrailPhase,
} from './guardrails/types.js'
import type { HookRegistry, HookInput, HookOutput } from './hooks.js'
import {
  canRunConcurrently,
  planToolDispatch,
  resolveMaxToolConcurrency,
  summarizeToolInput,
  summarizeToolSafety,
} from './engine/tool-helpers.js'
import {
  filterToolsForSkill,
  parseSkillActivation,
  type SkillActivation,
} from './engine/skill-helpers.js'
import {
  buildSystemPrompt,
  createToolContext,
  getAutonomyMode,
} from './engine/prompt-helpers.js'
import {
  buildPhaseMessage,
  buildPendingInputMessage,
} from './engine/message-helpers.js'
import {
  findTerminalQualityGateFailure,
  resolveActiveQualityGatePolicy,
} from './engine/quality-gate-helpers.js'
import {
  applyMicroCompactForApi,
  maybeAutoCompactBeforeTurn,
} from './engine/compact-stage.js'
import { buildTurnRequest } from './engine/turn-request.js'
import { runResilientCall } from './engine/resilient-call.js'

// ============================================================================
// ToolUseBlock (internal type for extracted tool_use blocks)
// ============================================================================

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
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
  private trace: AgentRunTrace
  private readonly maxToolConcurrency: number
  private compactState: AutoCompactState
  private sessionId: string
  private apiTimeMs = 0
  private hookRegistry?: HookRegistry
  private activeSkill?: SkillActivation
  private requiredSkillQualityGates: string[] = []
  private forkedSkills: SkillActivation[] = []
  private evidence: Evidence[] = []
  private qualityGates: QualityGateResult[] = []

  constructor(config: QueryEngineConfig) {
    this.config = { ...config, runtimeNamespace: config.runtimeNamespace ?? config.sessionId }
    const toolConcurrency = resolveMaxToolConcurrency(config.maxToolConcurrency)
    this.maxToolConcurrency = toolConcurrency.limit
    this.trace = {
      schema_version: AGENT_RUN_TRACE_SCHEMA_VERSION,
      turns: [],
      tools: [],
      concurrency_batches: [],
      tool_concurrency_limit: toolConcurrency.limit,
      tool_concurrency_source: toolConcurrency.source,
      retry_count: 0,
      compaction_count: 0,
      compactions: [],
      permission_denials: [],
      policy_decisions: [],
      memory: [],
    }
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

  private recordPolicyDecision(input: Omit<AgentRunPolicyDecisionTrace, 'timestamp' | 'permission_mode' | 'autonomy_mode' | 'safety'> & { tool: ToolDefinition }): void {
    const { tool, ...entry } = input
    this.trace.policy_decisions ??= []
    this.trace.policy_decisions.push({
      ...entry,
      timestamp: new Date().toISOString(),
      permission_mode: this.config.policy.permissionMode,
      autonomy_mode: getAutonomyMode(this.config),
      safety: summarizeToolSafety(tool),
    })
  }

  /**
   * Submit a user message and run the agentic loop.
   * Yields SDKMessage events as the agent works.
   */
  async *submitMessage(
    prompt: string | any[],
  ): AsyncGenerator<SDKMessage> {
    const runId = crypto.randomUUID()

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
        schema_version: SDK_EVENT_SCHEMA_VERSION,
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
    const builtSystemPrompt = await buildSystemPrompt(this.config)
    const systemPrompt = builtSystemPrompt.systemPrompt
    this.trace.memory?.push(builtSystemPrompt.memoryTrace)

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
      autonomy_mode: getAutonomyMode(this.config),
    } as SDKMessage

    yield buildPhaseMessage(this.sessionId, runId, 'intake')
    yield buildPhaseMessage(this.sessionId, runId, 'context')

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

      // Auto-compact if context is too large (Slice K1: extracted helper).
      const compacted = await maybeAutoCompactBeforeTurn({
        provider: this.provider,
        model: this.config.model,
        messages: this.messages,
        state: this.compactState,
        abortSignal: this.config.abortSignal,
        trace: this.trace,
        onPreCompact: () => this.executeHooks('PreCompact').then(() => undefined),
        onPostCompact: () => this.executeHooks('PostCompact').then(() => undefined),
      })
      this.messages = compacted.messages
      this.compactState = compacted.state

      // Micro-compact: truncate large tool results
      const apiMessages = applyMicroCompactForApi(this.messages)

      this.turnCount++
      turnsRemaining--

      // Streaming wiring (P0-4 Phase 2). When `includePartialMessages` is on,
      // hand the provider a text-delta callback that pushes into a local
      // queue; the generator drains the queue concurrently with the model
      // call so the host sees deltas as they arrive. Without this flag the
      // queue stays empty and the provider takes its non-streaming path.
      const partialQueue: string[] = []
      let partialResolve: (() => void) | null = null
      const wantStreaming = this.config.includePartialMessages === true
      const releaseDrain = (): void => {
        if (partialResolve) {
          const r = partialResolve
          partialResolve = null
          r()
        }
      }

      // Build request (Slice K1: extracted helper — skill scope, model,
      // tools, streaming callback, and outputSchema routing all live there).
      const turnRequest = buildTurnRequest({
        config: this.config,
        provider: this.provider,
        systemPrompt,
        apiMessages,
        activeSkill: this.activeSkill,
        partialQueue,
        releaseDrain,
      })
      const { requestModel, fallbackModel, createModelMessage } = turnRequest

      // Make API call with retry via provider
      let response!: CreateMessageResponse
      let apiAttempts = 0
      const apiStart = performance.now()

      let successfulModel = requestModel
      yield buildPhaseMessage(this.sessionId, runId, 'model_request', this.turnCount)
      try {
        // Kick off the model call (with retry + fallback) as a background task
        // so the generator can drain streaming partials while it is in flight.
        // Slice K2 / P1-4: retry + fallback + category guards all live in
        // runResilientCall now — this block only owns the streaming drain.
        let modelDone = false
        let modelErr: unknown
        const modelTask = (async () => {
          try {
            const outcome = await runResilientCall({
              primaryModel: requestModel,
              fallbackModel,
              abortSignal: this.config.abortSignal,
              call: createModelMessage,
              onAttempt: () => { apiAttempts += 1 },
            })
            response = outcome.response
            successfulModel = outcome.model
          } catch (err) {
            modelErr = err
          } finally {
            modelDone = true
            releaseDrain()
          }
        })()

        // Drain partial text deltas until the model task resolves.
        if (wantStreaming) {
          while (!modelDone || partialQueue.length > 0) {
            if (partialQueue.length === 0) {
              await new Promise<void>((resolve) => {
                partialResolve = resolve
              })
              continue
            }
            const delta = partialQueue.shift()!
            yield {
              type: 'partial_message',
              partial: { type: 'text', text: delta },
            }
          }
        }

        await modelTask
        if (modelErr) throw modelErr
        this.trace.retry_count += Math.max(0, apiAttempts - 1)
        yield buildPhaseMessage(this.sessionId, runId, 'model_response', this.turnCount)
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
              { trigger: 'prompt_too_long' },
            )
            this.messages = result.compactedMessages as NormalizedMessageParam[]
            this.compactState = result.state
            this.trace.compaction_count += 1
            this.trace.compactions?.push(result.trace)
            turnsRemaining++ // Retry this turn
            this.turnCount--
            continue
          } catch {
            // Can't compact, give up
          }
        }

        yield {
          type: 'result',
          schema_version: SDK_EVENT_SCHEMA_VERSION,
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
        this.recordModelUsage(successfulModel, response.usage)
        this.totalCost += estimateCost(successfulModel, response.usage)
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
        // Mirror the compact-retry path: recovery is a continuation of the
        // same logical turn, so refund the turn we just spent. Otherwise
        // recovery on the final turn would silently no-op.
        turnsRemaining++
        this.turnCount--
        continue
      }

      if (toolUseBlocks.length === 0) {
        completedNormally = true
        break // No tool calls - agent is done
      }

      // Reset max_output recovery counter on successful tool use
      maxOutputRecoveryAttempts = 0

      for (const block of toolUseBlocks) {
        yield buildPhaseMessage(this.sessionId, runId, 'tool_execution', this.turnCount, block.id)
      }

      // Execute tools while preserving model-requested ordering around mutations.
      let toolResults: (ToolResult & { tool_name?: string })[]
      try {
        toolResults = await this.executeTools(toolUseBlocks)
      } catch (err) {
        // RFC D2 — onToolViolation('abort') terminates the run with a
        // dedicated subtype so callers can distinguish it from other
        // failures.
        if (err instanceof GuardrailAbortError) {
          yield {
            type: 'result',
            schema_version: SDK_EVENT_SCHEMA_VERSION,
            subtype: 'error_guardrail_abort',
            session_id: this.sessionId,
            is_error: true,
            usage: this.totalUsage,
            num_turns: this.turnCount,
            total_cost_usd: this.totalCost,
            duration_api_ms: Math.round(this.apiTimeMs),
            model_usage: this.getModelUsage(),
            permission_denials: this.trace.permission_denials,
            evidence: this.getEvidence(),
            quality_gates: this.getQualityGates(),
            trace: this.getTrace(),
            errors: [err.message],
            cost: this.totalCost,
          }
          return
        }
        throw err
      }

      // Yield tool results
      for (const result of toolResults) {
        const pendingInputMessage = buildPendingInputMessage(this.sessionId, runId, result)
        if (pendingInputMessage) yield pendingInputMessage
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
    const baseSubtype = budgetExceeded
      ? 'error_max_budget_usd'
      : completedNormally
        ? 'success'
        : 'error_max_turns'
    const gateFailure = baseSubtype === 'success' ? this.getTerminalQualityGateFailure() : undefined
    const endSubtype = gateFailure ? 'error_quality_gate_failed' : baseSubtype
    const errors = gateFailure
      ? [`Required quality gate failed: ${gateFailure.name}${gateFailure.summary ? ` - ${gateFailure.summary}` : ''}`]
      : undefined

    yield buildPhaseMessage(this.sessionId, runId, 'verification')
    yield buildPhaseMessage(this.sessionId, runId, 'finalize')

    yield {
      type: 'result',
      schema_version: SDK_EVENT_SCHEMA_VERSION,
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
      errors,
      cost: this.totalCost,
    }
  }

  private getActiveQualityGatePolicy(): QualityGatePolicy | undefined {
    return resolveActiveQualityGatePolicy(
      this.config.qualityGatePolicy,
      this.requiredSkillQualityGates,
    )
  }

  private getTerminalQualityGateFailure(): QualityGateResult | undefined {
    return findTerminalQualityGateFailure(
      this.getActiveQualityGatePolicy(),
      this.qualityGates,
    )
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
    const maxConcurrency = this.maxToolConcurrency
    const toolsForThisTurn = this.activeSkill
      ? filterToolsForSkill(this.config.tools, this.activeSkill.allowedTools)
      : this.config.tools
    const context = createToolContext(this.config, toolsForThisTurn)
    const toolsByName = new Map(toolsForThisTurn.map((tool) => [tool.name, tool]))
    const results: (ToolResult & { tool_name?: string })[] = []

    // Slice H — delegate order-preserving concurrent grouping to the
    // pure `planToolDispatch` helper so the algorithm is separately
    // testable. Semantics are identical to the previous inline loop:
    // concurrent-safe runs fan out in Promise.all batches bounded by
    // `maxConcurrency`; non-concurrent tools are serial singletons.
    const plan = planToolDispatch(toolUseBlocks, (name) => toolsByName.get(name))

    for (const batch of plan) {
      if (batch.kind === 'serial') {
        const { block, tool } = batch.entries[0]!
        this.trace.concurrency_batches.push(1)
        results.push(await this.executeSingleTool(block, tool, context))
        continue
      }

      for (let i = 0; i < batch.entries.length; i += maxConcurrency) {
        const slice = batch.entries.slice(i, i + maxConcurrency)
        this.trace.concurrency_batches.push(slice.length)
        const batchTraces: AgentRunToolTrace[] = []
        const batchResults = await Promise.all(
          slice.map((item, index) =>
            this.executeSingleTool(item.block, item.tool, context, (trace) => {
              batchTraces[index] = trace
            }),
          ),
        )
        this.trace.tools.push(...batchTraces)
        results.push(...batchResults)
      }
    }

    return results
  }

  /**
   * Format violation messages for the denied-ToolResult content.
   */
  private formatViolations(evaluation: GuardrailEvaluation): string {
    return evaluation.violations.map((v) => v.message ?? v.guardrail).join('; ')
  }

  /**
   * Resolve the tool-scope guardrail action for a failed evaluation (RFC D2).
   * Default = `'skip'`. Callback returns one of `'abort' | 'skip' | 'continue'`;
   * throwing → `'abort'` (mirrors graph `onViolation`).
   */
  private async resolveToolGuardrailAction(
    evaluation: GuardrailEvaluation,
    toolName: string,
    phase: ToolGuardrailPhase,
  ): Promise<ToolGuardrailAction> {
    const cb = this.config.onToolViolation
    if (!cb) return 'skip'
    try {
      const action = await cb(evaluation, { toolName, phase })
      if (action === 'abort' || action === 'skip' || action === 'continue') {
        return action
      }
      // Unknown return value → safe default = skip.
      return 'skip'
    } catch {
      return 'abort'
    }
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
        const source = permission.source ?? 'host_canUseTool'
        if (permission.behavior === 'deny') {
          const reason = permission.message || `Permission denied for tool "${block.name}"`
          this.trace.permission_denials.push({ tool: block.name, reason })
          this.recordPolicyDecision({
            tool,
            tool_use_id: block.id,
            tool_name: block.name,
            behavior: 'deny',
            source,
            reason,
            input_summary: summarizeToolInput(block.input),
            input_rewritten: false,
          })
          result = {
            type: 'tool_result',
            tool_use_id: block.id,
            content: reason,
            is_error: true,
            tool_name: block.name,
          }
          return result
        }
        this.recordPolicyDecision({
          tool,
          tool_use_id: block.id,
          tool_name: block.name,
          behavior: 'allow',
          source,
          reason: permission.message,
          input_summary: summarizeToolInput(block.input),
          updated_input_summary: permission.updatedInput === undefined ? undefined : summarizeToolInput(permission.updatedInput),
          input_rewritten: permission.updatedInput !== undefined,
        })
        if (permission.updatedInput !== undefined) {
          block = { ...block, input: permission.updatedInput }
        }
      } catch (err: any) {
        const reason = `Permission check error: ${err.message}`
        this.trace.permission_denials.push({ tool: block.name, reason })
        this.recordPolicyDecision({
          tool,
          tool_use_id: block.id,
          tool_name: block.name,
          behavior: 'deny',
          source: 'policy_error',
          reason,
          input_summary: summarizeToolInput(block.input),
          input_rewritten: false,
        })
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
        this.recordPolicyDecision({
          tool,
          tool_use_id: block.id,
          tool_name: block.name,
          behavior: 'deny',
          source: 'hook',
          reason: msg,
          input_summary: summarizeToolInput(block.input),
          input_rewritten: false,
        })
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
        // v3.4 Guardrails — tool_input scope (RFC D1+D2: skip-by-default;
        // onToolViolation callback may override with 'abort' or 'continue').
        if (this.config.guardrails) {
          const evalIn = await this.config.guardrails.evaluate(
            'tool_input',
            block.input,
            { toolName: block.name },
          )
          if (this.config.trace) {
            try {
              this.config.trace.appendGuardrail('tool_input', evalIn, { toolName: block.name })
            } catch {
              // Telemetry must never break a run.
            }
          }
          if (!evalIn.passed) {
            const action = await this.resolveToolGuardrailAction(evalIn, block.name, 'request')
            if (action === 'abort') {
              throw new GuardrailAbortError(
                `Guardrail aborted tool input for "${block.name}": ${this.formatViolations(evalIn)}`,
                evalIn,
                block.name,
                'request',
              )
            }
            if (action === 'skip') {
              result = {
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Guardrail denied tool input: ${this.formatViolations(evalIn)}`,
                is_error: true,
                tool_name: block.name,
              }
              return result
            }
            // 'continue' → fall through, call the tool anyway (audit-only).
          }
        }

        const toolResult = await tool.call(block.input, context)

        // v3.4 Guardrails — tool_output scope
        if (this.config.guardrails) {
          const evalOut = await this.config.guardrails.evaluate(
            'tool_output',
            toolResult.content,
            { toolName: block.name },
          )
          if (this.config.trace) {
            try {
              this.config.trace.appendGuardrail('tool_output', evalOut, { toolName: block.name })
            } catch {
              // Telemetry must never break a run.
            }
          }
          if (!evalOut.passed) {
            const action = await this.resolveToolGuardrailAction(evalOut, block.name, 'response')
            if (action === 'abort') {
              throw new GuardrailAbortError(
                `Guardrail aborted tool output for "${block.name}": ${this.formatViolations(evalOut)}`,
                evalOut,
                block.name,
                'response',
              )
            }
            if (action === 'skip') {
              result = {
                type: 'tool_result',
                tool_use_id: block.id,
                content: `Guardrail denied tool output: ${this.formatViolations(evalOut)}`,
                is_error: true,
                tool_name: block.name,
              }
              return result
            }
            // 'continue' → fall through, pass original result through (audit-only).
          }
        }

        if (toolResult.evidence) {
          this.evidence.push(...toolResult.evidence)
        }
        if (toolResult.quality_gates) {
          this.qualityGates.push(...toolResult.quality_gates)
        }

        const activation = tool.name === 'Skill' ? parseSkillActivation(toolResult) : undefined
        if (activation) {
          // Required quality gates from the activation are part of this turn's
          // contract whether the skill ran inline or forked into a subagent.
          // Without this, forked skills could declare gates that the parent
          // turn never enforces.
          const requiredGateNames = activation.qualityGates
            ?.filter((gate) => gate.required !== false)
            .map((gate) => gate.name) ?? []
          if (requiredGateNames.length > 0) {
            this.requiredSkillQualityGates = [
              ...new Set([...this.requiredSkillQualityGates, ...requiredGateNames]),
            ]
          }

          if (activation.status === 'inline') {
            this.activeSkill = activation
          } else if (activation.status === 'forked') {
            this.forkedSkills.push(activation)
          }
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
        // GuardrailAbortError must bubble past the per-tool catch so the
        // engine top-level can terminate the run. Other tool errors stay
        // contained as `is_error: true` results (current behavior).
        if (err instanceof GuardrailAbortError) {
          throw err
        }

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
        // When an exception unwinds (e.g. GuardrailAbortError) `result` is
        // undefined; record the call as errored so trace consumers see it.
        is_error: result === undefined ? true : result.is_error === true,
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
      schema_version: this.trace.schema_version,
      turns: this.trace.turns.map((turn) => ({ ...turn })),
      tools: this.trace.tools.map((tool) => ({ ...tool })),
      concurrency_batches: [...this.trace.concurrency_batches],
      tool_concurrency_limit: this.trace.tool_concurrency_limit,
      tool_concurrency_source: this.trace.tool_concurrency_source,
      retry_count: this.trace.retry_count,
      compaction_count: this.trace.compaction_count,
      compactions: this.trace.compactions?.map((compaction) => ({ ...compaction })),
      permission_denials: this.trace.permission_denials.map((denial) => ({ ...denial })),
      policy_decisions: (this.trace.policy_decisions ?? []).map((decision) => ({
        ...decision,
        input_summary: { ...decision.input_summary, keys: decision.input_summary.keys ? [...decision.input_summary.keys] : undefined },
        updated_input_summary: decision.updated_input_summary ? {
          ...decision.updated_input_summary,
          keys: decision.updated_input_summary.keys ? [...decision.updated_input_summary.keys] : undefined,
        } : undefined,
        safety: { ...decision.safety },
      })),
      memory: this.trace.memory?.map((entry) => {
        const memoryEntry: AgentRunMemoryTrace = {
          ...entry,
          selected_ids: [...entry.selected_ids],
          selected: entry.selected?.map((selection) => {
            const selectionCopy: AgentRunMemorySelectionTrace = { ...selection }
            if (selection.score_reasons) selectionCopy.score_reasons = [...selection.score_reasons]
            if (selection.score_components) selectionCopy.score_components = selection.score_components.map((component) => ({ ...component }))
            if (selection.matched_fields) selectionCopy.matched_fields = [...selection.matched_fields]
            if (selection.tags) selectionCopy.tags = [...selection.tags]
            return selectionCopy
          }),
          retrieval_steps: entry.retrieval_steps?.map((step) => {
            const stepCopy = { ...step }
            if (step.filters) {
              stepCopy.filters = { ...step.filters }
              if (step.filters.tags) stepCopy.filters.tags = [...step.filters.tags]
            }
            return stepCopy
          }),
        }
        if (entry.filters) {
          memoryEntry.filters = { ...entry.filters }
          if (entry.filters.tags) memoryEntry.filters.tags = [...entry.filters.tags]
        }
        if (entry.store) memoryEntry.store = { ...entry.store }
        return memoryEntry
      }),
    }
  }
}
