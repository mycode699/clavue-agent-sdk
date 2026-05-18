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
  type TokenUsage,
  type QualityGatePolicy,
  type AgentRunTrace,
  type Evidence,
  type QualityGateResult,
  type AgentRunMemoryTrace,
  type AgentRunMemorySelectionTrace,
  type AgentRunPolicyDecisionTrace,
} from './types.js'
import type {
  LLMProvider,
  NormalizedMessageParam,
  NormalizedTool,
} from './providers/types.js'
import {
  createAutoCompactState,
  type AutoCompactState,
} from './utils/compact.js'
import type { HookRegistry, HookInput, HookOutput } from './hooks.js'
import {
  resolveMaxToolConcurrency,
  summarizeToolSafety,
} from './engine/tool-helpers.js'
import { type SkillActivation } from './engine/skill-helpers.js'
import { getAutonomyMode } from './engine/prompt-helpers.js'
import {
  findTerminalQualityGateFailure,
  resolveActiveQualityGatePolicy,
} from './engine/quality-gate-helpers.js'
import {
  buildConcurrencyController,
  type ConcurrencyController,
} from './engine/concurrency-controller.js'
import {
  executeToolsImpl,
  type ExecuteToolsDeps,
} from './engine/execute-tools.js'
import {
  runSubmitMessage,
  type RunState,
  type RunSubmitMessageDeps,
} from './engine/run-submit-message.js'
import {
  cloneEvidence,
  cloneModelUsage,
  cloneQualityGates,
  cloneTrace,
} from './engine/getters.js'

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
      // Telemetry sink — fires only when adaptive mode is on AND the
      // limit actually moves. Static mode never reaches this callback.
      config.trace
        ? (adjustment) => {
            try {
              config.trace!.appendToolConcurrencyAdjust({
                batchIndex: adjustment.batch_index,
                previous: adjustment.previous,
                current: adjustment.current,
                reason: adjustment.reason,
              })
            } catch {
              // Telemetry must never break a run.
            }
          }
        : undefined,
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
   *
   * Implementation lives in `src/engine/run-submit-message.ts`; this
   * wrapper stitches the deps bundle, owns the mutable RunState, and
   * writes the final state back to engine fields after iteration so
   * public getters stay in sync.
   */
  async *submitMessage(
    prompt: string | any[],
  ): AsyncGenerator<SDKMessage> {
    const state: RunState = {
      messages: this.messages,
      compactState: this.compactState,
      totalCost: this.totalCost,
      turnCount: this.turnCount,
      apiTimeMs: this.apiTimeMs,
    }

    try {
      for await (const event of runSubmitMessage(this.buildRunDeps(state), prompt)) {
        // Surface state updates from the helper before yielding so any
        // consumer that re-enters the engine sees the same view as the
        // generator does.
        this.messages = state.messages
        this.compactState = state.compactState
        this.totalCost = state.totalCost
        this.turnCount = state.turnCount
        this.apiTimeMs = state.apiTimeMs
        yield event
      }
    } finally {
      this.messages = state.messages
      this.compactState = state.compactState
      this.totalCost = state.totalCost
      this.turnCount = state.turnCount
      this.apiTimeMs = state.apiTimeMs
    }
  }

  private buildRunDeps(state: RunState): RunSubmitMessageDeps {
    return {
      config: this.config,
      provider: this.provider,
      sessionId: this.sessionId,
      trace: this.trace,
      totalUsage: this.totalUsage,
      modelUsage: this.modelUsage,
      state,
      maxToolConcurrency: this.maxToolConcurrency,
      getActiveSkill: () => this.activeSkill,
      getRequiredSkillQualityGates: () => this.requiredSkillQualityGates,
      getActiveQualityGatePolicy: () => this.getActiveQualityGatePolicy(),
      getEvidence: () => this.getEvidence(),
      getQualityGates: () => this.getQualityGates(),
      getModelUsage: () => this.getModelUsage(),
      getTrace: () => this.getTrace(),
      getTerminalQualityGateFailure: () => this.getTerminalQualityGateFailure(),
      executeHooks: (event, extra) => this.executeHooks(event, extra),
      executeTools: (blocks) => this.executeTools(blocks),
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
   *
   * Implementation lives in `src/engine/execute-tools.ts`; this wrapper
   * stitches together the deps bundle so the helpers can stay pure.
   */
  private async executeTools(
    toolUseBlocks: ToolUseBlock[],
  ): Promise<(ToolResult & { tool_name?: string })[]> {
    return executeToolsImpl(this.buildExecuteToolsDeps(), toolUseBlocks)
  }

  private buildExecuteToolsDeps(): ExecuteToolsDeps {
    return {
      config: this.config,
      trace: this.trace,
      maxToolConcurrency: this.maxToolConcurrency,
      concurrencyController: this.concurrencyController,
      evidence: this.evidence,
      qualityGates: this.qualityGates,
      forkedSkills: this.forkedSkills,
      getActiveSkill: () => this.activeSkill,
      setActiveSkill: (skill) => {
        this.activeSkill = skill
      },
      getRequiredSkillQualityGates: () => this.requiredSkillQualityGates,
      setRequiredSkillQualityGates: (names) => {
        this.requiredSkillQualityGates = names
      },
      executeHooks: (event, extra) => this.executeHooks(event, extra),
      recordPolicyDecision: (input) => this.recordPolicyDecision(input),
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
    return cloneModelUsage(this.modelUsage)
  }

  /**
   * Get a defensive copy of run evidence.
   */
  getEvidence(): Evidence[] {
    return cloneEvidence(this.evidence)
  }

  /**
   * Get a defensive copy of quality gate results.
   */
  getQualityGates(): QualityGateResult[] {
    return cloneQualityGates(this.qualityGates)
  }

  /**
   * Get a defensive copy of the run trace.
   */
  getTrace(): AgentRunTrace {
    return cloneTrace(this.trace)
  }
}
