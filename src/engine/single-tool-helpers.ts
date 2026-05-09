/**
 * Single-tool execution helpers — Slice K5. Pure helpers that
 * `executeSingleTool` now composes instead of inlining. Each helper isolates
 * one concern (error result construction, guardrail evaluation, skill
 * activation) so the orchestrator method shrinks and each piece is
 * separately testable.
 */

import type { GuardrailEvaluation } from '../guardrails/types.js'
import { GuardrailAbortError } from '../guardrails/errors.js'
import type { SkillQualityGateSpec } from '../skills/types.js'
import type { Evidence, QualityGateResult, ToolResult } from '../types.js'
import type { SkillActivation } from './skill-helpers.js'

export type ToolResultWithMeta = ToolResult & { tool_name?: string }

interface BlockLike {
  id: string
  name: string
}

/**
 * Construct a uniform `is_error: true` tool_result. Used by every single
 * failure branch in `executeSingleTool` (unknown tool, disabled, permission
 * denied, hook blocked, guardrail skipped, tool threw, etc.).
 */
export function buildErrorToolResult(
  block: BlockLike,
  content: string,
): ToolResultWithMeta {
  return {
    type: 'tool_result',
    tool_use_id: block.id,
    content,
    is_error: true,
    tool_name: block.name,
  }
}

/**
 * Build the human-readable violation summary used in guardrail-denied
 * tool_result payloads (e.g. `"foo: bad input; bar: blocked"`).
 */
export function formatGuardrailViolations(evaluation: GuardrailEvaluation): string {
  return evaluation.violations.map((v) => v.message ?? v.guardrail).join('; ')
}

/**
 * v3.4 guardrails — apply one phase (`tool_input` or `tool_output`) of the
 * tool-scope guardrail check.
 *
 * Returns one of:
 *   - `{ kind: 'pass' }`               — caller proceeds normally.
 *   - `{ kind: 'continue' }`           — guardrail failed but action was
 *                                        'continue' (audit-only); caller
 *                                        proceeds as if it passed.
 *   - `{ kind: 'skip', result }`       — guardrail failed and action was
 *                                        'skip'; caller returns the supplied
 *                                        is_error result without invoking
 *                                        the tool (or post-processing it).
 *
 * On `'abort'` action this throws `GuardrailAbortError` so the engine's
 * top-level catch can emit the dedicated abort result.
 */
export type GuardrailApplicationOutcome =
  | { kind: 'pass' }
  | { kind: 'continue' }
  | { kind: 'skip'; result: ToolResultWithMeta }

export async function applyGuardrailToolPhase(input: {
  evaluation: GuardrailEvaluation
  block: BlockLike
  phase: 'request' | 'response'
  resolveAction: (
    evaluation: GuardrailEvaluation,
    toolName: string,
    phase: 'request' | 'response',
  ) => Promise<'abort' | 'skip' | 'continue'>
}): Promise<GuardrailApplicationOutcome> {
  const { evaluation, block, phase, resolveAction } = input
  if (evaluation.passed) return { kind: 'pass' }

  const action = await resolveAction(evaluation, block.name, phase)
  const violations = formatGuardrailViolations(evaluation)

  if (action === 'abort') {
    throw new GuardrailAbortError(
      `Guardrail aborted tool ${phase === 'request' ? 'input' : 'output'} for "${block.name}": ${violations}`,
      evaluation,
      block.name,
      phase,
    )
  }
  if (action === 'skip') {
    return {
      kind: 'skip',
      result: buildErrorToolResult(
        block,
        `Guardrail denied tool ${phase === 'request' ? 'input' : 'output'}: ${violations}`,
      ),
    }
  }
  // 'continue' → audit-only, fall through.
  return { kind: 'continue' }
}

/**
 * Side-effects to apply when a tool returns evidence / quality_gates /
 * a Skill activation block. Mutates the supplied accumulators in place so
 * the engine doesn't need to thread these state arrays through helpers.
 */
export interface SkillActivationOutcome {
  activeSkill?: SkillActivation
  /** Forked-skill activations to append to engine.forkedSkills. */
  forked?: SkillActivation
  /** Required gates this activation contributes (deduped by caller). */
  requiredGateNames: string[]
}

/**
 * Read a tool result and decide what to mutate on the engine:
 *   - Push evidence and quality_gates into accumulators.
 *   - If the tool was Skill and produced a valid activation, return its
 *     destination ('inline' → activeSkill, 'forked' → forked) plus the
 *     required gate names so the caller can merge them into
 *     `requiredSkillQualityGates`.
 *
 * Pure data: no engine fields touched, just the supplied arrays.
 */
export function ingestToolSideEffects(
  toolResult: ToolResult,
  evidenceAcc: Evidence[],
  qualityGatesAcc: QualityGateResult[],
  parseActivation: (r: ToolResult) => SkillActivation | undefined,
  toolName: string,
): SkillActivationOutcome {
  if (toolResult.evidence) evidenceAcc.push(...toolResult.evidence)
  if (toolResult.quality_gates) qualityGatesAcc.push(...toolResult.quality_gates)

  const activation = toolName === 'Skill' ? parseActivation(toolResult) : undefined
  if (!activation) return { requiredGateNames: [] }

  const requiredGateNames = (activation.qualityGates ?? [])
    .filter((gate: SkillQualityGateSpec) => gate.required !== false)
    .map((gate: SkillQualityGateSpec) => gate.name)

  return {
    activeSkill: activation.status === 'inline' ? activation : undefined,
    forked: activation.status === 'forked' ? activation : undefined,
    requiredGateNames,
  }
}
