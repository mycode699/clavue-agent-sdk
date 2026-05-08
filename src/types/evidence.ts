/**
 * Evidence and quality gate types for auditability.
 */

export type EvidenceSource = 'tool' | 'skill' | 'hook' | 'agent' | 'eval' | 'external'

export interface Evidence {
  /** Stable evidence category, such as test, build, trace, review, or artifact. */
  type: string
  /** Human-readable evidence summary. */
  summary: string
  /** Component that produced the evidence. */
  source?: EvidenceSource | string
  /** Tool call, skill, hook, or run id that produced this evidence. */
  id?: string
  /** Optional file path, URL, or artifact pointer. */
  location?: string
  /** Additional structured metadata for consumers. */
  metadata?: Record<string, unknown>
}

export type QualityGateStatus = 'passed' | 'failed' | 'skipped' | 'pending'

export interface QualityGateResult {
  /** Stable gate name, such as build, tests, lint, review, or skill:<name>. */
  name: string
  status: QualityGateStatus
  summary?: string
  evidence?: Evidence[]
  metadata?: Record<string, unknown>
}

export interface QualityGatePolicy {
  /** Gate names that must be present and must not have a failing status. Omitted means evaluate all reported gates. */
  required?: string[]
  /** Gate statuses that should make terminal success fail. Defaults to failed. */
  failStatuses?: QualityGateStatus[]
}
