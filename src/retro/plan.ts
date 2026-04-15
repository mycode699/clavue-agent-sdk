import type {
  RetroNormalizedFinding,
  RetroRecommendation,
  RetroWorkstream,
  RetroWorkstreamBucket,
} from './types.js'

const PRIORITY_BY_BUCKET: Record<RetroWorkstreamBucket, number> = {
  fix_now: 1,
  investigate_next: 2,
  preserve_strengths: 3,
  defer: 4,
}

const SEVERITY_RANK: Record<RetroNormalizedFinding['severity'], number> = {
  critical: 1,
  high: 2,
  medium: 3,
  low: 4,
}

function toBucket(finding: RetroNormalizedFinding): RetroWorkstreamBucket {
  switch (finding.disposition) {
    case 'preserve':
      return 'preserve_strengths'
    case 'investigate':
      return 'investigate_next'
    case 'defer':
      return 'defer'
    default:
      return 'fix_now'
  }
}

export function planUpgrades(findings: RetroNormalizedFinding[]): {
  recommendations: RetroRecommendation[]
  proposed_workstreams: RetroWorkstream[]
} {
  const workstreams = findings
    .map((finding) => {
      const bucket = toBucket(finding)
      return {
        title: finding.title,
        dimension: finding.dimension,
        priority: PRIORITY_BY_BUCKET[bucket],
        bucket,
        findingIds: [finding.id],
        severityRank: SEVERITY_RANK[finding.severity],
      }
    })
    .sort((a, b) => {
      return a.priority - b.priority || a.severityRank - b.severityRank || a.title.localeCompare(b.title)
    })
    .map(({ severityRank: _severityRank, ...workstream }) => workstream satisfies RetroWorkstream)

  const recommendations = workstreams.map((workstream) => ({
    dimension: workstream.dimension,
    priority: workstream.priority,
    action: workstream.bucket,
    summary: `${workstream.bucket}: ${workstream.title}`,
    findingIds: workstream.findingIds,
  }))

  return {
    recommendations,
    proposed_workstreams: workstreams,
  }
}
