/**
 * Slice F — unified WorkItem core type.
 *
 * Three workflow data shapes (WorkflowDefinition / OrchestrationIssue /
 * IssueWorkflowRecord) collapse into a single `WorkItem` (id, title,
 * acceptance, status, evidence, links). Original shapes remain as view
 * layers; this module adds pure converters in both directions plus a
 * canonical status mapping.
 *
 * Zero new runtime deps. No changes to existing modules.
 */
import type {
  WorkflowDefinition,
  WorkflowConfigValue,
} from '../workflow-contract.js'
import type {
  OrchestrationIssue,
  OrchestrationBlockerRef,
} from '../orchestration-policy.js'
import type {
  IssueWorkflowRecord,
  IssueWorkflowRunRecord,
  IssueWorkflowStatus,
} from '../issue-workflow.js'

export type WorkItemStatus =
  | 'pending'
  | 'active'
  | 'blocked'
  | 'completed'
  | 'cancelled'
  | 'failed'

export interface WorkItemLink {
  rel: string
  href: string
}

export interface WorkItem {
  id: string
  title: string
  acceptance: string[]
  status: WorkItemStatus
  evidence: Record<string, unknown>
  links: WorkItemLink[]
  /** Original status string from the source view, preserved for lossless round-trip. */
  rawStatus?: string
}

const STATUS_TO_STRING: Record<WorkItemStatus, string> = {
  pending: 'Todo',
  active: 'In Progress',
  blocked: 'Blocked',
  completed: 'Done',
  cancelled: 'Cancelled',
  failed: 'Failed',
}

const ISSUE_WORKFLOW_STATUS_MAP: Record<IssueWorkflowStatus, WorkItemStatus> = {
  queued: 'pending',
  running: 'active',
  completed: 'completed',
  failed_gate: 'failed',
  failed_review: 'failed',
  blocked_by_policy: 'blocked',
  max_iterations: 'failed',
  cancelled: 'cancelled',
  error: 'failed',
}

/** Map a free-form state string (Linear-ish) onto a WorkItemStatus. */
export function normalizeStateToWorkItemStatus(state: string | null | undefined): WorkItemStatus {
  if (!state) return 'pending'
  const normalized = state.trim().toLowerCase()
  if (['todo', 'backlog', 'triage', 'queued'].includes(normalized)) return 'pending'
  if (['in progress', 'in_progress', 'running', 'active', 'started'].includes(normalized)) return 'active'
  if (['blocked', 'on hold', 'paused', 'blocked_by_policy'].includes(normalized)) return 'blocked'
  if (['done', 'closed', 'completed', 'duplicate'].includes(normalized)) return 'completed'
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled'
  if (['failed', 'error', 'failed_gate', 'failed_review', 'max_iterations'].includes(normalized)) return 'failed'
  return 'pending'
}

// --- forward converters: view → WorkItem -----------------------------------

export interface WorkflowDefinitionToWorkItemOptions {
  id?: string
  title?: string
}

export function workflowDefinitionToWorkItem(
  definition: WorkflowDefinition,
  options: WorkflowDefinitionToWorkItemOptions = {},
): WorkItem {
  const configId = stringFromConfig(definition.config.id)
  const configTitle = stringFromConfig(definition.config.title)
  const id = options.id ?? configId ?? 'workflow'
  const title = options.title ?? configTitle ?? 'Workflow'
  const evidence: Record<string, unknown> = {
    config: definition.config,
    prompt_template: definition.prompt_template,
  }
  if (definition.directory) evidence.directory = definition.directory

  const links: WorkItemLink[] = []
  if (definition.path) links.push({ rel: 'workflow_file', href: definition.path })

  return {
    id,
    title,
    acceptance: [],
    status: 'pending',
    evidence,
    links,
  }
}

export function orchestrationIssueToWorkItem(issue: OrchestrationIssue): WorkItem {
  const evidence: Record<string, unknown> = {
    identifier: issue.identifier,
  }
  if (issue.priority !== undefined && issue.priority !== null) evidence.priority = issue.priority
  if (issue.blocked_by !== undefined) evidence.blocked_by = issue.blocked_by
  if (issue.description !== undefined && issue.description !== null) evidence.description = issue.description
  if (issue.body !== undefined && issue.body !== null) evidence.body = issue.body
  if (issue.labels !== undefined) evidence.labels = issue.labels
  if (issue.created_at !== undefined && issue.created_at !== null) evidence.created_at = issue.created_at
  if (issue.updated_at !== undefined && issue.updated_at !== null) evidence.updated_at = issue.updated_at

  const links: WorkItemLink[] = []
  if (issue.url) links.push({ rel: 'tracker', href: issue.url })
  if (issue.branch_name) links.push({ rel: 'branch', href: issue.branch_name })

  return {
    id: issue.id,
    title: issue.title,
    acceptance: [],
    status: normalizeStateToWorkItemStatus(issue.state),
    rawStatus: issue.state,
    evidence,
    links,
  }
}

export interface IssueWorkflowRecordToWorkItemOptions {
  run?: IssueWorkflowRunRecord
}

export function issueWorkflowRecordToWorkItem(
  record: IssueWorkflowRecord,
  options: IssueWorkflowRecordToWorkItemOptions = {},
): WorkItem {
  const run = options.run
  const evidence: Record<string, unknown> = {
    body: record.body,
    labels: record.labels,
    source_kind: record.source.type,
  }
  if (record.priority !== undefined) evidence.priority = record.priority
  if (record.source.path) evidence.source_path = record.source.path
  if (run) {
    evidence.run_id = run.id
    evidence.correlation_id = run.correlation_id
    evidence.batch_id = run.batch_id
    evidence.required_gates = run.requiredGates
    evidence.passing_score = run.passingScore
    if (run.finalScore !== undefined) evidence.final_score = run.finalScore
    if (run.errors) evidence.errors = run.errors
  }

  const links: WorkItemLink[] = []
  if (record.source.path) links.push({ rel: 'source', href: record.source.path })
  if (run?.workspace.cwd) links.push({ rel: 'workspace', href: run.workspace.cwd })

  return {
    id: record.id,
    title: record.title,
    acceptance: [],
    status: run ? ISSUE_WORKFLOW_STATUS_MAP[run.status] : 'pending',
    rawStatus: run?.status,
    evidence,
    links,
  }
}

// --- reverse converters: WorkItem → view -----------------------------------

export function workItemToOrchestrationIssue(item: WorkItem): OrchestrationIssue {
  const ev = item.evidence
  const findLink = (rel: string) => item.links.find((link) => link.rel === rel)?.href
  const issue: OrchestrationIssue = {
    id: item.id,
    identifier: typeof ev.identifier === 'string' ? ev.identifier : item.id,
    title: item.title,
    state: item.rawStatus ?? STATUS_TO_STRING[item.status],
  }
  if (typeof ev.priority === 'number' || typeof ev.priority === 'string') issue.priority = ev.priority
  if (Array.isArray(ev.blocked_by)) issue.blocked_by = ev.blocked_by as OrchestrationBlockerRef[]
  if (typeof ev.description === 'string') issue.description = ev.description
  if (typeof ev.body === 'string') issue.body = ev.body
  if (Array.isArray(ev.labels)) issue.labels = ev.labels.filter((value): value is string => typeof value === 'string')
  if (typeof ev.created_at === 'string') issue.created_at = ev.created_at
  if (typeof ev.updated_at === 'string') issue.updated_at = ev.updated_at
  const tracker = findLink('tracker')
  if (tracker) issue.url = tracker
  const branch = findLink('branch')
  if (branch) issue.branch_name = branch
  return issue
}

export function workItemToIssueWorkflowRecord(item: WorkItem): IssueWorkflowRecord {
  const ev = item.evidence
  const sourceKind = ev.source_kind === 'local-file' ? 'local-file' : 'inline'
  const sourcePath = typeof ev.source_path === 'string' ? ev.source_path : undefined
  const record: IssueWorkflowRecord = {
    id: item.id,
    title: item.title,
    body: typeof ev.body === 'string' ? ev.body : '',
    labels: Array.isArray(ev.labels)
      ? ev.labels.filter((value): value is string => typeof value === 'string')
      : [],
    source: sourcePath ? { type: sourceKind, path: sourcePath } : { type: sourceKind },
  }
  if (typeof ev.priority === 'string') record.priority = ev.priority
  return record
}

// --- helpers ---------------------------------------------------------------

function stringFromConfig(value: WorkflowConfigValue | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined
}
