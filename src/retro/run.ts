import { normalizeFindings } from './normalize.js'
import { planUpgrades } from './plan.js'
import { scoreFindings } from './score.js'
import type { RetroRunInput, RetroRunResult } from './types.js'

export async function runRetroEvaluation(input: RetroRunInput): Promise<RetroRunResult> {
  const evaluatorResults = await Promise.all(input.evaluators.map((evaluator) => evaluator(input)))
  const findings = normalizeFindings(
    evaluatorResults.flatMap((result) => result.findings),
  )
  const scores = scoreFindings(findings)
  const { recommendations, proposed_workstreams } = planUpgrades(findings)
  const evidence = findings.flatMap((finding) => finding.evidence)

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
    },
  }
}
