import { normalizeFindings } from './normalize.js'
import { planUpgrades } from './plan.js'
import { scoreFindings } from './score.js'
import type { RetroEvaluatorRunMetadata, RetroFinding, RetroRunInput, RetroRunResult } from './types.js'

function toEvaluatorFailureFinding(index: number, error: unknown): RetroFinding {
  const message = error instanceof Error ? error.message : String(error)

  return {
    dimension: 'reliability',
    title: `Evaluator ${index + 1} failed`,
    rationale: `Retro evaluator ${index + 1} failed: ${message}`,
    severity: 'high',
    confidence: 'high',
    disposition: 'investigate',
    evidence: [
      {
        kind: 'note',
        location: `retro:evaluator:${index + 1}`,
        detail: message,
      },
    ],
  }
}

export async function runRetroEvaluation(input: RetroRunInput): Promise<RetroRunResult> {
  const startedAt = Date.now()
  const evaluatorOutcomes = await Promise.all(
    input.evaluators.map(async (evaluator, index) => {
      const evaluatorStartedAt = Date.now()

      try {
        const result = await evaluator(input)
        return {
          index,
          status: 'fulfilled' as const,
          result,
          durationMs: Date.now() - evaluatorStartedAt,
        }
      } catch (error) {
        return {
          index,
          status: 'rejected' as const,
          error,
          durationMs: Date.now() - evaluatorStartedAt,
        }
      }
    }),
  )

  const evaluatorMetadata: RetroEvaluatorRunMetadata[] = evaluatorOutcomes.map((outcome) => {
    if (outcome.status === 'fulfilled') {
      return {
        index: outcome.index,
        status: outcome.status,
        findingCount: outcome.result.findings.length,
        durationMs: outcome.durationMs,
      }
    }

    return {
      index: outcome.index,
      status: outcome.status,
      findingCount: 1,
      durationMs: outcome.durationMs,
      error: outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
    }
  })

  const findings = normalizeFindings(
    evaluatorOutcomes.flatMap((outcome) => {
      if (outcome.status === 'fulfilled') {
        return outcome.result.findings
      }

      return [toEvaluatorFailureFinding(outcome.index, outcome.error)]
    }),
  )
  const scores = scoreFindings(findings)
  const { recommendations, proposed_workstreams } = planUpgrades(findings)
  const evidence = findings.flatMap((finding) => finding.evidence)
  const evaluatorFailureCount = evaluatorMetadata.filter((item) => item.status === 'rejected').length
  const evaluatorSuccessCount = evaluatorMetadata.length - evaluatorFailureCount

  return {
    summary: `${input.target.name}: ${findings.length} findings across ${input.evaluators.length} evaluator(s).`,
    findings,
    scores,
    recommendations,
    proposed_workstreams,
    evidence,
    run_metadata: {
      target: input.target,
      runAt: input.runAt ?? new Date().toISOString(),
      evaluatorCount: input.evaluators.length,
      evaluatorSuccessCount,
      evaluatorFailureCount,
      durationMs: Date.now() - startedAt,
      evaluators: evaluatorMetadata,
      sourceRun: input.sourceRun,
      skillTargetCount: input.skillTargetCount,
    },
  }
}
