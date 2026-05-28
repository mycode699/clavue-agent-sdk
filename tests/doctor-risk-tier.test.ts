import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function createDirs(): Promise<{ root: string; memory: string; sessions: string; jobs: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clavue-doctor-tier-'))
  return {
    root,
    memory: join(root, 'memory'),
    sessions: join(root, 'sessions'),
    jobs: join(root, 'jobs'),
  }
}

test('doctor tools.registry exposes synthesis-risk-tier counts', async () => {
  const dirs = await createDirs()
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
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-tier-test' },
      packageRoot: process.cwd(),
    })

    const toolsCheck = report.checks.find((c) => c.name === 'tools.registry')
    assert.ok(toolsCheck, 'tools.registry check should exist')
    const tiers = (toolsCheck!.details as any)?.riskTierCounts
    assert.ok(tiers, 'tools.registry details should include riskTierCounts')
    assert.equal(typeof tiers.system_initiated, 'number')
    assert.equal(typeof tiers.llm_requested, 'number')
    assert.equal(typeof tiers.approval_required, 'number')

    // Sanity: sum of tiers equals total tool count.
    const total = tiers.system_initiated + tiers.llm_requested + tiers.approval_required
    assert.equal(total, (toolsCheck!.details as any).toolCount)

    // The bundled tool set MUST include at least one of each tier
    // (Read/Glob are read-only, Edit is local-write, Bash is shell).
    assert.ok(tiers.system_initiated > 0, 'expected at least one read-only tool')
    assert.ok(tiers.llm_requested > 0, 'expected at least one local-write tool')
    assert.ok(tiers.approval_required > 0, 'expected at least one shell/destructive tool')
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})

test('doctor tools.registry tiers report stays consistent under a narrowed toolset', async () => {
  const dirs = await createDirs()
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
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-tier-test-2' },
      packageRoot: process.cwd(),
      toolsets: ['repo-readonly'],
    })

    const toolsCheck = report.checks.find((c) => c.name === 'tools.registry')
    const tiers = (toolsCheck!.details as any)?.riskTierCounts
    // repo-readonly should have zero approval_required (no shell/destructive).
    assert.equal(tiers.approval_required, 0, 'repo-readonly should expose no approval-required tools')
    assert.ok(tiers.system_initiated > 0, 'repo-readonly should expose read-only tools')
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})
