/**
 * Tool execution helpers — extracted from `QueryEngine.executeTools`,
 * `executeSingleTool`, `resolveToolGuardrailAction` (M2 pipeline split).
 *
 * The engine keeps a thin wrapper that builds a deps bundle and forwards.
 * All policy / hook / guardrail / cache / skill side-effect logic lives
 * here. State that the original methods mutated on `this` is exposed
 * through:
 *   - direct array references (evidence / qualityGates / forkedSkills) —
 *     in-place mutation preserves the engine's view.
 *   - getter+setter pairs (activeSkill / requiredSkillQualityGates) — the
 *     engine swaps the field; helpers go through accessors.
 *   - bound callbacks (executeHooks / recordPolicyDecision) — these
 *     touch fields the helpers must not own (hookRegistry, sessionId,
 *     permissionMode, autonomyMode).
 */

import type {
  AgentRunPolicyDecisionTrace,
  AgentRunToolTrace,
  AgentRunTrace,
  Evidence,
  QualityGateResult,
  ToolContext,
  ToolDefinition,
  ToolResult,
} from '../types.js'
import type { QueryEngineConfig } from '../types.js'
import type { HookEvent, HookInput, HookOutput } from '../hooks.js'
import type {
  GuardrailEvaluation,
  ToolGuardrailAction,
  ToolGuardrailPhase,
} from '../guardrails/types.js'
import { GuardrailAbortError } from '../guardrails/errors.js'
import {
  applyGuardrailToolPhase,
  buildErrorToolResult,
  ingestToolSideEffects,
} from './single-tool-helpers.js'
import { executeDispatchPlan } from './dispatch-executor.js'
import {
  canRunConcurrently,
  planToolDispatch,
  summarizeToolInput,
} from './tool-helpers.js'
import { filterToolsForSkill, parseSkillActivation, type SkillActivation } from './skill-helpers.js'
import { createToolContext } from './prompt-helpers.js'
import { ToolResultCache } from './tool-result-cache.js'
import type { ConcurrencyController } from './concurrency-controller.js'

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

type ToolResultWithMeta = ToolResult & { tool_name?: string }

type RecordPolicyDecisionInput = Omit<
  AgentRunPolicyDecisionTrace,
  'timestamp' | 'permission_mode' | 'autonomy_mode' | 'safety'
> & { tool: ToolDefinition }

/**
 * Dependencies the extracted helpers need from the engine. Built once per
 * call by the engine wrapper. Mutation contracts:
 *   - `evidence`, `qualityGates`, `forkedSkills` are mutated in place;
 *     the engine and the helpers must share the same arrays.
 *   - `activeSkill` and `requiredSkillQualityGates` are swappable refs;
 *     helpers always go through the accessors.
 *   - `trace` is mutated in place (push to `trace.tools`,
 *     `trace.permission_denials`, `trace.tool_cache`, etc.).
 */
export interface ExecuteToolsDeps {
  config: QueryEngineConfig
  trace: AgentRunTrace
  maxToolConcurrency: number
  concurrencyController: ConcurrencyController
  evidence: Evidence[]
  qualityGates: QualityGateResult[]
  forkedSkills: SkillActivation[]
  getActiveSkill: () => SkillActivation | undefined
  setActiveSkill: (skill: SkillActivation | undefined) => void
  getRequiredSkillQualityGates: () => string[]
  setRequiredSkillQualityGates: (names: string[]) => void
  executeHooks: (event: HookEvent, extra?: Partial<HookInput>) => Promise<HookOutput[]>
  /**
   * Engine-bound recorder — fills in timestamp/permission_mode/autonomy_mode/
   * safety and pushes onto `trace.policy_decisions`. Helpers never touch
   * those fields directly.
   */
  recordPolicyDecision: (input: RecordPolicyDecisionInput) => void
  /** Defaults to the production parser; injectable for tests. */
  parseSkillActivation?: (result: ToolResult) => SkillActivation | undefined
}

/**
 * Run the model's tool_use blocks for one turn. Mirrors the original
 * `QueryEngine.executeTools` contract:
 *   - filter tools by active skill, build context once,
 *   - plan into ordered serial+concurrent batches,
 *   - dispatch with the per-turn ToolResultCache,
 *   - merge cache stats and adaptive snapshot into `trace`.
 */
export async function executeToolsImpl(
  deps: ExecuteToolsDeps,
  toolUseBlocks: ToolUseBlock[],
): Promise<ToolResultWithMeta[]> {
  const activeSkill = deps.getActiveSkill()
  const toolsForThisTurn = activeSkill
    ? filterToolsForSkill(deps.config.tools, activeSkill.allowedTools)
    : deps.config.tools
  const context = createToolContext(deps.config, toolsForThisTurn)
  const toolsByName = new Map(toolsForThisTurn.map((tool) => [tool.name, tool]))

  // Slice H — order-preserving concurrent grouping.
  const plan = planToolDispatch(toolUseBlocks, (name) => toolsByName.get(name))

  // Tier A #1 — turn-scoped tool result cache.
  const toolCache = new ToolResultCache()

  const results = await executeDispatchPlan<ToolUseBlock>({
    plan,
    context,
    trace: deps.trace,
    maxConcurrency: deps.maxToolConcurrency,
    concurrencyController: deps.concurrencyController,
    executeSingle: (block, tool, ctx, recordTrace) =>
      executeSingleToolImpl(deps, block, tool, ctx, recordTrace, toolCache),
  })

  // Merge per-turn cache counters into the run-level aggregate. Only
  // surface the trace field when at least one lookup happened.
  const { hits, misses } = toolCache.stats()
  if (hits > 0 || misses > 0) {
    const prev = deps.trace.tool_cache
    deps.trace.tool_cache = prev
      ? { hits: prev.hits + hits, misses: prev.misses + misses }
      : { hits, misses }
  }

  // Tier A #2 — refresh adaptive concurrency snapshot.
  const adaptiveSnapshot = deps.concurrencyController.snapshot()
  if (adaptiveSnapshot) {
    deps.trace.tool_concurrency_adaptive = adaptiveSnapshot
  }

  return results
}

/**
 * Resolve the tool-scope guardrail action for a failed evaluation
 * (RFC D2). Default = `'skip'`. Throwing → `'abort'`.
 */
export async function resolveToolGuardrailActionImpl(
  deps: ExecuteToolsDeps,
  evaluation: GuardrailEvaluation,
  toolName: string,
  phase: ToolGuardrailPhase,
): Promise<ToolGuardrailAction> {
  const cb = deps.config.onToolViolation
  if (!cb) return 'skip'
  try {
    const action = await cb(evaluation, { toolName, phase })
    if (action === 'abort' || action === 'skip' || action === 'continue') {
      return action
    }
    return 'skip'
  } catch {
    return 'abort'
  }
}

/**
 * Execute a single tool with permission, hook, guardrail, cache, and
 * side-effect ingestion. Returns the tool_result echoed to the model.
 */
export async function executeSingleToolImpl(
  deps: ExecuteToolsDeps,
  block: ToolUseBlock,
  tool: ToolDefinition | undefined,
  context: ToolContext,
  recordTrace: ((trace: AgentRunToolTrace) => void) | true,
  toolCache?: ToolResultCache,
): Promise<ToolResultWithMeta> {
  const start = performance.now()
  let result: ToolResultWithMeta | undefined
  const parseActivation = deps.parseSkillActivation ?? parseSkillActivation

  try {
    if (!tool) {
      result = buildErrorToolResult(block, `Error: Unknown tool "${block.name}"`)
      return result
    }

    if (tool.isEnabled && !tool.isEnabled(context)) {
      result = buildErrorToolResult(block, `Error: Tool "${block.name}" is not enabled`)
      return result
    }

    // Permission check.
    try {
      const permission = await deps.config.policy.canUseTool(tool, block.input)
      const source = permission.source ?? 'host_canUseTool'
      if (permission.behavior === 'deny') {
        const reason = permission.message || `Permission denied for tool "${block.name}"`
        deps.trace.permission_denials.push({ tool: block.name, reason })
        deps.recordPolicyDecision({
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
      deps.recordPolicyDecision({
        tool,
        tool_use_id: block.id,
        tool_name: block.name,
        behavior: 'allow',
        source,
        reason: permission.message,
        input_summary: summarizeToolInput(block.input),
        updated_input_summary:
          permission.updatedInput === undefined
            ? undefined
            : summarizeToolInput(permission.updatedInput),
        input_rewritten: permission.updatedInput !== undefined,
      })
      if (permission.updatedInput !== undefined) {
        block = { ...block, input: permission.updatedInput }
      }
    } catch (err: any) {
      const reason = `Permission check error: ${err.message}`
      deps.trace.permission_denials.push({ tool: block.name, reason })
      deps.recordPolicyDecision({
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
    const preHookResults = await deps.executeHooks('PreToolUse', {
      toolName: block.name,
      toolInput: block.input,
      toolUseId: block.id,
    })
    if (preHookResults.some((r) => r.block)) {
      const msg = preHookResults.find((r) => r.message)?.message || 'Blocked by PreToolUse hook'
      deps.recordPolicyDecision({
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

    try {
      // Guardrails: tool_input scope.
      if (deps.config.guardrails) {
        const evalIn = await deps.config.guardrails.evaluate(
          'tool_input',
          block.input,
          { toolName: block.name },
        )
        if (deps.config.trace) {
          try {
            deps.config.trace.appendGuardrail('tool_input', evalIn, { toolName: block.name })
          } catch {
            // Telemetry must never break a run.
          }
        }
        const outcome = await applyGuardrailToolPhase({
          evaluation: evalIn,
          block,
          phase: 'request',
          resolveAction: (e, n, p) => resolveToolGuardrailActionImpl(deps, e, n, p),
        })
        if (outcome.kind === 'skip') {
          result = outcome.result
          return result
        }
      }

      // Tier A #1 — turn-scoped tool result cache.
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
        if (deps.config.trace) {
          try {
            deps.config.trace.appendToolCache({
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
        result = { ...toolResult, tool_use_id: block.id, tool_name: block.name }
        return result
      }

      // Guardrails: tool_output scope.
      if (deps.config.guardrails) {
        const evalOut = await deps.config.guardrails.evaluate(
          'tool_output',
          toolResult.content,
          { toolName: block.name },
        )
        if (deps.config.trace) {
          try {
            deps.config.trace.appendGuardrail('tool_output', evalOut, { toolName: block.name })
          } catch {
            // Telemetry must never break a run.
          }
        }
        const outcome = await applyGuardrailToolPhase({
          evaluation: evalOut,
          block,
          phase: 'response',
          resolveAction: (e, n, p) => resolveToolGuardrailActionImpl(deps, e, n, p),
        })
        if (outcome.kind === 'skip') {
          result = outcome.result
          return result
        }
      }

      // Side-effect ingestion (evidence / quality_gates / skill).
      const skillOutcome = ingestToolSideEffects(
        toolResult,
        deps.evidence,
        deps.qualityGates,
        parseActivation,
        tool.name,
      )
      if (skillOutcome.requiredGateNames.length > 0) {
        const prev = deps.getRequiredSkillQualityGates()
        deps.setRequiredSkillQualityGates([
          ...new Set([...prev, ...skillOutcome.requiredGateNames]),
        ])
      }
      if (skillOutcome.activeSkill) deps.setActiveSkill(skillOutcome.activeSkill)
      if (skillOutcome.forked) deps.forkedSkills.push(skillOutcome.forked)

      // Hook: PostToolUse
      await deps.executeHooks('PostToolUse', {
        toolName: block.name,
        toolInput: block.input,
        toolOutput:
          typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
        toolUseId: block.id,
      })

      result = { ...toolResult, tool_use_id: block.id, tool_name: block.name }
      return result
    } catch (err: any) {
      // GuardrailAbortError must bubble; other tool errors stay contained.
      if (err instanceof GuardrailAbortError) {
        throw err
      }

      await deps.executeHooks('PostToolUseFailure', {
        toolName: block.name,
        toolInput: block.input,
        toolUseId: block.id,
        error: err.message,
      })

      result = buildErrorToolResult(block, `Tool execution error: ${err.message}`)
      return result
    }
  } finally {
    const traceRow: AgentRunToolTrace = {
      tool_use_id: block.id,
      tool_name: block.name,
      duration_ms: Math.round(performance.now() - start),
      // When an exception unwinds (e.g. GuardrailAbortError) `result` is
      // undefined; record the call as errored so trace consumers see it.
      is_error: result === undefined ? true : result.is_error === true,
      concurrency_safe: canRunConcurrently(tool),
    }
    if (recordTrace === true) {
      deps.trace.tools.push(traceRow)
    } else {
      recordTrace(traceRow)
    }
  }
}
