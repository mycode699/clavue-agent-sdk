/**
 * Guardrails — runtime registry + evaluator (v3.4 prototype).
 *
 * Single-responsibility: collect Guardrail definitions, evaluate the subset
 * matching a scope, and produce a structured GuardrailEvaluation. No retry,
 * no caching, no policy chaining yet — those land when guardrails graduate
 * into the engine pipeline.
 *
 * Throwing checks count as a blocking violation rather than crashing the
 * caller, so a buggy guardrail cannot take down a run.
 *
 * @module
 */

import type {
  Guardrail,
  GuardrailContext,
  GuardrailEvaluation,
  GuardrailScope,
  GuardrailViolation,
} from './types.js'

export class GuardrailRegistry {
  private rails: Guardrail[] = []

  /** Add a guardrail. Replaces any existing rail with the same name. */
  add(rail: Guardrail): this {
    if (!rail || typeof rail.name !== 'string' || rail.name.length === 0) {
      throw new Error('Guardrail.name must be a non-empty string')
    }
    if (typeof rail.check !== 'function') {
      throw new Error(`Guardrail "${rail.name}" must define a check function`)
    }
    this.rails = this.rails.filter((r) => r.name !== rail.name).concat({ ...rail })
    return this
  }

  /** Remove a guardrail by name. No-op if not registered. */
  remove(name: string): this {
    this.rails = this.rails.filter((r) => r.name !== name)
    return this
  }

  /** Read-only snapshot of registered rails (in insertion order). */
  list(): readonly Guardrail[] {
    return this.rails.slice()
  }

  size(): number {
    return this.rails.length
  }

  /**
   * Evaluate every guardrail registered for the given scope. Returns one
   * GuardrailEvaluation. Empty registry / no matching scope → passed=true,
   * violations=[].
   */
  async evaluate(
    scope: GuardrailScope,
    payload: unknown,
    ctx: GuardrailContext = {},
  ): Promise<GuardrailEvaluation> {
    if (scope === 'tool_input' || scope === 'tool_output') {
      if (!ctx.toolName) {
        throw new Error(
          `Guardrail evaluation for scope "${scope}" requires ctx.toolName`,
        )
      }
    }
    const violations: GuardrailViolation[] = []
    for (const rail of this.rails) {
      if (rail.scope !== scope) continue
      let result
      try {
        result = await rail.check(payload, ctx)
      } catch (err) {
        violations.push({
          guardrail: rail.name,
          scope,
          blocking: true,
          message: `check threw: ${(err as Error).message ?? String(err)}`,
          ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
          ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
        })
        continue
      }
      if (!result || result.pass === true) continue
      const blocking = result.blocking !== false // default: true
      violations.push({
        guardrail: rail.name,
        scope,
        blocking,
        ...(result.message !== undefined ? { message: result.message } : {}),
        ...(ctx.toolName !== undefined ? { toolName: ctx.toolName } : {}),
        ...(ctx.agentId !== undefined ? { agentId: ctx.agentId } : {}),
      })
    }
    const passed = violations.every((v) => v.blocking === false)
    return { passed, violations }
  }
}
