import {
  RETRO_DIMENSIONS,
  type RetroDimension,
  type RetroNormalizedFinding,
  type RetroScore,
  type RetroScores,
} from './types.js'

const SEVERITY_DEDUCTION: Record<RetroNormalizedFinding['severity'], number> = {
  low: 5,
  medium: 15,
  high: 30,
  critical: 50,
}

function scoreDimension(
  dimension: RetroDimension,
  findings: RetroNormalizedFinding[],
): RetroScore {
  const relevant = findings.filter((finding) => finding.dimension === dimension)
  const penalty = relevant.reduce((total, finding) => {
    if (finding.disposition === 'preserve') return total
    return total + SEVERITY_DEDUCTION[finding.severity]
  }, 0)
  const score = Math.max(0, 100 - penalty)
  const rationale =
    relevant.length === 0
      ? 'No findings recorded for this dimension.'
      : `${relevant.length} finding(s), penalty ${penalty}.`

  return { dimension, score, rationale }
}

export function scoreFindings(findings: RetroNormalizedFinding[]): RetroScores {
  const byDimension = Object.fromEntries(
    RETRO_DIMENSIONS.map((dimension) => [dimension, scoreDimension(dimension, findings)]),
  ) as Record<RetroDimension, RetroScore>

  const overallScore = Math.round(
    RETRO_DIMENSIONS.reduce((sum, dimension) => sum + byDimension[dimension].score, 0) /
      RETRO_DIMENSIONS.length,
  )

  return {
    byDimension,
    overall: {
      dimension: 'overall',
      score: overallScore,
      rationale: 'Average of all dimension scores.',
    },
  }
}
