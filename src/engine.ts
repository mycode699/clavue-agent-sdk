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
import {
  recordTurnUsage,
  tryCompactOnPromptTooLong,
} from './engine/turn-bookkeeping.js'
import {
  buildErrorResultEvent,
  buildFinalResultEvent,
} from './engine/result-events.js'
import {
  buildToolResultEvents,
  buildToolResultsUserMessage,
} from './engine/tool-results.js'
import { executeDispatchPlan } from './engine/dispatch-executor.js'
import {
  buildConcurrencyController,
  type ConcurrencyController,
} from './engine/concurrency-controller.js'
import {
  applyGuardrailToolPhase,
  buildErrorToolResult,
  ingestToolSideEffects,
} from './engine/single-tool-helpers.js'
import { ToolResultCache } from './engine/tool-result-cache.js'

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
  private readonly concurrencyController: ConcurrencyController
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
    this.concurrencyController = buildConcurrencyController(
      config.adaptiveToolConcurrency,
      toolConcurrency.limit,
    )
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
      yield buildErrorResultEvent({
        subtype: 'error_during_execution',
        sessionId: this.sessionId,
        totalUsage: this.totalUsage,
        numTurns: 0,
        totalCost: 0,
        durationApiMs: 0,
        modelUsage: this.getModelUsage(),
        permissionDenials: this.trace.permission_denials,
        evidence: this.getEvidence(),
        qualityGates: this.getQualityGates(),
        trace: this.getTrace(),
        errors: ['Blocked by UserPromptSubmit hook'],
      })
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
        // Handle prompt-too-long by compacting (Slice K3: extracted helper).
        if (isPromptTooLongError(err)) {
          const recovery = await tryCompactOnPromptTooLong({
            provider: this.provider,
            model: this.config.model,
            messages: this.messages,
            state: this.compactState,
            abortSignal: this.config.abortSignal,
            trace: this.trace,
          })
          if (recovery.recovered) {
            this.messages = recovery.messages
            this.compactState = recovery.state
            turnsRemaining++ // Retry this turn
            this.turnCount--
            continue
          }
          // Fall through to error result if compact didn't recover.
        }

        yield buildErrorResultEvent({
          subtype: 'error',
          sessionId: this.sessionId,
          totalUsage: this.totalUsage,
          numTurns: this.turnCount,
          totalCost: this.totalCost,
          durationApiMs: this.apiTimeMs + performance.now() - apiStart,
          modelUsage: this.getModelUsage(),
          permissionDenials: this.trace.permission_denials,
          evidence: this.getEvidence(),
          qualityGates: this.getQualityGates(),
          trace: this.getTrace(),
          errors: [err?.message || String(err)],
        })
        return
      }

      // Track API timing
      const turnApiTimeMs = performance.now() - apiStart
      this.apiTimeMs += turnApiTimeMs

      // Slice K3: per-turn usage / cost / trace bookkeeping is now a pure
      // helper. Mutates trace, totalUsage, modelUsage in place; returns the
      // new total cost so the engine keeps its scalar state.
      const usageResult = recordTurnUsage({
        response,
        successfulModel,
        turnApiTimeMs,
        trace: this.trace,
        totalUsage: this.totalUsage,
        totalCost: this.totalCost,
        modelUsage: this.modelUsage,
        turnCount: this.turnCount,
      })
      this.totalCost = usageResult.totalCost

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
          yield buildErrorResultEvent({
            subtype: 'error_guardrail_abort',
            sessionId: this.sessionId,
            totalUsage: this.totalUsage,
            numTurns: this.turnCount,
            totalCost: this.totalCost,
            durationApiMs: this.apiTimeMs,
            modelUsage: this.getModelUsage(),
            permissionDenials: this.trace.permission_denials,
            evidence: this.getEvidence(),
            qualityGates: this.getQualityGates(),
            trace: this.getTrace(),
            errors: [err.message],
          })
          return
        }
        throw err
      }

      // Yield tool results + record them in conversation history (Slice K4a).
      for (const event of buildToolResultEvents(this.sessionId, runId, toolResults)) {
        yield event
      }
      this.messages.push(buildToolResultsUserMessage(toolResults))

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

    yield buildFinalResultEvent({
      subtype: endSubtype,
      sessionId: this.sessionId,
      numTurns: this.turnCount,
      totalCost: this.totalCost,
      durationApiMs: this.apiTimeMs,
      totalUsage: this.totalUsage,
      modelUsage: this.getModelUsage(),
      permissionDenials: this.trace.permission_denials,
      evidence: this.getEvidence(),
      qualityGates: this.getQualityGates(),
      trace: this.getTrace(),
      errors,
    })
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

    // Slice H — order-preserving concurrent grouping (pure helper).
    const plan = planToolDispatch(toolUseBlocks, (name) => toolsByName.get(name))

    // Tier A #1 — turn-scoped tool result cache. Built fresh per turn so
    // two model-emitted tool_use blocks that ask for the same read with
    // the same input share one `tool.call()`. Cache is only consulted for
    // tools that declare `isReadOnly() && isConcurrencySafe()`.
    const toolCache = new ToolResultCache()

    // Slice K4c — batch execution + trace bookkeeping (pure helper, the
    // single-tool runner is injected so policy/hook/guardrail logic stays
    // local to the engine).
    const results = await executeDispatchPlan<ToolUseBlock>({
      plan,
      context,
      trace: this.trace,
      maxConcurrency,
      concurrencyController: this.concurrencyController,
      executeSingle: (block, tool, ctx, recordTrace) =>
        this.executeSingleTool(block, tool, ctx, recordTrace, toolCache),
    })

    // Merge per-turn cache counters into the run-level aggregate. Only
    // surface the trace field when at least one lookup happened (keeps
    // traces that never saw a tool call unchanged).
    const { hits, misses } = toolCache.stats()
    if (hits > 0 || misses > 0) {
      const prev = this.trace.tool_cache
      this.trace.tool_cache = prev
        ? { hits: prev.hits + hits, misses: prev.misses + misses }
        : { hits, misses }
    }

    // Tier A #2 — refresh adaptive concurrency snapshot after every turn.
    // The static no-op controller returns `undefined`, so default-mode
    // traces stay byte-identical with prior versions.
    const adaptiveSnapshot = this.concurrencyController.snapshot()
    if (adaptiveSnapshot) {
      this.trace.tool_concurrency_adaptive = adaptiveSnapshot
    }

    return results
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
    toolCache?: ToolResultCache,
  ): Promise<ToolResult & { tool_name?: string }> {
    const start = performance.now()
    let result: ToolResult & { tool_name?: string } | undefined

    try {
      if (!tool) {
        result = buildErrorToolResult(block, `Error: Unknown tool "${block.name}"`)
        return result
      }

      // Check enabled
      if (tool.isEnabled && !tool.isEnabled(context)) {
        result = buildErrorToolResult(block, `Error: Tool "${block.name}" is not enabled`)
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
          result = buildErrorToolResult(block, reason)
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
        result = buildErrorToolResult(block, reason)
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
        result = buildErrorToolResult(block, msg)
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
          const outcome = await applyGuardrailToolPhase({
            evaluation: evalIn,
            block,
            phase: 'request',
            resolveAction: (e, n, p) => this.resolveToolGuardrailAction(e, n, p),
          })
          if (outcome.kind === 'skip') {
            result = outcome.result
            return result
          }
          // 'pass' or 'continue' → fall through.
        }

        // Tier A #1 — turn-scoped tool result cache. Only consult the
        // cache for tools that declare `isReadOnly() && isConcurrencySafe()`
        // — everything else (writes, side-effecting tools, host plugins
        // without those hints) bypasses entirely. `getOrCompute` dedupes
        // both sequential and concurrent duplicate calls; on a hit we
        // skip downstream side effects (PostToolUse hook, evidence
        // ingestion, skill activation) — those already ran when the
        // result was first produced, and re-firing them per duplicate
        // tool_use would double-count evidence/quality_gates.
        const cacheable = tool.isReadOnly?.() === true && tool.isConcurrencySafe?.() === true
        let toolResult: ToolResult
        let fromCache = false
        if (cacheable && toolCache) {
          const outcome = await toolCache.getOrCompute(
            block.name,
            block.input,
            () => tool.call(block.input, context),
          )
          toolResult = outcome.result
          fromCache = outcome.cached
          // v3.3 tracing — emit per-call cache event so OTel/JSONL streams
          // get real-time hit/miss visibility, not just the run aggregate.
          if (this.config.trace) {
            try {
              this.config.trace.appendToolCache({
                toolName: block.name,
                toolUseId: block.id,
                outcome: fromCache ? 'hit' : 'miss',
              })
            } catch {
              // Telemetry must never break a run.
            }
          }
        } else {
          toolResult = await tool.call(block.input, context)
        }

        if (fromCache) {
          // Cached result still needs to be echoed to the model with this
          // tool_use_id, but evidence / hooks / guardrail_output already
          // ran for the producing call.
          result = { ...toolResult, tool_use_id: block.id, tool_name: block.name }
          return result
        }

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
          const outcome = await applyGuardrailToolPhase({
            evaluation: evalOut,
            block,
            phase: 'response',
            resolveAction: (e, n, p) => this.resolveToolGuardrailAction(e, n, p),
          })
          if (outcome.kind === 'skip') {
            result = outcome.result
            return result
          }
          // 'pass' or 'continue' → fall through.
        }

        // Slice K5: side-effect ingestion (evidence/quality_gates/skill).
        const skillOutcome = ingestToolSideEffects(
          toolResult,
          this.evidence,
          this.qualityGates,
          parseSkillActivation,
          tool.name,
        )
        if (skillOutcome.requiredGateNames.length > 0) {
          this.requiredSkillQualityGates = [
            ...new Set([...this.requiredSkillQualityGates, ...skillOutcome.requiredGateNames]),
          ]
        }
        if (skillOutcome.activeSkill) this.activeSkill = skillOutcome.activeSkill
        if (skillOutcome.forked) this.forkedSkills.push(skillOutcome.forked)

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

        result = buildErrorToolResult(block, `Tool execution error: ${err.message}`)
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
      tool_cache: this.trace.tool_cache ? { ...this.trace.tool_cache } : undefined,
      tool_concurrency_adaptive: this.trace.tool_concurrency_adaptive
        ? {
            ...this.trace.tool_concurrency_adaptive,
            adjustments: this.trace.tool_concurrency_adaptive.adjustments.map((a) => ({ ...a })),
          }
        : undefined,
    }
  }
}
