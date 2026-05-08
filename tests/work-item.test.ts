import { test } from 'node:test'
import { strict as assert } from 'node:assert'

import {
  workflowDefinitionToWorkItem,
  orchestrationIssueToWorkItem,
  issueWorkflowRecordToWorkItem,
  workItemToOrchestrationIssue,
  workItemToIssueWorkflowRecord,
  normalizeStateToWorkItemStatus,
} from '../src/workflow/work-item.js'
import type { WorkflowDefinition } from '../src/workflow-contract.js'
import type { OrchestrationIssue } from '../src/orchestration-policy.js'
import type {
  IssueWorkflowRecord,
  IssueWorkflowRunRecord,
} from '../src/issue-workflow.js'

// --- normalizeStateToWorkItemStatus ----------------------------------------

test('normalizeStateToWorkItemStatus maps Linear-ish active states', () => {
  assert.equal(normalizeStateToWorkItemStatus('Todo'), 'pending')
  assert.equal(normalizeStateToWorkItemStatus('In Progress'), 'active')
  assert.equal(normalizeStateToWorkItemStatus('Done'), 'completed')
  assert.equal(normalizeStateToWorkItemStatus('Cancelled'), 'cancelled')
  assert.equal(normalizeStateToWorkItemStatus('Blocked'), 'blocked')
})

test('normalizeStateToWorkItemStatus handles null and unknowns', () => {
  assert.equal(normalizeStateToWorkItemStatus(null), 'pending')
  assert.equal(normalizeStateToWorkItemStatus(undefined), 'pending')
  assert.equal(normalizeStateToWorkItemStatus('Mystery'), 'pending')
})

test('normalizeStateToWorkItemStatus accepts issueworkflow status strings', () => {
  assert.equal(normalizeStateToWorkItemStatus('failed_gate'), 'failed')
  assert.equal(normalizeStateToWorkItemStatus('blocked_by_policy'), 'blocked')
  assert.equal(normalizeStateToWorkItemStatus('max_iterations'), 'failed')
})

// --- WorkflowDefinition view -----------------------------------------------

test('workflowDefinitionToWorkItem captures config + prompt evidence', () => {
  const definition: WorkflowDefinition = {
    config: { id: 'wf-1', title: 'Triage Bot' },
    prompt_template: 'You handle {{issue.identifier}}',
    path: '/repo/WORKFLOW.md',
    directory: '/repo',
  }
  const item = workflowDefinitionToWorkItem(definition)
  assert.equal(item.id, 'wf-1')
  assert.equal(item.title, 'Triage Bot')
  assert.equal(item.status, 'pending')
  assert.deepEqual(item.evidence.prompt_template, 'You handle {{issue.identifier}}')
  assert.deepEqual(item.links, [{ rel: 'workflow_file', href: '/repo/WORKFLOW.md' }])
})

test('workflowDefinitionToWorkItem falls back to defaults when config missing id/title', () => {
  const item = workflowDefinitionToWorkItem({
    config: {},
    prompt_template: '',
  })
  assert.equal(item.id, 'workflow')
  assert.equal(item.title, 'Workflow')
  assert.deepEqual(item.links, [])
})

// --- OrchestrationIssue round-trip -----------------------------------------

test('OrchestrationIssue → WorkItem → OrchestrationIssue is a stable round-trip', () => {
  const issue: OrchestrationIssue = {
    id: 'issue-100',
    identifier: 'ENG-100',
    title: 'Fix login bug',
    state: 'In Progress',
    priority: 2,
    blocked_by: [{ id: 'issue-99', identifier: 'ENG-99', state: 'Todo' }],
    description: 'User cannot log in.',
    labels: ['bug', 'p1'],
    created_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-08T00:00:00Z',
    url: 'https://linear.app/x/issue/ENG-100',
    branch_name: 'fix/login-bug',
  }
  const item = orchestrationIssueToWorkItem(issue)
  assert.equal(item.id, 'issue-100')
  assert.equal(item.title, 'Fix login bug')
  assert.equal(item.status, 'active')
  assert.equal(item.rawStatus, 'In Progress')
  assert.equal(item.evidence.priority, 2)
  assert.deepEqual(item.evidence.blocked_by, issue.blocked_by)
  const linkRels = item.links.map((l) => l.rel).sort()
  assert.deepEqual(linkRels, ['branch', 'tracker'])

  const restored = workItemToOrchestrationIssue(item)
  assert.deepEqual(restored, issue)
})

test('orchestrationIssueToWorkItem omits absent optional fields cleanly', () => {
  const issue: OrchestrationIssue = {
    id: 'issue-1',
    identifier: 'TEST-1',
    title: 'Minimal',
    state: 'Todo',
  }
  const item = orchestrationIssueToWorkItem(issue)
  assert.equal('priority' in item.evidence, false)
  assert.equal('blocked_by' in item.evidence, false)
  const restored = workItemToOrchestrationIssue(item)
  assert.deepEqual(restored, issue)
})

// --- IssueWorkflowRecord round-trip ----------------------------------------

test('IssueWorkflowRecord → WorkItem → IssueWorkflowRecord round-trip', () => {
  const record: IssueWorkflowRecord = {
    id: 'issue_abc123',
    title: 'Add dark mode',
    body: 'Implement dark mode toggle.',
    labels: ['feature'],
    priority: 'high',
    source: { type: 'local-file', path: '/issues/dark-mode.md' },
  }
  const item = issueWorkflowRecordToWorkItem(record)
  assert.equal(item.id, 'issue_abc123')
  assert.equal(item.title, 'Add dark mode')
  assert.equal(item.status, 'pending')
  const restored = workItemToIssueWorkflowRecord(item)
  assert.deepEqual(restored, record)
})

test('issueWorkflowRecordToWorkItem maps run status when run provided', () => {
  const record: IssueWorkflowRecord = {
    id: 'issue_x',
    title: 'X',
    body: '',
    labels: [],
    source: { type: 'inline' },
  }
  const run = {
    schema_version: '1.0.0',
    id: 'run-1',
    issue: record,
    status: 'failed_gate',
    createdAt: '2026-05-01T00:00:00Z',
    updatedAt: '2026-05-02T00:00:00Z',
    correlation_id: 'corr-1',
    batch_id: 'batch-1',
    workspace: { cwd: '/work', runtimeNamespace: 'ns', isolation: 'local' },
    jobs: [],
    requiredGates: ['lint', 'test'],
    passingScore: 80,
    finalScore: 65,
    errors: ['lint failed'],
  } as unknown as IssueWorkflowRunRecord

  const item = issueWorkflowRecordToWorkItem(record, { run })
  assert.equal(item.status, 'failed')
  assert.equal(item.rawStatus, 'failed_gate')
  assert.equal(item.evidence.run_id, 'run-1')
  assert.deepEqual(item.evidence.required_gates, ['lint', 'test'])
  assert.equal(item.evidence.final_score, 65)
  const workspaceLink = item.links.find((l) => l.rel === 'workspace')
  assert.equal(workspaceLink?.href, '/work')
})

// --- cross-view consistency ------------------------------------------------

test('rawStatus preserved when converting back to OrchestrationIssue', () => {
  const issue: OrchestrationIssue = {
    id: 'issue-2',
    identifier: 'TEST-2',
    title: 'Custom State',
    state: 'In Review', // custom state not in canonical map
  }
  const item = orchestrationIssueToWorkItem(issue)
  // 'In Review' isn't in our normalized lookup, so it falls to 'pending'
  assert.equal(item.status, 'pending')
  // but rawStatus preserves the original string
  assert.equal(item.rawStatus, 'In Review')
  const restored = workItemToOrchestrationIssue(item)
  assert.equal(restored.state, 'In Review')
})

test('workItemToOrchestrationIssue uses canonical string when rawStatus absent', () => {
  const item = {
    id: 'x',
    title: 'X',
    acceptance: [],
    status: 'completed' as const,
    evidence: { identifier: 'X-1' },
    links: [],
  }
  const issue = workItemToOrchestrationIssue(item)
  assert.equal(issue.state, 'Done')
  assert.equal(issue.identifier, 'X-1')
})
