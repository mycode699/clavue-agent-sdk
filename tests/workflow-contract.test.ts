import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('workflow contract parses front matter and renders strict issue prompts', async () => {
  const {
    parseWorkflowDefinition,
    renderWorkflowPrompt,
    resolveWorkflowServiceConfig,
  } = await import('../src/index.ts')

  const definition = parseWorkflowDefinition([
    '---',
    'tracker:',
    '  kind: linear',
    '  api_key: $LINEAR_API_KEY',
    '  project_slug: agents',
    '  active_states: [Todo, Rework]',
    'workspace:',
    '  root: ./workspaces',
    'hooks:',
    '  after_create: |',
    '    git clone "$SOURCE_REPO" .',
    'agent:',
    '  max_concurrent_agents: 4',
    '  max_turns: 12',
    '  max_concurrent_agents_by_state:',
    '    Todo: 2',
    '    Rework: 1',
    'codex:',
    '  command: codex app-server',
    '---',
    'Work on {{ issue.identifier }}.',
    '',
    'Title: {{ issue.title }}',
    'Labels: {{ issue.labels }}',
    'Attempt: {{ attempt }}',
  ].join('\n'), {
    path: '/repo/WORKFLOW.md',
  })

  const config = resolveWorkflowServiceConfig(definition, {
    env: { LINEAR_API_KEY: 'linear-token' },
    homeDir: '/home/tester',
    tmpDir: '/tmp/tester',
  })

  assert.equal(definition.config.tracker && typeof definition.config.tracker === 'object' && !Array.isArray(definition.config.tracker)
    ? definition.config.tracker.kind
    : undefined, 'linear')
  assert.equal(config.tracker.api_key, 'linear-token')
  assert.equal(config.tracker.endpoint, 'https://api.linear.app/graphql')
  assert.deepEqual(config.tracker.active_states, ['Todo', 'Rework'])
  assert.equal(config.workspace.root, '/repo/workspaces')
  assert.equal(config.hooks.after_create, 'git clone "$SOURCE_REPO" .')
  assert.equal(config.agent.max_concurrent_agents, 4)
  assert.equal(config.agent.max_turns, 12)
  assert.deepEqual(config.agent.max_concurrent_agents_by_state, { todo: 2, rework: 1 })

  const prompt = renderWorkflowPrompt(definition, {
    attempt: 2,
    issue: {
      identifier: 'SDK-42',
      title: 'Fix autonomous workflow handoff',
      labels: ['p1', 'agentops'],
    },
  })

  assert.match(prompt, /Work on SDK-42/)
  assert.match(prompt, /Title: Fix autonomous workflow handoff/)
  assert.match(prompt, /Labels: p1, agentops/)
  assert.match(prompt, /Attempt: 2/)
})

test('workflow contract rejects unknown template variables and filters', async () => {
  const {
    WorkflowContractError,
    parseWorkflowDefinition,
    renderWorkflowPrompt,
  } = await import('../src/index.ts')

  const missingValue = parseWorkflowDefinition('Use {{ issue.missing }}')
  assert.throws(() => renderWorkflowPrompt(missingValue, { issue: { identifier: 'SDK-1' } }), (error: unknown) => {
    assert.ok(error instanceof WorkflowContractError)
    assert.equal(error.code, 'template_render_error')
    assert.match(error.message, /issue\.missing/)
    return true
  })

  const unknownFilter = parseWorkflowDefinition('Use {{ issue.identifier | uppercase }}')
  assert.throws(() => renderWorkflowPrompt(unknownFilter, { issue: { identifier: 'SDK-1' } }), (error: unknown) => {
    assert.ok(error instanceof WorkflowContractError)
    assert.equal(error.code, 'template_render_error')
    assert.match(error.message, /uppercase/)
    return true
  })
})

test('workflow contract resolves defaults, validates dispatch config, and normalizes workspaces', async () => {
  const {
    getWorkflowWorkspacePath,
    normalizeWorkflowState,
    normalizeWorkspaceKey,
    parseWorkflowDefinition,
    resolveWorkflowServiceConfig,
    validateWorkflowDispatchConfig,
  } = await import('../src/index.ts')

  const definition = parseWorkflowDefinition('Handle {{ issue.identifier }}', {
    path: '/repo/WORKFLOW.md',
  })
  const config = resolveWorkflowServiceConfig(definition, {
    env: {},
    homeDir: '/home/tester',
    tmpDir: '/tmp/tester',
  })

  assert.equal(config.polling.interval_ms, 30_000)
  assert.equal(config.workspace.root, '/tmp/tester/clavue_agent_workspaces')
  assert.equal(config.agent.max_concurrent_agents, 10)
  assert.equal(config.codex.command, 'codex app-server')
  assert.deepEqual(validateWorkflowDispatchConfig(config), [])
  assert.deepEqual(validateWorkflowDispatchConfig(config, { requireTracker: true }).map((issue) => issue.path), ['tracker.kind'])

  assert.equal(normalizeWorkflowState(' In Progress '), 'in progress')
  assert.equal(normalizeWorkspaceKey('SDK-42: Fix/Agent Ops'), 'SDK-42_Fix_Agent_Ops')
  assert.equal(getWorkflowWorkspacePath(config, 'SDK-42: Fix/Agent Ops'), '/tmp/tester/clavue_agent_workspaces/SDK-42_Fix_Agent_Ops')
})

test('workflow contract loads WORKFLOW.md and reports missing files with typed errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-workflow-contract-'))
  const {
    WorkflowContractError,
    loadWorkflowDefinition,
  } = await import('../src/index.ts')

  try {
    const workflowPath = join(dir, 'WORKFLOW.md')
    await writeFile(workflowPath, [
      '---',
      'agent:',
      '  max_turns: 8',
      '---',
      'Fix {{ issue.identifier }}',
    ].join('\n'))

    const loaded = await loadWorkflowDefinition({ cwd: dir })
    assert.equal(loaded.path, workflowPath)
    assert.equal(loaded.prompt_template, 'Fix {{ issue.identifier }}')

    await assert.rejects(() => loadWorkflowDefinition({ workflowPath: join(dir, 'missing.md') }), (error: unknown) => {
      assert.ok(error instanceof WorkflowContractError)
      assert.equal(error.code, 'missing_workflow_file')
      return true
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
