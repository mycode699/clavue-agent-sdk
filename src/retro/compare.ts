import {
  RETRO_DIMENSIONS,
  type RetroDimension,
  type RetroNormalizedFinding,
  type RetroRunComparison,
  type RetroRunResult,
} from './types.js'

function findingKey(finding: RetroNormalizedFinding): string {
  return `${finding.dimension}:${finding.title}`
}

function compareFindingSets(
  previous: RetroNormalizedFinding[],
  current: RetroNormalizedFinding[],
): Pick<RetroRunComparison, 'newFindings' | 'resolvedFindings'> {
  const previousMap = new Map(previous.map((finding) => [findingKey(finding), finding]))
  const currentMap = new Map(current.map((finding) => [findingKey(finding), finding]))

  return {
    newFindings: current.filter((finding) => !previousMap.has(findingKey(finding))),
    resolvedFindings: previous.filter((finding) => !currentMap.has(findingKey(finding))),
  }
}

function getScoreValue(result: RetroRunResult, dimension: RetroDimension | 'overall'): number {
  return dimension === 'overall'
    ? result.scores.overall.score
    : result.scores.byDimension[dimension].score
}

export function compareRetroRuns(
  previous: RetroRunResult,
  current: RetroRunResult,
): RetroRunComparison {
  const dimensions: Array<RetroDimension | 'overall'> = [...RETRO_DIMENSIONS, 'overall']

  const scoreDeltas = Object.fromEntries(
    dimensions.map((dimension) => {
      const previousScore = getScoreValue(previous, dimension)
      const currentScore = getScoreValue(current, dimension)

      return [
        dimension,
        {
          previous: previousScore,
          current: currentScore,
          delta: currentScore - previousScore,
        },
      ]
    }),
  ) as RetroRunComparison['scoreDeltas']

  return {
    summary: {
      previousRunAt: previous.run_metadata.runAt,
      currentRunAt: current.run_metadata.runAt,
    },
    scoreDeltas,
    ...compareFindingSets(previous.findings, current.findings),
  }
}
