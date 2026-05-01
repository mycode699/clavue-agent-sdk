import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function createTempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-agent-sdk-issues-'))
}

function normalizeInlineIssue(input: string) {
  const lines = input.trim().split('\n')
  return {
    id: 'inline-test-issue',
    title: lines[0] || 'Untitled issue',
    body: lines.slice(1).join('\n').trim(),
    labels: [],
    source: { type: 'inline' as const },
  }
}

test('normalizeIssueInput creates deterministic inline issue records', async () => {
  const { normalizeIssueInput } = await import('../src/index.ts')

  const first = normalizeIssueInput('Fix streaming retries\n\nProvider retries should preserve trace metadata.')
  const second = normalizeIssueInput('Fix streaming retries\n\nProvider retries should preserve trace metadata.')

  assert.equal(first.id, second.id)
  assert.equal(first.title, 'Fix streaming retries')
  assert.equal(first.body, 'Provider retries should preserve trace metadata.')
  assert.deepEqual(first.source, { type: 'inline' })
  assert.deepEqual(first.labels, [])
})

test('loadLocalIssues reads .clavue/issues markdown files in deterministic order', async () => {
  const cwd = await createTempRepo()
  const issuesDir = join(cwd, '.clavue', 'issues')
  const { loadLocalIssues } = await import('../src/index.ts')

  try {
    await mkdir(issuesDir, { recursive: true })
    await writeFile(join(issuesDir, 'b-second.md'), [
      '---',
      'id: explicit-second',
      'labels: provider, retry',
      'priority: high',
      '---',
      '# Second issue',
      '',
      'Fix provider retry classification.',
    ].join('\n'))
    await writeFile(join(issuesDir, 'a-first.md'), [
      '# First issue',
      '',
      'Normalize local issue inputs.',
    ].join('\n'))
    await writeFile(join(issuesDir, 'ignored.txt'), 'not an issue')

    const issues = await loadLocalIssues({ cwd })

    assert.equal(issues.length, 2)
    assert.equal(issues[0]?.title, 'First issue')
    assert.equal(issues[1]?.id, 'explicit-second')
    assert.equal(issues[1]?.priority, 'high')
    assert.deepEqual(issues[1]?.labels, ['provider', 'retry'])
    assert.ok(issues[0]?.source.path?.endsWith('.clavue/issues/a-first.md'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('createIssueWorkflowRun indexes role-based agent jobs for an issue', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-issue-workflow-runs-'))
  const { createIssueWorkflowRun, getAgentJob, loadIssueWorkflowRun } = await import('../src/index.ts')

  try {
    const issue = {
      id: 'issue-42',
      title: 'Fix provider fallback regression',
      body: 'Fallback should not trigger for non-retryable errors.',
      labels: ['bug'],
      priority: 'high',
      source: { type: 'inline' as const },
    }

    const run = await createIssueWorkflowRun({
      issue,
      cwd: dir,
      requiredGates: ['build', 'tests'],
      passingScore: 85,
      roles: ['builder', 'reviewer'],
    }, { dir, runtimeNamespace: 'issue-run-test' })

    assert.match(run.id, /^issue_run_/)
    assert.equal(run.status, 'queued')
    assert.equal(run.issue.id, issue.id)
    assert.deepEqual(run.requiredGates, ['build', 'tests'])
    assert.equal(run.passingScore, 85)
    assert.equal(run.jobs.length, 2)
    assert.deepEqual(run.jobs.map((job) => job.role), ['builder', 'reviewer'])
    assert.deepEqual(run.jobs.map((job) => job.iteration), [1, 1])

    for (const workflowJob of run.jobs) {
      const job = await getAgentJob(workflowJob.job_id, { dir, runtimeNamespace: 'issue-run-test' })
      assert.equal(job?.correlation_id, run.id)
      assert.equal(job?.batch_id, run.batch_id)
      assert.match(job?.prompt || '', /Fix provider fallback regression/)
      assert.equal(job?.replay?.description, `Issue workflow ${workflowJob.role}: Fix provider fallback regression`)
    }

    assert.deepEqual(await loadIssueWorkflowRun(run.id, { dir, runtimeNamespace: 'issue-run-test' }), run)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runIssueWorkflow records a passing builder-reviewer-verifier loop', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-issue-workflow-loop-'))
  const { getAgentJob, runIssueWorkflow } = await import('../src/index.ts')

  try {
    const result = await runIssueWorkflow({
      issue: normalizeInlineIssue('Repair the retry gate\n\nThe verification gate should pass.'),
      cwd: dir,
      requiredGates: ['tests'],
      passingScore: 90,
      evaluateRole: async ({ role }) => {
        if (role === 'reviewer') return { score: 94, findings: [] }
        if (role === 'verifier') return { gate: 'tests', passed: true, output: 'verifier passed' }
        return { score: 100, findings: [] }
      },
    }, { dir, runtimeNamespace: 'issue-loop-test' })

    assert.equal(result.status, 'completed')
    assert.equal(result.finalScore, 94)
    assert.deepEqual(result.unresolvedFindings, [])
    assert.deepEqual(result.quality_gates, [{ name: 'tests', status: 'passed', summary: 'verifier passed' }])
    assert.deepEqual(result.run.jobs.map((job) => job.role), ['builder', 'reviewer', 'verifier'])

    for (const workflowJob of result.run.jobs) {
      const job = await getAgentJob(workflowJob.job_id, { dir, runtimeNamespace: 'issue-loop-test' })
      assert.equal(job?.status, 'completed')
      assert.equal(job?.correlation_id, result.run.id)
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('parseArgs recognizes issue run subcommands without folding them into the prompt', async () => {
  const { parseArgs } = await import('../src/cli.ts')

  const parsed = parseArgs([
    'issue',
    'run',
    'Fix streaming retries',
    '--passing-score',
    '90',
    '--max-iterations',
    '3',
    '--require-gate',
    'tests,build',
    '--json',
  ])

  assert.equal(parsed.command, 'issue')
  assert.equal(parsed.issue?.action, 'run')
  assert.equal(parsed.issue?.input, 'Fix streaming retries')
  assert.equal(parsed.issue?.passingScore, 90)
  assert.equal(parsed.issue?.maxIterations, 3)
  assert.deepEqual(parsed.issue?.requiredGates, ['tests', 'build'])
  assert.equal(parsed.prompt, '')
  assert.equal(parsed.json, true)
})

test('handleIssueCommand executes local issue run/get/list/stop commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-issue-workflow-command-'))
  const issuePath = join(dir, 'issue.md')
  const { handleIssueCommand, parseArgs } = await import('../src/cli.ts')

  try {
    await writeFile(issuePath, 'CLI command issue\n\nRun this through the issue workflow command.')

    const runPayload = await handleIssueCommand(parseArgs(['issue', 'run', issuePath, '--json']), { dir, runtimeNamespace: 'issue-command-test' })
    assert.equal(runPayload.status, 'queued')
    assert.equal(runPayload.issue.title, 'CLI command issue')
    assert.deepEqual(runPayload.issue.source, { type: 'local-file', path: issuePath })

    const listPayload = await handleIssueCommand(parseArgs(['issue', 'list', '--json']), { dir, runtimeNamespace: 'issue-command-test' })
    assert.deepEqual(listPayload.map((run: any) => run.id), [runPayload.id])

    const getPayload = await handleIssueCommand(parseArgs(['issue', 'get', runPayload.id, '--json']), { dir, runtimeNamespace: 'issue-command-test' })
    assert.equal(getPayload.id, runPayload.id)

    const stopPayload = await handleIssueCommand(parseArgs(['issue', 'stop', runPayload.id, '--json']), { dir, runtimeNamespace: 'issue-command-test' })
    assert.equal(stopPayload.status, 'cancelled')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('handleIssueCommand execute preserves local issue source metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-issue-workflow-execute-'))
  const issuePath = join(dir, 'execute-issue.md')
  const { handleIssueCommand, parseArgs } = await import('../src/cli.ts')

  try {
    await writeFile(issuePath, 'Executable issue\n\nRun the full workflow from a file path.')

    const executePayload = await handleIssueCommand(parseArgs(['issue', 'execute', issuePath, '--json']), { dir, runtimeNamespace: 'issue-execute-test' })

    assert.equal(executePayload.status, 'completed')
    assert.equal(executePayload.run.issue.title, 'Executable issue')
    assert.deepEqual(executePayload.run.issue.source, { type: 'local-file', path: issuePath })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('issue workflow helpers list runs and cancel associated jobs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-issue-workflow-cli-'))
  const { createIssueWorkflowRun, getAgentJob, listIssueWorkflowRuns, stopIssueWorkflowRun } = await import('../src/index.ts')

  try {
    const first = await createIssueWorkflowRun({
      issue: normalizeInlineIssue('First CLI issue'),
      cwd: dir,
      roles: ['builder', 'reviewer'],
    }, { dir, runtimeNamespace: 'issue-cli-test' })
    const second = await createIssueWorkflowRun({
      issue: normalizeInlineIssue('Second CLI issue'),
      cwd: dir,
      roles: ['builder'],
    }, { dir, runtimeNamespace: 'issue-cli-test' })

    const runs = await listIssueWorkflowRuns({ dir, runtimeNamespace: 'issue-cli-test' })
    assert.deepEqual(runs.map((run) => run.id), [second.id, first.id])

    const stopped = await stopIssueWorkflowRun(first.id, 'cli stop', { dir, runtimeNamespace: 'issue-cli-test' })
    assert.equal(stopped?.status, 'cancelled')
    assert.deepEqual(stopped?.jobs.map((job) => job.role), ['builder', 'reviewer'])

    for (const workflowJob of stopped?.jobs ?? []) {
      const job = await getAgentJob(workflowJob.job_id, { dir, runtimeNamespace: 'issue-cli-test' })
      assert.equal(job?.status, 'cancelled')
      assert.equal(job?.error, 'Cancelled: cli stop')
    }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runIssueWorkflow creates a fixer iteration for blocking reviewer findings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-issue-workflow-fixer-'))
  const { runIssueWorkflow } = await import('../src/index.ts')
  let reviewerCalls = 0

  try {
    const result = await runIssueWorkflow({
      issue: normalizeInlineIssue('Fix unsafe shell command\n\nThe reviewer should require one fix.'),
      cwd: dir,
      requiredGates: ['tests'],
      passingScore: 90,
      maxIterations: 2,
      evaluateRole: async ({ role }) => {
        if (role === 'reviewer') {
          reviewerCalls += 1
          return reviewerCalls === 1
            ? { score: 72, findings: [{ severity: 'p1', message: 'Unsafe shell command remains' }] }
            : { score: 96, findings: [] }
        }
        if (role === 'verifier') return { gate: 'tests', passed: true, output: 'tests passed' }
        return { score: 100, findings: [] }
      },
    }, { dir, runtimeNamespace: 'issue-fixer-test' })

    assert.equal(result.status, 'completed')
    assert.equal(result.finalScore, 96)
    assert.deepEqual(result.unresolvedFindings, [])
    assert.deepEqual(result.run.jobs.map((job) => `${job.role}:${job.iteration}`), [
      'builder:1',
      'reviewer:1',
      'fixer:1',
      'reviewer:2',
      'verifier:1',
    ])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
