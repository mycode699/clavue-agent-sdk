import type { ResolvedWorkflowServiceConfig, WorkflowIssueInput } from './workflow-contract.js'
import { normalizeWorkflowState } from './workflow-contract.js'

export type OrchestrationReleaseReason = 'terminal' | 'inactive' | 'missing' | 'cancelled' | 'completed'

export interface OrchestrationBlockerRef {
  id?: string | null
  identifier?: string | null
  state?: string | null
}

export interface OrchestrationIssue extends Omit<WorkflowIssueInput, 'blocked_by'> {
  id: string
  identifier: string
  title: string
  state: string
  priority?: number | string | null
  blocked_by?: OrchestrationBlockerRef[]
}

export interface OrchestrationRunningEntry {
  issue_id: string
  issue_identifier: string
  state: string
  started_at?: string
}

export interface OrchestrationRuntimeSnapshot {
  running?: Record<string, OrchestrationRunningEntry>
  claimed?: string[]
}

export interface DispatchCandidateDecision {
  issue: OrchestrationIssue
  eligible: boolean
  reason?: string
}

export interface SelectDispatchCandidatesInput {
  issues: OrchestrationIssue[]
  config: Pick<ResolvedWorkflowServiceConfig, 'tracker' | 'agent'>
  runtime?: OrchestrationRuntimeSnapshot
}

export interface DispatchSelection {
  selected: OrchestrationIssue[]
  decisions: DispatchCandidateDecision[]
  available_slots: number
}

export interface RetryDelayOptions {
  attempt: number
  max_retry_backoff_ms?: number
  continuation?: boolean
  base_delay_ms?: number
  continuation_delay_ms?: number
}

function issuePriorityValue(priority: OrchestrationIssue['priority']): number {
  if (typeof priority === 'number' && Number.isFinite(priority)) return priority
  if (typeof priority === 'string' && /^-?\d+$/.test(priority)) return Number(priority)
  return Number.POSITIVE_INFINITY
}

function issueCreatedAtValue(issue: OrchestrationIssue): number {
  const timestamp = Date.parse(issue.created_at || '')
  return Number.isFinite(timestamp) ? timestamp : Number.POSITIVE_INFINITY
}

function compareIssueDispatchOrder(a: OrchestrationIssue, b: OrchestrationIssue): number {
  const priority = issuePriorityValue(a.priority) - issuePriorityValue(b.priority)
  if (priority !== 0) return priority

  const createdAt = issueCreatedAtValue(a) - issueCreatedAtValue(b)
  if (createdAt !== 0) return createdAt

  return a.identifier.localeCompare(b.identifier)
}

function normalizedSet(values: string[]): Set<string> {
  return new Set(values.map(normalizeWorkflowState))
}

function runningEntries(runtime?: OrchestrationRuntimeSnapshot): OrchestrationRunningEntry[] {
  return Object.values(runtime?.running ?? {})
}

function runningCountByState(runtime: OrchestrationRuntimeSnapshot | undefined, state: string): number {
  const normalized = normalizeWorkflowState(state)
  return runningEntries(runtime).filter((entry) => normalizeWorkflowState(entry.state) === normalized).length
}

function hasRequiredIdentity(issue: OrchestrationIssue): boolean {
  return Boolean(issue.id && issue.identifier && issue.title && issue.state)
}

function hasOpenTodoBlocker(issue: OrchestrationIssue, terminalStates: Set<string>): boolean {
  if (normalizeWorkflowState(issue.state) !== 'todo') return false
  return (issue.blocked_by ?? []).some((blocker) => {
    if (!blocker.state) return true
    return !terminalStates.has(normalizeWorkflowState(blocker.state))
  })
}

function availableGlobalSlots(config: Pick<ResolvedWorkflowServiceConfig, 'agent'>, runtime?: OrchestrationRuntimeSnapshot): number {
  return Math.max(config.agent.max_concurrent_agents - runningEntries(runtime).length, 0)
}

function stateLimit(config: Pick<ResolvedWorkflowServiceConfig, 'agent'>, state: string): number {
  return config.agent.max_concurrent_agents_by_state[normalizeWorkflowState(state)] ?? config.agent.max_concurrent_agents
}

function isClaimed(issue: OrchestrationIssue, runtime?: OrchestrationRuntimeSnapshot): boolean {
  return new Set(runtime?.claimed ?? []).has(issue.id) || Boolean(runtime?.running?.[issue.id])
}

function candidateDecision(
  issue: OrchestrationIssue,
  config: Pick<ResolvedWorkflowServiceConfig, 'tracker' | 'agent'>,
  runtime: OrchestrationRuntimeSnapshot | undefined,
  activeStates: Set<string>,
  terminalStates: Set<string>,
): DispatchCandidateDecision {
  if (!hasRequiredIdentity(issue)) return { issue, eligible: false, reason: 'missing required issue identity fields' }

  const state = normalizeWorkflowState(issue.state)
  if (terminalStates.has(state)) return { issue, eligible: false, reason: 'terminal state' }
  if (!activeStates.has(state)) return { issue, eligible: false, reason: 'inactive state' }
  if (isClaimed(issue, runtime)) return { issue, eligible: false, reason: 'already claimed or running' }
  if (hasOpenTodoBlocker(issue, terminalStates)) return { issue, eligible: false, reason: 'blocked by non-terminal dependency' }
  if (availableGlobalSlots(config, runtime) <= 0) return { issue, eligible: false, reason: 'no global slots available' }
  if (runningCountByState(runtime, issue.state) >= stateLimit(config, issue.state)) {
    return { issue, eligible: false, reason: 'no state slots available' }
  }

  return { issue, eligible: true }
}

export function selectDispatchCandidates(input: SelectDispatchCandidatesInput): DispatchSelection {
  const activeStates = normalizedSet(input.config.tracker.active_states)
  const terminalStates = normalizedSet(input.config.tracker.terminal_states)
  const sortedIssues = [...input.issues].sort(compareIssueDispatchOrder)
  const decisions = sortedIssues.map((issue) => candidateDecision(issue, input.config, input.runtime, activeStates, terminalStates))
  const selected: OrchestrationIssue[] = []
  const claimed = new Set(input.runtime?.claimed ?? [])
  const running: Record<string, OrchestrationRunningEntry> = { ...(input.runtime?.running ?? {}) }
  const mutableRuntime: OrchestrationRuntimeSnapshot = { claimed: [...claimed], running }

  for (const decision of decisions) {
    if (!decision.eligible) continue
    const scopedDecision = candidateDecision(decision.issue, input.config, mutableRuntime, activeStates, terminalStates)
    if (!scopedDecision.eligible) continue
    selected.push(decision.issue)
    claimed.add(decision.issue.id)
    mutableRuntime.claimed = [...claimed]
    mutableRuntime.running = {
      ...mutableRuntime.running,
      [decision.issue.id]: {
        issue_id: decision.issue.id,
        issue_identifier: decision.issue.identifier,
        state: decision.issue.state,
      },
    }
  }

  return {
    selected,
    decisions,
    available_slots: availableGlobalSlots(input.config, input.runtime),
  }
}

export function calculateRetryDelayMs(options: RetryDelayOptions): number {
  if (options.continuation) return options.continuation_delay_ms ?? 1_000
  const attempt = Math.max(Math.floor(options.attempt), 1)
  const baseDelay = options.base_delay_ms ?? 10_000
  const maxDelay = options.max_retry_backoff_ms ?? 300_000
  return Math.min(baseDelay * (2 ** (attempt - 1)), maxDelay)
}

export function shouldReleaseIssueForState(
  state: string | null | undefined,
  config: Pick<ResolvedWorkflowServiceConfig, 'tracker'>,
): { release: boolean; reason?: OrchestrationReleaseReason } {
  if (!state) return { release: true, reason: 'missing' }
  const normalized = normalizeWorkflowState(state)
  if (normalizedSet(config.tracker.terminal_states).has(normalized)) return { release: true, reason: 'terminal' }
  if (!normalizedSet(config.tracker.active_states).has(normalized)) return { release: true, reason: 'inactive' }
  return { release: false }
}
