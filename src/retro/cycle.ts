import { compareRetroRuns } from './compare.js'
import { createDefaultRetroEvaluators } from './evaluators.js'
import { loadRetroRun, saveRetroCycle, saveRetroRun } from './ledger.js'
import { decideRetroAction } from './policy.js'
import { runRetroEvaluation } from './run.js'
import { runRetroVerification } from './verify.js'
import type {
  RetroActionKind,
  RetroActionPlan,
  RetroCycleDecision,
  RetroCycleInput,
  RetroCycleResult,
  RetroCycleSummary,
  RetroCycleTrace,
} from './types.js'

function formatActionLabel(actionKind: RetroActionKind): string {
  return actionKind.replaceAll('_', ' ')
}

function buildCycleDecision(action: RetroActionPlan): RetroCycleDecision {
  switch (action.kind) {
    case 'stop':
      return {
        disposition: 'accepted',
        accepted: true,
        shouldRetry: false,
        reason: action.reason,
      }
    case 'attempt_fix':
    case 'retest':
    case 'retry_with_more_context':
      return {
        disposition: 'retry',
        accepted: false,
        shouldRetry: true,
        reason: action.reason,
      }
    default:
      return {
        disposition: 'rejected',
        accepted: false,
        shouldRetry: false,
        reason: action.reason,
      }
  }
}

function buildCycleSummary(
  runSummary: string,
  verificationPassed: boolean,
  action: RetroActionPlan,
  decision: RetroCycleDecision,
  findingCount: number,
): RetroCycleSummary {
  const statusLine = `${decision.disposition.toUpperCase()} · ${formatActionLabel(action.kind)} · ${findingCount} finding(s)`

  return {
    text: `${statusLine}. Verification: ${verificationPassed ? 'passed' : 'failed'}. ${runSummary} ${decision.reason}`,
    statusLine,
    findingCount,
    verificationPassed,
    actionKind: action.kind,
    disposition: decision.disposition,
  }
}

export async function runRetroCycle(input: RetroCycleInput): Promise<RetroCycleResult> {
  const startedAt = new Date().toISOString()
  const cycleStartedAt = Date.now()
  const evaluators = input.evaluators ?? createDefaultRetroEvaluators()
  const attemptCount = input.attemptCount ?? 0
  const maxAttempts = input.policy?.maxAttempts ?? 3
  const run = await runRetroEvaluation({
    target: input.target,
    evaluators,
    runAt: input.runAt,
    sourceRun: input.sourceRun,
  })

  const verification = await runRetroVerification({
    target: input.target,
    gates: input.gates,
  })

  if (verification) {
    run.verification = verification
  }

  const previousRun = input.previousRun ?? (input.previousRunId
    ? await loadRetroRun(input.previousRunId, input.ledger)
    : undefined)
  const comparison = previousRun ? compareRetroRuns(previousRun, run) : undefined
  const action = decideRetroAction({
    run,
    verification,
    previousRun: previousRun ?? undefined,
    comparison,
    attemptCount: input.attemptCount,
    policy: input.policy,
  })
  const decision = buildCycleDecision(action)
  const summary = buildCycleSummary(
    run.summary,
    verification?.passed ?? false,
    action,
    decision,
    run.findings.length,
  )
  const completedAt = new Date().toISOString()
  const trace: RetroCycleTrace = {
    cycleId: input.cycleId,
    runId: input.runId,
    previousRunId: input.previousRunId,
    sourceRunId: input.sourceRun?.id,
    sourceSessionId: input.sourceRun?.session_id,
    attemptCount,
    attemptNumber: attemptCount + 1,
    maxAttempts,
    startedAt,
    completedAt,
    durationMs: Date.now() - cycleStartedAt,
  }

  if (input.runId) {
    await saveRetroRun(input.runId, run, input.ledger)
  }

  const result = {
    run,
    verification,
    previousRun: previousRun ?? undefined,
    comparison,
    action,
    decision,
    summary,
    trace,
    savedRunId: input.runId,
    savedCycleId: input.cycleId,
  } satisfies RetroCycleResult

  if (input.cycleId) {
    await saveRetroCycle(input.cycleId, result, input.ledger)
  }

  return result
}
