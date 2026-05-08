/**
 * v3.4 Guardrails (prototype) — public surface.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.4 section).
 * @module
 */

export type {
  Guardrail,
  GuardrailCheckResult,
  GuardrailContext,
  GuardrailEvaluation,
  GuardrailScope,
  GuardrailViolation,
  OnToolViolationFn,
  ToolGuardrailAction,
  ToolGuardrailCallContext,
  ToolGuardrailPhase,
} from './types.js'

export { GuardrailRegistry } from './runtime.js'
export { GuardrailAbortError, isGuardrailAbortError } from './errors.js'
