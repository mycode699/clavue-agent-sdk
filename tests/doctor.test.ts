import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function createDoctorDirs(): Promise<{ root: string; memory: string; sessions: string; jobs: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clavue-agent-sdk-doctor-'))
  return {
    root,
    memory: join(root, 'memory'),
    sessions: join(root, 'sessions'),
    jobs: join(root, 'jobs'),
  }
}

test('doctor reports ready checks for provider, tools, skills, storage, mcp, and package entrypoints', async () => {
  const dirs = await createDoctorDirs()
  const { doctor } = await import('../src/index.ts')

  try {
    const report = await doctor({
      env: {
        CLAVUE_AGENT_API_TYPE: 'openai-completions',
        CLAVUE_AGENT_MODEL: 'gpt-5.4',
        CLAVUE_AGENT_API_KEY: 'test-key',
      },
      memory: { dir: dirs.memory },
      session: { dir: dirs.sessions },
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-test' },
      mcpServers: {
        local: { type: 'stdio', command: 'node', args: ['server.js'] },
      },
      packageRoot: process.cwd(),
    })

    assert.equal(report.status, 'ok')
    assert.equal(report.summary.error, 0)
    assert.equal(report.summary.warn, 0)
    const providerCheck = report.checks.find((check) => check.name === 'provider.credentials')
    assert.equal(providerCheck?.status, 'ok')
    assert.equal((providerCheck?.details?.capabilities as any)?.normalizedModel, 'gpt-5.4')
    assert.equal((providerCheck?.details?.capabilities as any)?.transport, 'responses')
    assert.deepEqual((providerCheck?.details?.capabilities as any)?.fallback, {
      responsesToChatCompletionsStatuses: [400, 404, 405, 501],
    })
    assert.ok(report.checks.some((check) => check.name === 'tools.registry' && check.status === 'ok'))
    assert.ok(report.checks.some((check) => check.name === 'skills.registry' && check.status === 'ok'))
    assert.ok(report.checks.some((check) => check.name === 'storage.memory' && check.status === 'ok'))
    assert.ok(report.checks.some((check) => check.name === 'storage.sessions' && check.status === 'ok'))
    assert.ok(report.checks.some((check) => check.name === 'storage.agentJobs' && check.status === 'ok'))
    assert.ok(report.checks.some((check) => check.name === 'mcp.local' && check.status === 'ok'))
    assert.ok(report.checks.some((check) => check.name === 'package.entrypoints' && check.status === 'ok'))
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})

test('doctor provider check uses model capability metadata for gpt-4.1', async () => {
  const dirs = await createDoctorDirs()
  const { doctor, getModelCapabilities } = await import('../src/index.ts')

  try {
    const report = await doctor({
      env: {
        CLAVUE_AGENT_API_TYPE: 'openai-completions',
        CLAVUE_AGENT_MODEL: 'openai/gpt-4.1',
        CLAVUE_AGENT_API_KEY: 'test-key',
      },
      memory: { dir: dirs.memory },
      session: { dir: dirs.sessions },
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-gpt41' },
      checkPackageEntrypoints: false,
    })

    const providerCheck = report.checks.find((check) => check.name === 'provider.credentials')
    assert.equal(providerCheck?.status, 'ok')
    assert.deepEqual(
      providerCheck?.details?.capabilities,
      getModelCapabilities('openai/gpt-4.1', { apiType: 'openai-completions' }),
    )
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})

test('doctor reports stale agent jobs as actionable storage warnings', async () => {
  const dirs = await createDoctorDirs()
  const { createAgentJob, doctor } = await import('../src/index.ts')

  try {
    const stale = await createAgentJob({
      kind: 'subagent',
      prompt: 'stale work',
      description: 'stale worker',
    }, { dir: dirs.jobs, runtimeNamespace: 'doctor-stale' })

    const report = await doctor({
      env: {
        CLAVUE_AGENT_API_TYPE: 'openai-completions',
        CLAVUE_AGENT_MODEL: 'gpt-5.4',
        CLAVUE_AGENT_API_KEY: 'test-key',
      },
      memory: { dir: dirs.memory },
      session: { dir: dirs.sessions },
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-stale', staleAfterMs: 0 },
      checkPackageEntrypoints: false,
    })

    assert.equal(report.status, 'warn')
    const jobCheck = report.checks.find((check) => check.name === 'storage.agentJobs')
    assert.equal(jobCheck?.status, 'warn')
    assert.equal(jobCheck?.details?.stale_count, 1)
    assert.equal((jobCheck?.details?.stale_jobs as any[])?.[0]?.id, stale.id)
    assert.equal((jobCheck?.details?.stale_jobs as any[])?.[0]?.status, 'stale')
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})

test('doctor applies workflow profiles before checking tools and provider policy', async () => {
  const dirs = await createDoctorDirs()
  const { doctor } = await import('../src/index.ts')

  try {
    const report = await doctor({
      workflowMode: 'verify',
      env: {
        CLAVUE_AGENT_API_TYPE: 'openai-completions',
        CLAVUE_AGENT_MODEL: 'gpt-5.4',
        CLAVUE_AGENT_API_KEY: 'test-key',
      },
      memory: { dir: dirs.memory },
      session: { dir: dirs.sessions },
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-workflow' },
      checkPackageEntrypoints: false,
    })

    const toolsCheck = report.checks.find((check) => check.name === 'tools.registry')
    const memoryCheck = report.checks.find((check) => check.name === 'storage.memory')

    assert.equal(report.status, 'ok')
    assert.equal(toolsCheck?.status, 'ok')
    assert.deepEqual(toolsCheck?.details?.tools, ['Bash', 'Read', 'Glob', 'Grep'])
    assert.equal(memoryCheck?.status, 'skipped')
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})

test('doctor surfaces actionable warnings and errors without network calls', async () => {
  const dirs = await createDoctorDirs()
  const { doctor } = await import('../src/index.ts')

  try {
    const report = await doctor({
      env: {
        CLAVUE_AGENT_API_TYPE: 'bad-api-type',
        CLAVUE_AGENT_MODEL: 'claude-sonnet-4-6',
      },
      tools: ['Read', 'MissingTool'],
      memory: { enabled: false, dir: dirs.memory },
      session: { dir: dirs.sessions },
      agentJobs: { dir: dirs.jobs },
      mcpServers: {
        broken: { type: 'http' },
      },
      checkPackageEntrypoints: false,
    })

    assert.equal(report.status, 'error')
    assert.ok(report.summary.error >= 2)
    assert.ok(report.checks.some((check) => check.name === 'provider.config' && check.status === 'error'))
    assert.ok(report.checks.some((check) => check.name === 'tools.registry' && check.status === 'warn'))
    assert.ok(report.checks.some((check) => check.name === 'mcp.broken' && check.status === 'error'))
    assert.ok(report.checks.some((check) => check.name === 'storage.memory' && check.status === 'skipped'))
    assert.ok(report.checks.some((check) => check.name === 'package.entrypoints' && check.status === 'skipped'))
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})
