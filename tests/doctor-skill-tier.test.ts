import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function createDirs(): Promise<{ root: string; memory: string; sessions: string; jobs: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clavue-doctor-skill-tier-'))
  return {
    root,
    memory: join(root, 'memory'),
    sessions: join(root, 'sessions'),
    jobs: join(root, 'jobs'),
  }
}

test('doctor skills.registry exposes synthesis-risk-tier counts', async () => {
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
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'doctor-skill-tier-test' },
      packageRoot: process.cwd(),
    })

    const skillsCheck = report.checks.find((c) => c.name === 'skills.registry')
    assert.ok(skillsCheck, 'skills.registry check should exist')
    const tiers = (skillsCheck!.details as any)?.riskTierCounts
    assert.ok(tiers, 'skills.registry details should include riskTierCounts')
    assert.equal(typeof tiers.system_initiated, 'number')
    assert.equal(typeof tiers.llm_requested, 'number')
    assert.equal(typeof tiers.approval_required, 'number')

    // Sum of tiers equals skillCount. (This is the invariant under test:
    // riskTierCounts must partition exactly the skills doctor counted.
    // We avoid asserting specific tier sizes because doctor reads the shared
    // default skill namespace, which other concurrent tests mutate via
    // clearSkills(); the tier-classification logic itself is verified
    // deterministically in tests/skill-risk-tier.test.ts.)
    const total = tiers.system_initiated + tiers.llm_requested + tiers.approval_required
    assert.equal(total, (skillsCheck!.details as any).skillCount)
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})
