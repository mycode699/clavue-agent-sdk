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
    assert.ok(report.checks.some((check) => check.name === 'contracts.schema_versions' && check.status === 'ok'))
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
  const { createAgentJob, doctor, stopAgentJob, summarizeAgentJobs } = await import('../src/index.ts')

  try {
    const stale = await createAgentJob({
      kind: 'subagent',
      prompt: 'stale work',
      description: 'stale worker',
      replay: { prompt: 'stale work' },
    }, { dir: dirs.jobs, runtimeNamespace: 'doctor-stale' })
    await createAgentJob({
      kind: 'subagent',
      prompt: 'failed work',
      description: 'failed worker',
      replay: { prompt: 'failed work' },
    }, { dir: dirs.jobs, runtimeNamespace: 'doctor-stale' })
    const cancelled = await createAgentJob({
      kind: 'subagent',
      prompt: 'cancelled work',
      description: 'cancelled worker',
    }, { dir: dirs.jobs, runtimeNamespace: 'doctor-stale' })
    await stopAgentJob(cancelled.id, 'not needed', { dir: dirs.jobs, runtimeNamespace: 'doctor-stale', staleAfterMs: -1 })

    const summary = await summarizeAgentJobs({ dir: dirs.jobs, runtimeNamespace: 'doctor-stale', staleAfterMs: 0 })
    assert.equal(summary.total, 3)
    assert.equal(summary.by_status.stale, 2)
    assert.equal(summary.stale_count, 2)
    assert.equal(summary.replayable_count, 2)
    assert.equal(summary.cancelled_count, 1)
    assert.equal(summary.error_summaries.length, 3)

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
    assert.equal(jobCheck?.details?.summary?.stale_count, 2)
    assert.equal(jobCheck?.details?.summary?.replayable_count, 2)
    assert.equal((jobCheck?.details?.summary?.stale_jobs as any[])?.[0]?.id, stale.id)
    assert.equal((jobCheck?.details?.summary?.stale_jobs as any[])?.[0]?.status, 'stale')
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

test('doctor contracts.schema_versions reports every public schema-version constant', async () => {
  const dirs = await createDoctorDirs()
  const {
    doctor,
    SDK_EVENT_SCHEMA_VERSION,
    AGENT_RUN_RESULT_SCHEMA_VERSION,
    AGENT_RUN_TRACE_SCHEMA_VERSION,
    AGENT_JOB_RECORD_SCHEMA_VERSION,
    MEMORY_TRACE_SCHEMA_VERSION,
    PROOF_OF_WORK_SCHEMA_VERSION,
    CONTROLLED_EXECUTION_CONTRACT_VERSION,
  } = await import('../src/index.ts')

  try {
    const report = await doctor({
      env: {
        CLAVUE_AGENT_API_TYPE: 'openai-completions',
        CLAVUE_AGENT_MODEL: 'gpt-5.4',
        CLAVUE_AGENT_API_KEY: 'test-key',
      },
      memory: { dir: dirs.memory },
      session: { dir: dirs.sessions },
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-contracts' },
      checkPackageEntrypoints: false,
    })

    const entry = report.checks.find((check) => check.name === 'contracts.schema_versions')
    assert.equal(entry?.status, 'ok')
    assert.equal(entry?.category, 'contracts')
    const contracts = entry?.details?.contracts as Record<string, string>
    assert.deepEqual(contracts, {
      SDK_EVENT_SCHEMA_VERSION,
      AGENT_RUN_RESULT_SCHEMA_VERSION,
      AGENT_RUN_TRACE_SCHEMA_VERSION,
      AGENT_JOB_RECORD_SCHEMA_VERSION,
      MEMORY_TRACE_SCHEMA_VERSION,
      PROOF_OF_WORK_SCHEMA_VERSION,
      CONTROLLED_EXECUTION_CONTRACT_VERSION,
    })
    // Every shipped value must parse as MAJOR.MINOR.PATCH at minimum.
    for (const [name, value] of Object.entries(contracts)) {
      assert.match(value, /^\d+\.\d+\.\d+/, `${name} = ${value} is not semver`)
    }
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

test('doctor package.entrypoints inspects every subpath export declared in package.json', async () => {
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
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-subpaths' },
      packageRoot: process.cwd(),
    })

    const entry = report.checks.find((check) => check.name === 'package.entrypoints')
    assert.equal(entry?.status, 'ok')
    const checked = (entry?.details?.checked as string[]) ?? []
    // Root + the v3 axes that the README advertises must all be checked.
    for (const expected of [
      'dist/index.js',
      'dist/cli.js',
      'dist/subpath/core.js',
      'dist/subpath/tools.js',
      'dist/subpath/contracts.js',
      'dist/graph/index.js',
      'dist/guardrails/index.js',
      'dist/tracing/index.js',
      'dist/sandbox/index.js',
      'dist/rag/index.js',
      'dist/genui/index.js',
      'dist/voice/index.js',
    ]) {
      assert.ok(checked.includes(expected), `expected ${expected} in checked entrypoints, got ${checked.join(', ')}`)
    }
    assert.deepEqual(entry?.details?.missing, [])
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})

test('doctor package.entrypoints reports missing subpath builds as warn', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clavue-agent-sdk-doctor-fakeroot-'))
  const dirs = await createDoctorDirs()
  const { doctor } = await import('../src/index.ts')

  try {
    // Synthesize a fake package root with the same exports map but no dist/.
    const realPkg = JSON.parse(await (await import('node:fs/promises')).readFile(join(process.cwd(), 'package.json'), 'utf-8'))
    await (await import('node:fs/promises')).writeFile(
      join(root, 'package.json'),
      JSON.stringify({ name: realPkg.name, exports: realPkg.exports }),
      'utf-8',
    )

    const report = await doctor({
      env: {
        CLAVUE_AGENT_API_TYPE: 'openai-completions',
        CLAVUE_AGENT_MODEL: 'gpt-5.4',
        CLAVUE_AGENT_API_KEY: 'test-key',
      },
      memory: { dir: dirs.memory },
      session: { dir: dirs.sessions },
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-missing-subpaths' },
      packageRoot: root,
    })

    const entry = report.checks.find((check) => check.name === 'package.entrypoints')
    assert.equal(entry?.status, 'warn')
    const missing = (entry?.details?.missing as string[]) ?? []
    assert.ok(missing.includes('dist/index.js'))
    assert.ok(missing.includes('dist/graph/index.js'))
    assert.ok(missing.includes('dist/voice/index.js'))
  } finally {
    await rm(root, { recursive: true, force: true })
    await rm(dirs.root, { recursive: true, force: true })
  }
})
