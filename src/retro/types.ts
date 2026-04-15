export const RETRO_DIMENSIONS = [
  'compatibility',
  'stability',
  'interaction_logic',
  'reliability',
] as const

export type RetroDimension = (typeof RETRO_DIMENSIONS)[number]
export type RetroSeverity = 'low' | 'medium' | 'high' | 'critical'
export type RetroConfidence = 'low' | 'medium' | 'high'
export type RetroDisposition = 'fix' | 'investigate' | 'preserve' | 'defer'
export type RetroEvidenceKind = 'file' | 'doc' | 'command' | 'note'
export type RetroWorkstreamBucket =
  | 'fix_now'
  | 'investigate_next'
  | 'preserve_strengths'
  | 'defer'

export interface RetroEvidence {
  kind: RetroEvidenceKind
  location: string
  detail: string
}

export interface RetroFinding {
  dimension: RetroDimension
  title: string
  rationale: string
  severity?: RetroSeverity
  confidence?: RetroConfidence
  disposition?: RetroDisposition
  evidence?: RetroEvidence[]
}

export interface RetroNormalizedFinding {
  id: string
  dimension: RetroDimension
  title: string
  rationale: string
  severity: RetroSeverity
  confidence: RetroConfidence
  disposition: RetroDisposition
  evidence: RetroEvidence[]
}

export interface RetroScore {
  dimension: RetroDimension | 'overall'
  score: number
  rationale: string
}

export interface RetroScores {
  byDimension: Record<RetroDimension, RetroScore>
  overall: RetroScore
}

export interface RetroRecommendation {
  dimension: RetroDimension
  priority: number
  action: RetroWorkstreamBucket
  summary: string
  findingIds: string[]
}

export interface RetroWorkstream {
  title: string
  dimension: RetroDimension
  priority: number
  bucket: RetroWorkstreamBucket
  findingIds: string[]
}

export interface RetroTarget {
  name: string
  cwd?: string
}

export interface RetroRunMetadata {
  target: RetroTarget
  runAt: string
  evaluatorCount: number
}

export interface RetroRunInput {
  target: RetroTarget
  evaluators: RetroEvaluator[]
  runAt?: string
}

export interface RetroEvaluatorResult {
  findings: RetroFinding[]
}

export type RetroEvaluator = (
  input: RetroRunInput,
) => Promise<RetroEvaluatorResult> | RetroEvaluatorResult

export interface RetroRunResult {
  summary: string
  findings: RetroNormalizedFinding[]
  scores: RetroScores
  recommendations: RetroRecommendation[]
  proposed_workstreams: RetroWorkstream[]
  evidence: RetroEvidence[]
  run_metadata: RetroRunMetadata
}

export type RetroActionKind =
  | 'attempt_fix'
  | 'retest'
  | 'retry_with_more_context'
  | 'escalate'
  | 'defer'
  | 'stop'

export interface RetroPolicy {
  maxAttempts?: number
  minimumOverallScore?: number
  escalateSeverity?: RetroSeverity
  allowedActions?: RetroActionKind[]
}

export interface RetroPolicyInput {
  run: RetroRunResult
  previousRun?: RetroRunResult
  comparison?: {
    scoreDeltas: Record<RetroDimension | 'overall', { delta: number }>
  }
  attemptCount?: number
  policy?: RetroPolicy
}

export interface RetroActionPlan {
  kind: RetroActionKind
  reason: string
  priority: number
  findingIds: string[]
  constraints: Record<string, unknown>
}
