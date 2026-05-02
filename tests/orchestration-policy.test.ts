import test from 'node:test'
import assert from 'node:assert/strict'

import type { ResolvedWorkflowServiceConfig } from '../src/index.ts'

function baseConfig(overrides: Partial<ResolvedWorkflowServiceConfig> = {}): ResolvedWorkflowServiceConfig {
  return {
    tracker: {
      active_states: ['Todo', 'In Progress', 'Rework'],
      terminal_states: ['Done', 'Closed', 'Cancelled'],
    },
    polling: { interval_ms: 30_000 },
    workspace: { root: '/tmp/workspaces' },
    hooks: { timeout_ms: 60_000 },
    agent: {
      max_concurrent_agents: 2,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
    },
    codex: {
      command: 'codex app-server',
      turn_timeout_ms: 3_600_000,
      read_timeout_ms: 5_000,
      stall_timeout_ms: 300_000,
    },
    ...overrides,
    tracker: {
      active_states: ['Todo', 'In Progress', 'Rework'],
      terminal_states: ['Done', 'Closed', 'Cancelled'],
      ...overrides.tracker,
    },
    agent: {
      max_concurrent_agents: 2,
      max_turns: 20,
      max_retry_backoff_ms: 300_000,
      max_concurrent_agents_by_state: {},
      ...overrides.agent,
    },
  }
}

test('selectDispatchCandidates sorts by priority, age, and identifier within available slots', async () => {
  const { selectDispatchCandidates } = await import('../src/index.ts')
  const selection = selectDispatchCandidates({
    config: baseConfig(),
    issues: [
      { id: '3', identifier: 'SDK-3', title: 'Third', state: 'Todo', priority: 3, created_at: '2026-05-03T00:00:00.000Z' },
      { id: '1', identifier: 'SDK-1', title: 'First', state: 'Todo', priority: 1, created_at: '2026-05-02T00:00:00.000Z' },
      { id: '2', identifier: 'SDK-2', title: 'Second', state: 'Todo', priority: 1, created_at: '2026-05-01T00:00:00.000Z' },
    ],
  })

  assert.deepEqual(selection.selected.map((issue) => issue.identifier), ['SDK-2', 'SDK-1'])
  assert.equal(selection.available_slots, 2)
})

test('selectDispatchCandidates rejects inactive, terminal, claimed, running, and blocked issues', async () => {
  const { selectDispatchCandidates } = await import('../src/index.ts')
  const selection = selectDispatchCandidates({
    config: baseConfig(),
    runtime: {
      claimed: ['claimed'],
      running: {
        running: { issue_id: 'running', issue_identifier: 'SDK-RUN', state: 'In Progress' },
      },
    },
    issues: [
      { id: 'terminal', identifier: 'SDK-DONE', title: 'Done', state: 'Done' },
      { id: 'inactive', identifier: 'SDK-BACKLOG', title: 'Backlog', state: 'Backlog' },
      { id: 'claimed', identifier: 'SDK-CLAIMED', title: 'Claimed', state: 'Todo' },
      { id: 'running', identifier: 'SDK-RUN', title: 'Running', state: 'Todo' },
      {
        id: 'blocked',
        identifier: 'SDK-BLOCKED',
        title: 'Blocked',
        state: 'Todo',
        blocked_by: [{ identifier: 'SDK-DEP', state: 'In Progress' }],
      },
      { id: 'ok', identifier: 'SDK-OK', title: 'Ok', state: 'Todo' },
    ],
  })

  assert.deepEqual(selection.selected.map((issue) => issue.identifier), ['SDK-OK'])
  const reasons = Object.fromEntries(selection.decisions.map((decision) => [decision.issue.id, decision.reason]))
  assert.equal(reasons.terminal, 'terminal state')
  assert.equal(reasons.inactive, 'inactive state')
  assert.equal(reasons.claimed, 'already claimed or running')
  assert.equal(reasons.running, 'already claimed or running')
  assert.equal(reasons.blocked, 'blocked by non-terminal dependency')
})

test('selectDispatchCandidates respects global and per-state concurrency limits', async () => {
  const { selectDispatchCandidates } = await import('../src/index.ts')

  const globalLimited = selectDispatchCandidates({
    config: baseConfig(),
    runtime: {
      running: {
        a: { issue_id: 'a', issue_identifier: 'SDK-A', state: 'In Progress' },
        b: { issue_id: 'b', issue_identifier: 'SDK-B', state: 'Todo' },
      },
    },
    issues: [{ id: 'ok', identifier: 'SDK-OK', title: 'Ok', state: 'Todo' }],
  })

  assert.deepEqual(globalLimited.selected, [])
  assert.equal(globalLimited.decisions[0]?.reason, 'no global slots available')

  const stateLimited = selectDispatchCandidates({
    config: baseConfig({
      agent: {
        max_concurrent_agents: 4,
        max_turns: 20,
        max_retry_backoff_ms: 300_000,
        max_concurrent_agents_by_state: { todo: 1 },
      },
    }),
    runtime: {
      running: {
        a: { issue_id: 'a', issue_identifier: 'SDK-A', state: 'Todo' },
      },
    },
    issues: [
      { id: 'todo', identifier: 'SDK-TODO', title: 'Todo', state: 'Todo' },
      { id: 'rework', identifier: 'SDK-REWORK', title: 'Rework', state: 'Rework' },
    ],
  })

  assert.deepEqual(stateLimited.selected.map((issue) => issue.identifier), ['SDK-REWORK'])
  assert.equal(stateLimited.decisions.find((decision) => decision.issue.id === 'todo')?.reason, 'no state slots available')
})

test('calculateRetryDelayMs implements continuation and capped exponential retry policy', async () => {
  const { calculateRetryDelayMs } = await import('../src/index.ts')

  assert.equal(calculateRetryDelayMs({ attempt: 1 }), 10_000)
  assert.equal(calculateRetryDelayMs({ attempt: 3 }), 40_000)
  assert.equal(calculateRetryDelayMs({ attempt: 10, max_retry_backoff_ms: 60_000 }), 60_000)
  assert.equal(calculateRetryDelayMs({ attempt: 5, continuation: true }), 1_000)
  assert.equal(calculateRetryDelayMs({ attempt: 5, continuation: true, continuation_delay_ms: 2_500 }), 2_500)
})

test('shouldReleaseIssueForState returns host-neutral release decisions', async () => {
  const { shouldReleaseIssueForState } = await import('../src/index.ts')
  const config = baseConfig()

  assert.deepEqual(shouldReleaseIssueForState('Done', config), { release: true, reason: 'terminal' })
  assert.deepEqual(shouldReleaseIssueForState('Backlog', config), { release: true, reason: 'inactive' })
  assert.deepEqual(shouldReleaseIssueForState(undefined, config), { release: true, reason: 'missing' })
  assert.deepEqual(shouldReleaseIssueForState('Todo', config), { release: false })
})
