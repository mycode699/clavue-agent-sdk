import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

async function withCleanHome<T>(callback: (home: string) => Promise<T>): Promise<T> {
  const originalHome = process.env.HOME
  const originalUserProfile = process.env.USERPROFILE
  const home = await mkdtemp(join(tmpdir(), 'clavue-agent-sdk-home-'))

  process.env.HOME = home
  delete process.env.USERPROFILE

  try {
    return await callback(home)
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    if (originalUserProfile === undefined) {
      delete process.env.USERPROFILE
    } else {
      process.env.USERPROFILE = originalUserProfile
    }
    await rm(home, { recursive: true, force: true })
  }
}

test('npm package payload includes compiled entrypoints and excludes temp artifacts', async () => {
  const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageRoot,
  })

  const packageJson = JSON.parse(
    await import('node:fs/promises').then(({ readFile }) =>
      readFile(resolve(packageRoot, 'package.json'), 'utf-8'),
    ),
  ) as { name?: string; repository?: { url?: string }; scripts?: Record<string, string>; bin?: Record<string, string> }
  const [pack] = JSON.parse(stdout) as [{ files: Array<{ path: string }> }]
  const paths = new Set(pack.files.map((file) => file.path))

  assert.ok(
    packageJson.scripts?.prepack || packageJson.scripts?.prepare || packageJson.scripts?.prepublishOnly,
    'expected a publish-time build script so dist is generated before packing',
  )
  assert.equal(
    packageJson.scripts?.test,
    'npx tsx --test tests/*.test.ts',
    'expected npm test to run the checked-in test suite',
  )
  assert.equal(packageJson.name, 'clavue-agent-sdk')
  assert.equal(
    packageJson.repository?.url,
    'git+https://github.com/mycode699/clavue-agent-sdk.git',
  )
  assert.ok(paths.has('dist/index.js'), 'expected dist/index.js to be published')
  assert.ok(paths.has('dist/index.d.ts'), 'expected dist/index.d.ts to be published')
  assert.equal(packageJson.bin?.['clavue-agent-sdk'], './dist/cli.js')
  assert.equal(packageJson.bin?.['clavue-agent'], './dist/cli.js')
  assert.ok(paths.has('dist/cli.js'), 'expected CLI entrypoint to be published')
  assert.ok(
    [...paths].every((path) => !path.startsWith('.tmp-retro-ledger/')),
    'expected temp retro ledger artifacts to be excluded',
  )
})

test('agent reads CLAVUE_AGENT env settings', async () => {
  const {
    createAgent,
  } = await import('../src/index.ts')

  const agent = createAgent({
    env: {
      CLAVUE_AGENT_API_TYPE: 'openai-completions',
      CLAVUE_AGENT_MODEL: 'gpt-5.4',
      CLAVUE_AGENT_API_KEY: 'test-key',
      CLAVUE_AGENT_BASE_URL: 'https://example.test/v1',
    },
  })

  try {
    assert.equal(agent.getApiType(), 'openai-completions')
    assert.equal((agent as any).modelId, 'gpt-5.4')
    assert.equal((agent as any).apiCredentials.key, 'test-key')
    assert.equal((agent as any).apiCredentials.baseUrl, 'https://example.test/v1')
  } finally {
    await agent.close()
  }
})

test('run returns a structured run artifact', async () => {
  const { Agent, run } = await import('../src/index.ts')
  assert.equal(typeof run, 'function')

  class StubProvider {
    readonly apiType = 'openai-completions' as const

    async createMessage() {
      return {
        content: [{ type: 'text', text: 'stub response' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 7 },
      }
    }
  }

  const agent = new Agent({ model: 'gpt-5.4', tools: [] })
  ;(agent as any).provider = new StubProvider()

  try {
    const result = await agent.run('Say hello')
    assert.equal(result.status, 'completed')
    assert.equal(result.subtype, 'success')
    assert.equal(result.text, 'stub response')
    assert.equal(result.session_id, agent.getSessionId())
    assert.equal(result.usage.input_tokens, 12)
    assert.equal(result.usage.output_tokens, 7)
    assert.ok(result.id)
    assert.ok(result.started_at)
    assert.ok(result.completed_at)
    assert.ok(result.duration_ms >= 0)
    assert.ok(result.events.length >= 2)
  } finally {
    await agent.close()
  }

  const singleRun = await run({
    prompt: 'Say hello once',
    options: {
      model: 'gpt-5.4',
      tools: [],
    },
  })
  assert.ok(singleRun.id)
})

test('default storage directories use clavue-agent-sdk branding', async () => {
  await withCleanHome(async (home) => {
    const { loadRetroCycle, loadRetroRun, saveMemory, saveRetroCycle, saveRetroRun, saveSession } = await import('../src/index.ts')

    await saveSession('session-1', [], {
      cwd: packageRoot,
      model: 'gpt-5.4',
    })

    await saveRetroRun('run-1', {
      summary: '',
      findings: [],
      scores: {
        overall: { dimension: 'overall', score: 100 },
        byDimension: {
          compatibility: { dimension: 'compatibility', score: 100 },
          stability: { dimension: 'stability', score: 100 },
          interaction_logic: { dimension: 'interaction_logic', score: 100 },
          reliability: { dimension: 'reliability', score: 100 },
        },
      },
      recommendations: [],
      proposed_workstreams: [],
      verification: {
        passed: true,
        summary: 'All 1 quality gate(s) passed.',
        startedAt: '2026-04-15T00:00:00.000Z',
        completedAt: '2026-04-15T00:00:01.000Z',
        durationMs: 1000,
        gates: [
          {
            name: 'build',
            command: 'npm',
            args: ['run', 'build'],
            cwd: packageRoot,
            passed: true,
            exitCode: 0,
            durationMs: 1000,
            stdout: '',
            stderr: '',
          },
        ],
      },
      run_metadata: { runAt: '2026-04-15T00:00:00.000Z' },
    })
    await loadRetroRun('run-1')
    await saveRetroCycle('cycle-1', {
      run: {
        summary: '',
        findings: [],
        scores: {
          overall: { dimension: 'overall', score: 100 },
          byDimension: {
            compatibility: { dimension: 'compatibility', score: 100 },
            stability: { dimension: 'stability', score: 100 },
            interaction_logic: { dimension: 'interaction_logic', score: 100 },
            reliability: { dimension: 'reliability', score: 100 },
          },
        },
        recommendations: [],
        proposed_workstreams: [],
        verification: {
          passed: true,
          summary: 'All 1 quality gate(s) passed.',
          startedAt: '2026-04-15T00:00:00.000Z',
          completedAt: '2026-04-15T00:00:01.000Z',
          durationMs: 1000,
          gates: [
            {
              name: 'build',
              command: 'npm',
              args: ['run', 'build'],
              cwd: packageRoot,
              passed: true,
              exitCode: 0,
              durationMs: 1000,
              stdout: '',
              stderr: '',
            },
          ],
        },
        run_metadata: { runAt: '2026-04-15T00:00:00.000Z' },
      },
      verification: {
        passed: true,
        summary: 'All 1 quality gate(s) passed.',
        startedAt: '2026-04-15T00:00:00.000Z',
        completedAt: '2026-04-15T00:00:01.000Z',
        durationMs: 1000,
        gates: [
          {
            name: 'build',
            command: 'npm',
            args: ['run', 'build'],
            cwd: packageRoot,
            passed: true,
            exitCode: 0,
            durationMs: 1000,
            stdout: '',
            stderr: '',
          },
        ],
      },
      action: {
        kind: 'stop',
        reason: 'No findings recorded.',
        priority: 6,
        findingIds: [],
        constraints: {},
      },
      decision: {
        disposition: 'accepted',
        accepted: true,
        shouldRetry: false,
        reason: 'No findings recorded.',
      },
      summary: {
        text: 'ACCEPTED · stop · 0 finding(s). Verification: passed. No findings recorded.',
        statusLine: 'ACCEPTED · stop · 0 finding(s)',
        findingCount: 0,
        verificationPassed: true,
        actionKind: 'stop',
        disposition: 'accepted',
      },
      trace: {
        attemptCount: 0,
        attemptNumber: 1,
        maxAttempts: 3,
        startedAt: '2026-04-15T00:00:00.000Z',
        completedAt: '2026-04-15T00:00:01.000Z',
        durationMs: 1000,
      },
    })
    await loadRetroCycle('cycle-1')
    await saveMemory({
      id: 'memory-1',
      type: 'feedback',
      scope: 'repo',
      title: 'Minimize confirmations',
      content: 'Keep moving unless there is a destructive or branching decision.',
      repoPath: packageRoot,
    })

    const { access } = await import('node:fs/promises')
    await access(join(home, '.clavue-agent-sdk', 'sessions', 'session-1', 'transcript.json'))
    await access(join(home, '.clavue-agent-sdk', 'retro-runs', 'run-1.json'))
    await access(join(home, '.clavue-agent-sdk', 'retro-runs', 'cycle-1.cycle.json'))
    await access(join(home, '.clavue-agent-sdk', 'memory', 'memory-1.json'))
  })

  const { stdout } = await execFileAsync('node', [
    '--input-type=module',
    '-e',
    `
      process.env.HOME = ${JSON.stringify(await mkdtemp(join(tmpdir(), 'clavue-agent-sdk-check-')))};
      const sessionModule = await import(${JSON.stringify(resolve(packageRoot, 'dist/session.js'))});
      const ledgerModule = await import(${JSON.stringify(resolve(packageRoot, 'dist/retro/ledger.js'))});
      await sessionModule.saveSession('session-1', [], { cwd: ${JSON.stringify(packageRoot)}, model: 'gpt-5.4' });
      await ledgerModule.saveRetroRun('run-1', { summary: '', findings: [], scores: { overall: { dimension: 'overall', score: 100 }, byDimension: { compatibility: { dimension: 'compatibility', score: 100 }, stability: { dimension: 'stability', score: 100 }, interaction_logic: { dimension: 'interaction_logic', score: 100 }, reliability: { dimension: 'reliability', score: 100 } } }, recommendations: [], proposed_workstreams: [], verification: { passed: true, summary: 'All 1 quality gate(s) passed.', startedAt: '2026-04-15T00:00:00.000Z', completedAt: '2026-04-15T00:00:01.000Z', durationMs: 1000, gates: [{ name: 'build', command: 'npm', args: ['run', 'build'], cwd: ${JSON.stringify(packageRoot)}, passed: true, exitCode: 0, durationMs: 1000, stdout: '', stderr: '' }] }, run_metadata: { runAt: '2026-04-15T00:00:00.000Z' } }, undefined);
      console.log('ok');
    `,
  ], { cwd: packageRoot })

  assert.equal(stdout.trim(), 'ok')
})
