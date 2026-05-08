/**
 * Guardrails — types (v3.4 prototype).
 *
 * 4 scopes (peer comparison):
 *
 *   - openai-agents: 'input' | 'output'                (2 scopes)
 *   - clavue:        'input' | 'output' | 'tool_input' | 'tool_output'  (4 scopes)
 *
 * The two extra scopes let hosts gate every tool call individually — for
 * example, scrub PII before WebFetch fires, or block if a Bash result leaks
 * a secret. This is what the upgrade-chain doc calls the v3.4 代差.
 *
 * @module
 */

export type GuardrailScope = 'input' | 'output' | 'tool_input' | 'tool_output'

/** Optional contextual info passed into checks. Required for tool scopes. */
export interface GuardrailContext {
  /** Set for tool_input / tool_output evaluations. */
  toolName?: string
  /** Optional agent id when running inside a multi-agent graph. */
  agentId?: string
}

/** A single check result. */
export interface GuardrailCheckResult {
  pass: boolean
  /** When false, a non-passing result is a warning (does not block). Default: true. */
  blocking?: boolean
  /** Human-readable reason / detection. */
  message?: string
}

export interface Guardrail {
  name: string
  scope: GuardrailScope
  /** Sync or async check. Throwing rejects the evaluation as a blocking failure. */
  check: (
    payload: unknown,
    ctx: GuardrailContext,
  ) => GuardrailCheckResult | Promise<GuardrailCheckResult>
}

export interface GuardrailViolation {
  guardrail: string
  scope: GuardrailScope
  blocking: boolean
  message?: string
  toolName?: string
  agentId?: string
}

export interface GuardrailEvaluation {
  /** true iff zero blocking violations. Non-blocking warnings still count as passed. */
  passed: boolean
  violations: GuardrailViolation[]
}

/**
 * Tool-scope guardrail policy (RFC D2). Asymmetric defaults:
 *
 *   - output-scope (graph runtime) → default `'abort'` (model output is final)
 *   - tool-scope   (engine)        → default `'skip'`  (model can replan)
 *
 * `'continue'` is audit-only: the violation is recorded in trace but the
 * call/result is not modified.
 */
export type ToolGuardrailAction = 'abort' | 'skip' | 'continue'

/** Phase reported to the `onToolViolation` callback. */
export type ToolGuardrailPhase = 'request' | 'response'

/** Context passed to the `onToolViolation` callback. */
export interface ToolGuardrailCallContext {
  toolName: string
  phase: ToolGuardrailPhase
  agentId?: string
}

/**
 * Callback invoked when a tool-scope guardrail evaluation does not pass.
 * Returning `'skip'` (default if no callback) injects a denied ToolResult so
 * the agent can replan; `'abort'` terminates the run with
 * `error_guardrail_abort`; `'continue'` lets the call/result proceed
 * unchanged (audit-only).
 *
 * Throwing from the callback is treated as `'abort'`, matching the
 * symmetric behavior of graph `onViolation`.
 */
export type OnToolViolationFn = (
  evaluation: GuardrailEvaluation,
  call: ToolGuardrailCallContext,
) => ToolGuardrailAction | Promise<ToolGuardrailAction>
