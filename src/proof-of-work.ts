import { createHash } from 'node:crypto'

import type { AgentJobRecord } from './agent-jobs.js'
import type { IssueWorkflowFinding, IssueWorkflowRunRecord, IssueWorkflowStatus } from './issue-workflow.js'
import type { AgentRunResult, Evidence, QualityGateResult, QualityGateStatus, TokenUsage } from './types.js'

export const PROOF_OF_WORK_SCHEMA_VERSION = '1.0.0'

export type ProofOfWorkStatus = 'passed' | 'failed' | 'blocked' | 'needs_review' | 'in_progress' | 'unknown'

export type ProofOfWorkReferenceType =
  | 'issue'
  | 'pull_request'
  | 'ci'
  | 'commit'
  | 'artifact'
  | 'review'
  | 'dashboard'
  | 'log'
  | 'other'

export interface ProofOfWorkReference {
  type: ProofOfWorkReferenceType
  label: string
  url?: string
  id?: string
  status?: string
  metadata?: Record<string, unknown>
}

export interface ProofOfWorkTarget {
  kind: 'issue' | 'workflow' | 'run' | 'job' | 'task' | 'other'
  id?: string
  title?: string
  url?: string
  metadata?: Record<string, unknown>
}

export interface ProofOfWorkVerificationSummary {
  required_gates: string[]
  passed_gates: string[]
  failed_gates: string[]
  pending_gates: string[]
  skipped_gates: string[]
  missing_gates: string[]
}

export interface ProofOfWorkRunSummary {
  id: string
  session_id?: string
  status?: string
  subtype?: string
  num_turns?: number
  duration_ms?: number
  total_cost_usd?: number
  usage?: TokenUsage
}

export interface ProofOfWorkJobSummary {
  id: string
  kind: string
  status: string
  batch_id?: string
  correlation_id?: string
  runnerId?: string
}

export interface ProofOfWorkIssueWorkflowSummary {
  id: string
  status: string
  finalScore?: number
  job_count: number
  required_gates: string[]
}

export interface ProofOfWorkHandoff {
  ready_for_human_review: boolean
  reason: string
}

export interface ProofOfWorkIssueWorkflowInput {
  run: IssueWorkflowRunRecord
  status: IssueWorkflowStatus
  finalScore?: number
  unresolvedFindings: IssueWorkflowFinding[]
  quality_gates: QualityGateResult[]
}

export interface ProofOfWorkArtifact {
  schema_version: string
  id: string
  status: ProofOfWorkStatus
  summary: string
  generated_at: string
  target?: ProofOfWorkTarget
  run?: ProofOfWorkRunSummary
  job?: ProofOfWorkJobSummary
  issue_workflow?: ProofOfWorkIssueWorkflowSummary
  evidence: Evidence[]
  quality_gates: QualityGateResult[]
  verification: ProofOfWorkVerificationSummary
  references: ProofOfWorkReference[]
  risks: string[]
  next_actions: string[]
  handoff: ProofOfWorkHandoff
  metadata?: Record<string, unknown>
}

export interface CreateProofOfWorkInput {
  id?: string
  generated_at?: string
  summary?: string
  target?: ProofOfWorkTarget
  run?: AgentRunResult
  job?: AgentJobRecord
  issueWorkflow?: ProofOfWorkIssueWorkflowInput
  evidence?: Evidence[]
  quality_gates?: QualityGateResult[]
  required_gates?: string[]
  references?: ProofOfWorkReference[]
  risks?: string[]
  next_actions?: string[]
  metadata?: Record<string, unknown>
}

function evidenceKey(evidence: Evidence): string {
  return [evidence.type, evidence.source || '', evidence.id || '', evidence.location || '', evidence.summary].join('\u0000')
}

function gateKey(gate: QualityGateResult): string {
  return [gate.name, gate.status, gate.summary || ''].join('\u0000')
}

function referenceKey(reference: ProofOfWorkReference): string {
  return [reference.type, reference.id || '', reference.url || '', reference.label].join('\u0000')
}

function uniqueBy<T>(items: T[], key: (item: T) => string): T[] {
  const seen = new Set<string>()
  const output: T[] = []
  for (const item of items) {
    const itemKey = key(item)
    if (seen.has(itemKey)) continue
    seen.add(itemKey)
    output.push(item)
  }
  return output
}

function gatesWithStatus(gates: QualityGateResult[], status: QualityGateStatus): string[] {
  return gates.filter((gate) => gate.status === status).map((gate) => gate.name).sort()
}

function createVerificationSummary(
  qualityGates: QualityGateResult[],
  requiredGates: string[],
): ProofOfWorkVerificationSummary {
  const passed = new Set(gatesWithStatus(qualityGates, 'passed'))
  return {
    required_gates: [...requiredGates].sort(),
    passed_gates: gatesWithStatus(qualityGates, 'passed'),
    failed_gates: gatesWithStatus(qualityGates, 'failed'),
    pending_gates: gatesWithStatus(qualityGates, 'pending'),
    skipped_gates: gatesWithStatus(qualityGates, 'skipped'),
    missing_gates: requiredGates.filter((gate) => !passed.has(gate)).sort(),
  }
}

function hasRunningSignal(input: CreateProofOfWorkInput): boolean {
  return input.job?.status === 'queued'
    || input.job?.status === 'running'
    || input.issueWorkflow?.status === 'running'
    || input.issueWorkflow?.status === 'queued'
}

function hasBlockedSignal(input: CreateProofOfWorkInput): boolean {
  return input.job?.status === 'cancelled'
    || input.job?.status === 'stale'
    || input.issueWorkflow?.status === 'cancelled'
    || input.issueWorkflow?.status === 'blocked_by_policy'
}

function hasFailedSignal(input: CreateProofOfWorkInput, verification: ProofOfWorkVerificationSummary): boolean {
  return verification.failed_gates.length > 0
    || input.run?.status === 'errored'
    || input.job?.status === 'failed'
    || input.issueWorkflow?.status === 'failed_gate'
    || input.issueWorkflow?.status === 'failed_review'
    || input.issueWorkflow?.status === 'max_iterations'
    || input.issueWorkflow?.status === 'error'
}

function hasCompletedSignal(input: CreateProofOfWorkInput): boolean {
  return input.run?.status === 'completed'
    || input.job?.status === 'completed'
    || input.issueWorkflow?.status === 'completed'
}

function deriveProofOfWorkStatus(
  input: CreateProofOfWorkInput,
  evidence: Evidence[],
  qualityGates: QualityGateResult[],
  verification: ProofOfWorkVerificationSummary,
): ProofOfWorkStatus {
  if (hasFailedSignal(input, verification)) return 'failed'
  if (hasBlockedSignal(input)) return 'blocked'
  if (hasRunningSignal(input)) return 'in_progress'
  if (verification.missing_gates.length > 0 || verification.pending_gates.length > 0) return 'needs_review'
  if (hasCompletedSignal(input)) {
    if (verification.required_gates.length > 0 || qualityGates.length > 0 || evidence.length > 0) return 'passed'
    return 'needs_review'
  }
  if (qualityGates.length > 0 && verification.failed_gates.length === 0 && verification.pending_gates.length === 0) return 'passed'
  if (evidence.length > 0) return 'needs_review'
  return 'unknown'
}

function createArtifactId(input: CreateProofOfWorkInput, generatedAt: string): string {
  if (input.id) return input.id
  const stableInput = JSON.stringify({
    target: input.target,
    run: input.run?.id,
    job: input.job?.id,
    issueWorkflow: input.issueWorkflow?.run.id,
    generatedAt,
  })
  return `proof_${createHash('sha1').update(stableInput).digest('hex').slice(0, 16)}`
}

function defaultSummary(input: CreateProofOfWorkInput, status: ProofOfWorkStatus): string {
  const title = input.target?.title
    || input.issueWorkflow?.run.issue.title
    || input.job?.description
    || input.run?.subtype
    || 'Agent work'
  return `${title}: ${status.replace(/_/g, ' ')}`
}

function handoffForStatus(status: ProofOfWorkStatus, verification: ProofOfWorkVerificationSummary): ProofOfWorkHandoff {
  if (status === 'passed') {
    return {
      ready_for_human_review: true,
      reason: 'Required gates passed and no failing signal was reported.',
    }
  }

  if (status === 'needs_review') {
    return {
      ready_for_human_review: true,
      reason: verification.missing_gates.length > 0
        ? `Missing required gates: ${verification.missing_gates.join(', ')}.`
        : 'No hard failure was reported, but verification is incomplete.',
    }
  }

  if (status === 'in_progress') {
    return {
      ready_for_human_review: false,
      reason: 'Work is still running or queued.',
    }
  }

  if (status === 'blocked') {
    return {
      ready_for_human_review: false,
      reason: 'Work was cancelled, blocked by policy, or became stale.',
    }
  }

  if (status === 'failed') {
    return {
      ready_for_human_review: false,
      reason: verification.failed_gates.length > 0
        ? `Failed gates: ${verification.failed_gates.join(', ')}.`
        : 'A failed run, job, or workflow signal was reported.',
    }
  }

  return {
    ready_for_human_review: false,
    reason: 'No conclusive work signal was reported.',
  }
}

function collectEvidence(input: CreateProofOfWorkInput): Evidence[] {
  return uniqueBy([
    ...(input.evidence ?? []),
    ...(input.run?.evidence ?? []),
    ...(input.job?.evidence ?? []),
    ...(input.issueWorkflow?.quality_gates.flatMap((gate) => gate.evidence ?? []) ?? []),
  ], evidenceKey)
}

function collectQualityGates(input: CreateProofOfWorkInput): QualityGateResult[] {
  return uniqueBy([
    ...(input.quality_gates ?? []),
    ...(input.run?.quality_gates ?? []),
    ...(input.job?.quality_gates ?? []),
    ...(input.issueWorkflow?.quality_gates ?? []),
  ], gateKey)
}

export function createProofOfWork(input: CreateProofOfWorkInput): ProofOfWorkArtifact {
  const generatedAt = input.generated_at || new Date().toISOString()
  const evidence = collectEvidence(input)
  const qualityGates = collectQualityGates(input)
  const requiredGates = input.required_gates ?? input.issueWorkflow?.run.requiredGates ?? []
  const verification = createVerificationSummary(qualityGates, requiredGates)
  const status = deriveProofOfWorkStatus(input, evidence, qualityGates, verification)

  return {
    schema_version: PROOF_OF_WORK_SCHEMA_VERSION,
    id: createArtifactId(input, generatedAt),
    status,
    summary: input.summary || defaultSummary(input, status),
    generated_at: generatedAt,
    target: input.target,
    run: input.run ? {
      id: input.run.id,
      session_id: input.run.session_id,
      status: input.run.status,
      subtype: input.run.subtype,
      num_turns: input.run.num_turns,
      duration_ms: input.run.duration_ms,
      total_cost_usd: input.run.total_cost_usd,
      usage: input.run.usage,
    } : undefined,
    job: input.job ? {
      id: input.job.id,
      kind: input.job.kind,
      status: input.job.status,
      batch_id: input.job.batch_id,
      correlation_id: input.job.correlation_id,
      runnerId: input.job.runnerId,
    } : undefined,
    issue_workflow: input.issueWorkflow ? {
      id: input.issueWorkflow.run.id,
      status: input.issueWorkflow.status,
      finalScore: input.issueWorkflow.finalScore,
      job_count: input.issueWorkflow.run.jobs.length,
      required_gates: [...input.issueWorkflow.run.requiredGates],
    } : undefined,
    evidence,
    quality_gates: qualityGates,
    verification,
    references: uniqueBy(input.references ?? [], referenceKey),
    risks: [...(input.risks ?? [])],
    next_actions: [...(input.next_actions ?? [])],
    handoff: handoffForStatus(status, verification),
    metadata: input.metadata,
  }
}
