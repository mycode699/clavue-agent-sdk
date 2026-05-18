/**
 * Top-level run loop — extracted from `QueryEngine.submitMessage`
 * (M2 phase 2). The engine keeps a thin wrapper that builds a deps bundle
 * and forwards iteration; everything else (the 7-stage pipeline + turn
 * body + final-event emission) lives here.
 *
 * Mutable state lives in `RunState` (a single object the wrapper owns and
 * the helper mutates in place). This keeps engine bookkeeping (messages,
 * compact state, totalCost, turnCount, apiTimeMs) coherent across the
 * generator boundary without re-introducing class methods.
 */

import { isPromptTooLongError } from '../utils/retry.js'
import { GuardrailAbortError } from '../guardrails/errors.js'
import type {
  AgentRunTrace,
  Evidence,
  QualityGateResult,
  QueryEngineConfig,
  QualityGatePolicy,
  SDKMessage,
  TokenUsage,
  ToolResult,
} from '../types.js'
import type {
  CreateMessageResponse,
  LLMProvider,
  NormalizedMessageParam,
} from '../providers/types.js'
import type { AutoCompactState } from '../utils/compact.js'
import type { HookEvent, HookInput, HookOutput } from '../hooks.js'
import type { SkillActivation } from './skill-helpers.js'
import { getAutonomyMode } from './prompt-helpers.js'
import { buildPhaseMessage } from './message-helpers.js'
import { runGuardStage } from './pipeline/guard.js'
import { runCompactStage } from './pipeline/compact.js'
import { runRenderStage } from './pipeline/render.js'
import { runCallStage } from './pipeline/call.js'
import { drainStream } from './pipeline/stream.js'
import { runToolsStage } from './pipeline/tools.js'
import { runDecideStage } from './pipeline/decide.js'
import { runResilientCall as _runResilientCall } from './resilient-call.js'
import {
  recordTurnUsage,
  tryCompactOnPromptTooLong,
} from './turn-bookkeeping.js'
import {
  buildErrorResultEvent,
  buildFinalResultEvent,
} from './result-events.js'
import {
  buildToolResultEvents,
  buildToolResultsUserMessage,
} from './tool-results.js'
import type { PipelineContext } from './pipeline/types.js'

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

/**
 * Mutable state the engine owns. The helper mutates these fields in
 * place via the supplied object reference — the engine reads them after
 * the generator returns so its public getters (`getTrace`, `getEvidence`,
 * etc.) stay accurate.
 */
export interface RunState {
  messages: NormalizedMessageParam[]
  compactState: AutoCompactState
  totalCost: number
  turnCount: number
  apiTimeMs: number
}

/**
 * Engine-bound dependencies. The engine builds this once per
 * `submitMessage` call and passes it to `runSubmitMessage`.
 */
export interface RunSubmitMessageDeps {
  config: QueryEngineConfig
  provider: LLMProvider
  sessionId: string
  trace: AgentRunTrace
  totalUsage: TokenUsage
  modelUsage: Record<string, { input_tokens: number; output_tokens: number }>
  state: RunState
  /** Read-only — the helper does not mutate adaptive limits or fields owned by the engine ctor. */
  maxToolConcurrency: number
  /** Active skill swap. The helper reads on each turn; the engine swaps when a Skill activation lands. */
  getActiveSkill: () => SkillActivation | undefined
  /** Skill quality gates currently required. */
  getRequiredSkillQualityGates: () => string[]
  /** Quality-gate policy resolver — engine-owned because it composes config + skill state. */
  getActiveQualityGatePolicy: () => QualityGatePolicy | undefined
  /** Snapshot accessors used inside error/final result events. */
  getEvidence: () => Evidence[]
  getQualityGates: () => QualityGateResult[]
  getModelUsage: () => Record<string, { input_tokens: number; output_tokens: number }>
  getTrace: () => AgentRunTrace
  getTerminalQualityGateFailure: () => QualityGateResult | undefined
  /** Lifecycle hook executor (engine owns hookRegistry). */
  executeHooks: (event: HookEvent, extra?: Partial<HookInput>) => Promise<HookOutput[]>
  /** Tool dispatch wrapper (engine builds the deps bundle for `executeToolsImpl`). */
  executeTools: (
    blocks: ToolUseBlock[],
  ) => Promise<(ToolResult & { tool_name?: string })[]>
}

const MAX_OUTPUT_RECOVERY = 3

/**
 * Run the agentic loop for one user prompt. Yields the same SDKMessage
 * stream as the original `QueryEngine.submitMessage` did.
 */
export async function* runSubmitMessage(
  deps: RunSubmitMessageDeps,
  prompt: string | any[],
): AsyncGenerator<SDKMessage> {
  const runId = crypto.randomUUID()
  const { config, provider, sessionId, trace, totalUsage, modelUsage, state } = deps

  // Hooks: SessionStart + UserPromptSubmit
  await deps.executeHooks('SessionStart')
  const userHookResults = await deps.executeHooks('UserPromptSubmit', {
    toolInput: prompt,
  })

  // Pipeline context — single mutation surface for the 7 stages.
  const ctx: PipelineContext = {
    runId,
    sessionId,
    provider,
    trace,
    totalUsage,
    tools: config.tools,
    state: {
      turnIndex: 0,
      apiAttempts: 0,
      maxOutputRecoveryAttempts: 0,
      completedNormally: false,
      budgetExceeded: false,
    },
  }

  // Stage: Guard (pre-loop)
  const guardResult = await runGuardStage(ctx, {
    abortSignal: config.abortSignal,
    maxBudgetUsd: config.maxBudgetUsd,
    totalCost: state.totalCost,
    hookResults: userHookResults,
  })
  if (guardResult.kind === 'denied') {
    yield buildErrorResultEvent({
      subtype: 'error_during_execution',
      sessionId,
      totalUsage,
      numTurns: 0,
      totalCost: 0,
      durationApiMs: 0,
      modelUsage: deps.getModelUsage(),
      permissionDenials: trace.permission_denials,
      evidence: deps.getEvidence(),
      qualityGates: deps.getQualityGates(),
      trace: deps.getTrace(),
      errors: guardResult.errors,
    })
    return
  }

  // Add user message
  state.messages.push({ role: 'user', content: prompt as any })
  config.initialPrompt = typeof prompt === 'string' ? prompt : undefined

  // Emit init system message
  yield {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    tools: config.tools.map((t) => t.name),
    model: config.model,
    cwd: config.cwd,
    mcp_servers: [],
    permission_mode: config.policy.permissionMode,
    autonomy_mode: getAutonomyMode(config),
  } as SDKMessage

  yield buildPhaseMessage(sessionId, runId, 'intake')
  yield buildPhaseMessage(sessionId, runId, 'context')

  let turnsRemaining = config.maxTurns

  while (turnsRemaining > 0) {
    if (config.abortSignal?.aborted) break
    if (config.maxBudgetUsd && state.totalCost >= config.maxBudgetUsd) {
      ctx.state.budgetExceeded = true
      break
    }

    // Stage: Compact
    const compactResult = await runCompactStage(ctx, {
      model: config.model,
      messages: state.messages,
      state: state.compactState,
      abortSignal: config.abortSignal,
      onPreCompact: () => deps.executeHooks('PreCompact').then(() => undefined),
      onPostCompact: () => deps.executeHooks('PostCompact').then(() => undefined),
    })
    if (compactResult.kind !== 'ok') break
    state.messages = compactResult.value.messages
    state.compactState = compactResult.value.state
    const apiMessages = compactResult.value.apiMessages

    state.turnCount++
    turnsRemaining--
    ctx.state.turnIndex = state.turnCount

    // Streaming wiring (P0-4 Phase 2).
    const partialQueue: string[] = []
    let partialResolve: (() => void) | null = null
    const wantStreaming = config.includePartialMessages === true
    const releaseDrain = (): void => {
      if (partialResolve) {
        const r = partialResolve
        partialResolve = null
        r()
      }
    }

    // Stage: Render
    const renderResult = await runRenderStage(ctx, {
      config,
      apiMessages,
      activeSkill: deps.getActiveSkill(),
      partialQueue,
      releaseDrain,
    })
    if (renderResult.kind !== 'ok') break
    const { requestModel, fallbackModel, createModelMessage } = renderResult.value

    // Stages: Call + Stream (concurrent).
    const apiStart = performance.now()
    let successfulModel = requestModel
    yield buildPhaseMessage(sessionId, runId, 'model_request', state.turnCount)

    const isDoneRef = { current: false }
    let callError: unknown
    let response: CreateMessageResponse | undefined

    const callTask = (async () => {
      try {
        const callResult = await runCallStage(ctx, {
          requestModel,
          fallbackModel,
          abortSignal: config.abortSignal,
          createModelMessage,
        })
        if (callResult.kind === 'ok') {
          response = callResult.value.response
          successfulModel = callResult.value.successfulModel
        }
      } catch (err) {
        callError = err
      } finally {
        isDoneRef.current = true
        releaseDrain()
      }
    })()

    if (wantStreaming) {
      for await (const ev of drainStream(ctx, {
        queue: partialQueue,
        wantStreaming: true,
        isDoneRef,
        waitForFill: () => new Promise<void>((res) => { partialResolve = res }),
      })) {
        yield ev
      }
    }

    await callTask
    trace.retry_count += Math.max(0, ctx.state.apiAttempts - 1)
    ctx.state.apiAttempts = 0

    if (callError) {
      // Prompt-too-long compact-and-retry (control flow needs turn refund,
      // can't live inside a stage).
      if (isPromptTooLongError(callError)) {
        const recovery = await tryCompactOnPromptTooLong({
          provider,
          model: config.model,
          messages: state.messages,
          state: state.compactState,
          abortSignal: config.abortSignal,
          trace,
        })
        if (recovery.recovered) {
          state.messages = recovery.messages
          state.compactState = recovery.state
          turnsRemaining++
          state.turnCount--
          continue
        }
      }
      yield buildErrorResultEvent({
        subtype: 'error',
        sessionId,
        totalUsage,
        numTurns: state.turnCount,
        totalCost: state.totalCost,
        durationApiMs: state.apiTimeMs + performance.now() - apiStart,
        modelUsage: deps.getModelUsage(),
        permissionDenials: trace.permission_denials,
        evidence: deps.getEvidence(),
        qualityGates: deps.getQualityGates(),
        trace: deps.getTrace(),
        errors: [(callError as any)?.message || String(callError)],
      })
      return
    }

    if (!response) break // defensive — should not happen if callError is undefined

    yield buildPhaseMessage(sessionId, runId, 'model_response', state.turnCount)
    const turnApiTimeMs = performance.now() - apiStart
    state.apiTimeMs += turnApiTimeMs

    // Per-turn usage / cost bookkeeping.
    const usageResult = recordTurnUsage({
      response,
      successfulModel,
      turnApiTimeMs,
      trace,
      totalUsage,
      totalCost: state.totalCost,
      modelUsage,
      turnCount: state.turnCount,
    })
    state.totalCost = usageResult.totalCost

    state.messages.push({ role: 'assistant', content: response.content as any })
    yield {
      type: 'assistant',
      message: { role: 'assistant', content: response.content as any },
    }

    // Stage: Tools (extract + dispatch).
    let toolsStageResult: Awaited<ReturnType<typeof runToolsStage>>
    try {
      toolsStageResult = await runToolsStage(ctx, {
        response,
        config,
        activeSkill: deps.getActiveSkill(),
        maxToolConcurrency: deps.maxToolConcurrency,
        executeTools: (blocks) => deps.executeTools(blocks),
      })
    } catch (err) {
      if (err instanceof GuardrailAbortError) {
        yield buildErrorResultEvent({
          subtype: 'error_guardrail_abort',
          sessionId,
          totalUsage,
          numTurns: state.turnCount,
          totalCost: state.totalCost,
          durationApiMs: state.apiTimeMs,
          modelUsage: deps.getModelUsage(),
          permissionDenials: trace.permission_denials,
          evidence: deps.getEvidence(),
          qualityGates: deps.getQualityGates(),
          trace: deps.getTrace(),
          errors: [err.message],
        })
        return
      }
      throw err
    }
    const hadToolCalls =
      toolsStageResult.kind === 'ok' && toolsStageResult.value.toolUseBlocks.length > 0
    const toolResults: (ToolResult & { tool_name?: string })[] =
      toolsStageResult.kind === 'ok' ? toolsStageResult.value.toolResults : []

    if (hadToolCalls && toolsStageResult.kind === 'ok') {
      for (const block of toolsStageResult.value.toolUseBlocks) {
        yield buildPhaseMessage(sessionId, runId, 'tool_execution', state.turnCount, block.id)
      }
      for (const event of buildToolResultEvents(sessionId, runId, toolResults)) {
        yield event
      }
      state.messages.push(buildToolResultsUserMessage(toolResults))
    }

    // Stage: Decide
    const decideResult = await runDecideStage(ctx, {
      response,
      hadToolCalls,
      maxOutputRecoveryLimit: MAX_OUTPUT_RECOVERY,
    })
    if (decideResult.kind !== 'ok') break
    if (decideResult.value.next === 'max_output_recovery') {
      state.messages.push({
        role: 'user',
        content: 'Please continue from where you left off.',
      })
      turnsRemaining++
      state.turnCount--
      continue
    }
    if (decideResult.value.next === 'stop') break
    // 'continue' — fall through to next iteration
  }

  // Hooks: Stop + SessionEnd
  await deps.executeHooks('Stop')
  await deps.executeHooks('SessionEnd')

  const baseSubtype = ctx.state.budgetExceeded
    ? 'error_max_budget_usd'
    : ctx.state.completedNormally
      ? 'success'
      : 'error_max_turns'
  const gateFailure =
    baseSubtype === 'success' ? deps.getTerminalQualityGateFailure() : undefined
  const endSubtype = gateFailure ? 'error_quality_gate_failed' : baseSubtype
  const errors = gateFailure
    ? [
        `Required quality gate failed: ${gateFailure.name}${gateFailure.summary ? ` - ${gateFailure.summary}` : ''}`,
      ]
    : undefined

  yield buildPhaseMessage(sessionId, runId, 'verification')
  yield buildPhaseMessage(sessionId, runId, 'finalize')

  yield buildFinalResultEvent({
    subtype: endSubtype,
    sessionId,
    numTurns: state.turnCount,
    totalCost: state.totalCost,
    durationApiMs: state.apiTimeMs,
    totalUsage,
    modelUsage: deps.getModelUsage(),
    permissionDenials: trace.permission_denials,
    evidence: deps.getEvidence(),
    qualityGates: deps.getQualityGates(),
    trace: deps.getTrace(),
    errors,
  })
}
