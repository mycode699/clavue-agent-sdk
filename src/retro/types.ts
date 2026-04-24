import type { AgentRunResult, AgentRunStatus, TokenUsage } from '../types.js'

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

export interface RetroSourceRun {
  id: string
  session_id: string
  status: AgentRunStatus
  subtype: string
  started_at: string
  completed_at: string
  duration_ms: number
  duration_api_ms: number
  total_cost_usd: number
  num_turns: number
  stop_reason: string | null
  usage: TokenUsage
}

export interface RetroRunMetadata {
  target: RetroTarget
  runAt: string
  evaluatorCount: number
  evaluatorSuccessCount?: number
  evaluatorFailureCount?: number
  durationMs?: number
  evaluators?: RetroEvaluatorRunMetadata[]
  sourceRun?: RetroSourceRun
}

export interface RetroLedgerOptions {
  dir?: string
}

export interface RetroScoreDelta {
  previous: number
  current: number
  delta: number
}

export interface RetroRunComparisonSummary {
  previousRunAt: string
  currentRunAt: string
}

export interface RetroRunComparison {
  summary: RetroRunComparisonSummary
  scoreDeltas: Record<RetroDimension | 'overall', RetroScoreDelta>
  newFindings: RetroNormalizedFinding[]
  resolvedFindings: RetroNormalizedFinding[]
}

export interface RetroRunInput {
  target: RetroTarget
  evaluators: RetroEvaluator[]
  runAt?: string
  sourceRun?: RetroSourceRun
}

export interface RetroCycleInput {
  target: RetroTarget
  evaluators?: RetroEvaluator[]
  gates?: RetroQualityGate[]
  runAt?: string
  runId?: string
  cycleId?: string
  previousRunId?: string
  previousRun?: RetroRunResult
  sourceRun?: RetroSourceRun
  ledger?: RetroLedgerOptions
  attemptCount?: number
  policy?: RetroPolicy
}

export type RetroCycleDisposition = 'accepted' | 'rejected' | 'retry'

export interface RetroCycleDecision {
  disposition: RetroCycleDisposition
  accepted: boolean
  shouldRetry: boolean
  reason: string
}

export interface RetroCycleSummary {
  text: string
  statusLine: string
  findingCount: number
  verificationPassed: boolean
  actionKind: RetroActionKind
  disposition: RetroCycleDisposition
}

export interface RetroCycleTrace {
  cycleId?: string
  runId?: string
  previousRunId?: string
  sourceRunId?: string
  sourceSessionId?: string
  attemptCount: number
  attemptNumber: number
  maxAttempts: number
  startedAt: string
  completedAt: string
  durationMs: number
}

export interface RetroLoopAttemptResult {
  summary: string
  changed?: boolean
  sourceRun?: RetroSourceRun
  metadata?: Record<string, unknown>
}

export interface RetroCycleResult {
  run: RetroRunResult
  verification?: RetroVerificationResult
  previousRun?: RetroRunResult
  comparison?: RetroRunComparison
  action: RetroActionPlan
  decision: RetroCycleDecision
  summary: RetroCycleSummary
  trace: RetroCycleTrace
  retryStep?: RetroLoopAttemptResult
  savedRunId?: string
  savedCycleId?: string
}

export interface RetroLoopAttemptContext {
  attemptCount: number
  nextAttemptCount: number
  previousCycle: RetroCycleResult
  previousRun: RetroRunResult
  previousRunId: string
  sourceRun?: RetroSourceRun
}

export type RetroLoopAttemptHookResult = RetroLoopAttemptResult | AgentRunResult

export type RetroLoopAttemptHook = (
  input: RetroLoopAttemptContext,
) => Promise<RetroLoopAttemptHookResult | void> | RetroLoopAttemptHookResult | void

export interface RetroLoopInput extends Omit<RetroCycleInput, 'attemptCount' | 'previousRun' | 'previousRunId' | 'runId' | 'cycleId'> {
  idPrefix?: string
  maxAttempts?: number
  initialAttemptCount?: number
  initialPreviousRunId?: string
  initialPreviousRun?: RetroRunResult
  onAttemptRetry?: RetroLoopAttemptHook
}

export interface RetroLoopSummary {
  disposition: RetroCycleDisposition
  accepted: boolean
  attemptCount: number
  completedAttempts: number
  stoppedReason: string
  finalActionKind: RetroActionKind
  finalScore: number
}

export interface RetroLoopResult {
  cycles: RetroCycleResult[]
  finalCycle: RetroCycleResult
  summary: RetroLoopSummary
}

export interface RetroEvaluatorResult {
  findings: RetroFinding[]
}

export interface RetroEvaluatorRunMetadata {
  index: number
  status: 'fulfilled' | 'rejected'
  findingCount: number
  durationMs: number
  error?: string
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
  verification?: RetroVerificationResult
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
  verification?: RetroVerificationResult
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

export interface RetroQualityGate {
  name: string
  command: string
  args?: string[]
  cwd?: string
  timeoutMs?: number
  continueOnFailure?: boolean
}

export interface RetroQualityGateResult {
  name: string
  command: string
  args: string[]
  cwd?: string
  passed: boolean
  exitCode: number | null
  durationMs: number
  stdout: string
  stderr: string
  error?: string
}

export interface RetroVerificationInput {
  target: RetroTarget
  gates?: RetroQualityGate[]
}

export interface RetroVerificationResult {
  passed: boolean
  summary: string
  startedAt: string
  completedAt: string
  durationMs: number
  gates: RetroQualityGateResult[]
}
