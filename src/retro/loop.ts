import type { AgentRunResult } from '../types.js'
import { runRetroCycle } from './cycle.js'
import { saveRetroCycle } from './ledger.js'
import type {
  RetroActionPlan,
  RetroCycleDecision,
  RetroLoopAttemptHookResult,
  RetroLoopAttemptResult,
  RetroLoopInput,
  RetroLoopResult,
  RetroRunResult,
  RetroSourceRun,
} from './types.js'

function buildCycleId(prefix: string, attemptNumber: number): string {
  return `${prefix}-attempt-${attemptNumber}`
}

function buildRunId(prefix: string, attemptNumber: number): string {
  return `${prefix}-run-${attemptNumber}`
}

function enforceLoopBound(cycle: RetroLoopResult['finalCycle']): RetroLoopResult['finalCycle'] {
  const shouldStop = cycle.decision.shouldRetry && cycle.trace.attemptNumber >= cycle.trace.maxAttempts
  if (!shouldStop) {
    return cycle
  }

  const action: RetroActionPlan = {
    ...cycle.action,
    kind: 'escalate',
    reason: 'Retro loop max attempts reached.',
    priority: 4,
  }
  const decision: RetroCycleDecision = {
    disposition: 'rejected',
    accepted: false,
    shouldRetry: false,
    reason: 'Retro loop max attempts reached.',
  }

  const statusLine = `REJECTED · escalate · ${cycle.summary.findingCount} finding(s)`

  return {
    ...cycle,
    action,
    decision,
    summary: {
      ...cycle.summary,
      text: `${statusLine}. Verification: ${cycle.summary.verificationPassed ? 'passed' : 'failed'}. Retro loop max attempts reached.`,
      statusLine,
      disposition: 'rejected',
      actionKind: 'escalate',
    },
  }
}

function toRetroSourceRun(run: AgentRunResult): RetroSourceRun {
  return {
    id: run.id,
    session_id: run.session_id,
    status: run.status,
    subtype: run.subtype,
    started_at: run.started_at,
    completed_at: run.completed_at,
    duration_ms: run.duration_ms,
    duration_api_ms: run.duration_api_ms,
    total_cost_usd: run.total_cost_usd,
    num_turns: run.num_turns,
    stop_reason: run.stop_reason,
    usage: run.usage,
  }
}

function isAgentRunResult(result: RetroLoopAttemptHookResult): result is AgentRunResult {
  return 'session_id' in result && 'text' in result && 'events' in result && 'messages' in result
}

function normalizeRetryStep(result: RetroLoopAttemptHookResult): RetroLoopAttemptResult {
  if (!isAgentRunResult(result)) {
    return result
  }

  return {
    summary: 'Captured retry agent run artifact.',
    sourceRun: toRetroSourceRun(result),
  }
}

export async function runRetroLoop(input: RetroLoopInput): Promise<RetroLoopResult> {
  const maxAttempts = input.maxAttempts ?? input.policy?.maxAttempts ?? 3
  const idPrefix = input.idPrefix ?? crypto.randomUUID()
  const cycles = []
  let currentSourceRun = input.sourceRun
  let previousRun: RetroRunResult | undefined = input.initialPreviousRun
  let previousRunId: string | undefined = input.initialPreviousRunId
  let finalCycle

  for (let index = 0; index < maxAttempts; index += 1) {
    const attemptCount = (input.initialAttemptCount ?? 0) + index
    const attemptNumber = attemptCount + 1
    const runId = buildRunId(idPrefix, attemptNumber)
    const cycleId = buildCycleId(idPrefix, attemptNumber)
    const cycle = await runRetroCycle({
      target: input.target,
      evaluators: input.evaluators,
      gates: input.gates,
      skillTargetCount: input.skillTargetCount,
      runAt: input.runAt,
      runId,
      cycleId,
      previousRun,
      previousRunId,
      sourceRun: currentSourceRun,
      ledger: input.ledger,
      attemptCount,
      policy: {
        ...input.policy,
        maxAttempts,
      },
    })

    const boundedCycle = enforceLoopBound(cycle)
    if (boundedCycle.savedCycleId && boundedCycle !== cycle) {
      await saveRetroCycle(boundedCycle.savedCycleId, boundedCycle, input.ledger)
    }

    cycles.push(boundedCycle)
    finalCycle = boundedCycle

    if (!boundedCycle.decision.shouldRetry) {
      break
    }

    previousRun = boundedCycle.run
    previousRunId = runId

    const retryStepResult = await input.onAttemptRetry?.({
      attemptCount,
      nextAttemptCount: attemptCount + 1,
      previousCycle: boundedCycle,
      previousRun,
      previousRunId,
      sourceRun: currentSourceRun,
    })

    if (retryStepResult) {
      const retryStep = normalizeRetryStep(retryStepResult)
      boundedCycle.retryStep = retryStep
      if (retryStep.sourceRun) {
        currentSourceRun = retryStep.sourceRun
      }
      if (boundedCycle.savedCycleId) {
        await saveRetroCycle(boundedCycle.savedCycleId, boundedCycle, input.ledger)
      }
    }
  }

  if (!finalCycle) {
    throw new Error('Retro loop requires at least one attempt.')
  }

  return {
    cycles,
    finalCycle,
    summary: {
      disposition: finalCycle.decision.disposition,
      accepted: finalCycle.decision.accepted,
      attemptCount: finalCycle.trace.attemptNumber,
      completedAttempts: cycles.length,
      stoppedReason: finalCycle.decision.reason,
      finalActionKind: finalCycle.action.kind,
      finalScore: finalCycle.run.scores.overall.score,
    },
  }
}
