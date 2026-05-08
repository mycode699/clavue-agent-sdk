/**
 * Guardrails — sentinel error for tool-scope abort (RFC D2).
 *
 * Thrown from the engine's tool dispatcher when an `onToolViolation`
 * callback returns `'abort'` (or throws — throwing defaults to abort,
 * mirroring graph `onViolation` semantics). The engine's `submitMessage`
 * loop catches this specific error and emits a terminal
 * `error_guardrail_abort` result.
 *
 * The class lives here (not in `runtime.ts`) so callers can `instanceof`-
 * check without importing the heavier registry module.
 *
 * @module
 */
import type { GuardrailEvaluation } from './types.js'

export type ToolGuardrailPhase = 'request' | 'response'

export class GuardrailAbortError extends Error {
  readonly evaluation: GuardrailEvaluation
  readonly toolName: string
  readonly phase: ToolGuardrailPhase

  constructor(
    message: string,
    evaluation: GuardrailEvaluation,
    toolName: string,
    phase: ToolGuardrailPhase,
  ) {
    super(message)
    this.name = 'GuardrailAbortError'
    this.evaluation = evaluation
    this.toolName = toolName
    this.phase = phase
  }
}

export function isGuardrailAbortError(e: unknown): e is GuardrailAbortError {
  return e instanceof Error && e.name === 'GuardrailAbortError'
}
