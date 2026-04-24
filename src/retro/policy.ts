import type { RetroActionKind, RetroActionPlan, RetroPolicyInput } from './types.js'

const ACTION_PRIORITY: Record<RetroActionKind, number> = {
  attempt_fix: 1,
  retest: 2,
  retry_with_more_context: 3,
  escalate: 4,
  defer: 5,
  stop: 6,
}

function buildPlan(
  input: RetroPolicyInput,
  kind: RetroActionKind,
  reason: string,
  findingIds: string[],
): RetroActionPlan {
  return {
    kind,
    reason,
    priority: ACTION_PRIORITY[kind],
    findingIds,
    constraints: {
      attemptCount: input.attemptCount ?? 0,
      maxAttempts: input.policy?.maxAttempts ?? 3,
      minimumOverallScore: input.policy?.minimumOverallScore,
      escalateSeverity: input.policy?.escalateSeverity,
      verificationPassed: input.verification?.passed,
      failedVerificationGate: input.verification?.gates.find((gate) => !gate.passed)?.name,
    },
  }
}

function applyAllowedActions(input: RetroPolicyInput, plan: RetroActionPlan): RetroActionPlan {
  const allowedActions = input.policy?.allowedActions
  if (!allowedActions || allowedActions.includes(plan.kind)) {
    return plan
  }

  for (const kind of ['escalate', 'defer', 'stop'] as const) {
    if (allowedActions.includes(kind)) {
      return buildPlan(input, kind, `Preferred action ${plan.kind} is not allowed.`, plan.findingIds)
    }
  }

  return buildPlan(
    input,
    allowedActions[0] ?? 'stop',
    `Preferred action ${plan.kind} is not allowed.`,
    plan.findingIds,
  )
}

export function decideRetroAction(input: RetroPolicyInput): RetroActionPlan {
  const failedVerificationGate = input.verification?.gates.find((gate) => !gate.passed)

  if (input.verification && !input.verification.passed) {
    return applyAllowedActions(
      input,
      buildPlan(
        input,
        'retest',
        `Verification failed at gate: ${failedVerificationGate?.name ?? 'unknown'}.`,
        [],
      ),
    )
  }

  if (input.run.findings.length === 0) {
    return applyAllowedActions(input, buildPlan(input, 'stop', 'No findings recorded.', []))
  }

  const actionableFindings = input.run.findings.filter(
    (finding) => finding.disposition !== 'preserve' && finding.disposition !== 'defer',
  )

  const severityRank = { low: 0, medium: 1, high: 2, critical: 3 } as const
  const escalateSeverity = input.policy?.escalateSeverity ?? 'high'
  const escalatableFindings = actionableFindings.filter(
    (finding) => severityRank[finding.severity] >= severityRank[escalateSeverity],
  )

  const maxAttempts = input.policy?.maxAttempts
  if (
    typeof maxAttempts === 'number' &&
    typeof input.attemptCount === 'number' &&
    input.attemptCount >= maxAttempts &&
    escalatableFindings.length > 0
  ) {
    return applyAllowedActions(
      input,
      buildPlan(
        input,
        'escalate',
        'Maximum retry attempts reached.',
        escalatableFindings.map((finding) => finding.id),
      ),
    )
  }

  const fixFindings = actionableFindings.filter((finding) => finding.disposition === 'fix')
  const highSeverityFixFindings = fixFindings.filter(
    (finding) => finding.severity === 'high' || finding.severity === 'critical',
  )

  if (highSeverityFixFindings.length > 0) {
    return applyAllowedActions(
      input,
      buildPlan(
        input,
        'attempt_fix',
        'High-severity findings are actionable and should be addressed first.',
        highSeverityFixFindings.map((finding) => finding.id),
      ),
    )
  }

  if (fixFindings.length > 0) {
    return applyAllowedActions(
      input,
      buildPlan(
        input,
        'attempt_fix',
        'Actionable fix findings remain open.',
        fixFindings.map((finding) => finding.id),
      ),
    )
  }

  const minimumOverallScore = input.policy?.minimumOverallScore
  if (
    typeof minimumOverallScore === 'number' &&
    input.run.scores.overall.score < minimumOverallScore &&
    actionableFindings.length > 0
  ) {
    return applyAllowedActions(
      input,
      buildPlan(
        input,
        'attempt_fix',
        'Overall score is below the configured minimum with actionable findings still open.',
        actionableFindings.map((finding) => finding.id),
      ),
    )
  }

  const overallDelta = input.comparison?.scoreDeltas.overall?.delta
  if (typeof overallDelta === 'number' && overallDelta < 0 && actionableFindings.length > 0) {
    return applyAllowedActions(
      input,
      buildPlan(
        input,
        'attempt_fix',
        'Overall score regressed with actionable findings still open.',
        actionableFindings.map((finding) => finding.id),
      ),
    )
  }

  const deferOnly = input.run.findings.every((finding) => finding.disposition === 'defer')
  if (deferOnly) {
    return applyAllowedActions(
      input,
      buildPlan(
        input,
        'defer',
        'All remaining findings are deferred work.',
        input.run.findings.map((finding) => finding.id),
      ),
    )
  }

  const preserveOnly = input.run.findings.every((finding) => finding.disposition === 'preserve')
  if (preserveOnly) {
    return applyAllowedActions(
      input,
      buildPlan(
        input,
        'stop',
        'Only preserve findings remain.',
        input.run.findings.map((finding) => finding.id),
      ),
    )
  }

  return applyAllowedActions(
    input,
    buildPlan(
      input,
      'retest',
      'Baseline comparison not available.',
      input.run.findings.map((finding) => finding.id),
    ),
  )
}
