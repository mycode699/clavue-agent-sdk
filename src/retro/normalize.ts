import type { RetroFinding, RetroNormalizedFinding } from './types.js'

function defaultDisposition(finding: RetroFinding): RetroNormalizedFinding['disposition'] {
  if (finding.disposition) return finding.disposition
  if (finding.severity === 'low') return 'defer'
  return 'fix'
}

export function normalizeFindings(findings: RetroFinding[]): RetroNormalizedFinding[] {
  return findings.map((finding, index) => ({
    id: `finding-${index + 1}`,
    dimension: finding.dimension,
    title: finding.title,
    rationale: finding.rationale,
    severity: finding.severity ?? 'medium',
    confidence: finding.confidence ?? 'medium',
    disposition: defaultDisposition(finding),
    evidence: finding.evidence ?? [],
  }))
}
