import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

async function createBenchmarkDirs(): Promise<{ root: string; memory: string; jobs: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clavue-agent-sdk-benchmark-test-'))
  return {
    root,
    memory: join(root, 'memory'),
    jobs: join(root, 'agent-jobs'),
  }
}

test('runBenchmarks returns deterministic offline benchmark metrics', async () => {
  const dirs = await createBenchmarkDirs()
  const { runBenchmarks } = await import('../src/index.ts')

  try {
    const report = await runBenchmarks({
      cwd: '/tmp/benchmark-cwd',
      iterations: 2,
      memory: { dir: dirs.memory },
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'benchmark-test' },
    })

    assert.match(report.id, /^benchmark_\d+_/)
    assert.equal(report.cwd, '/tmp/benchmark-cwd')
    assert.equal(report.metrics.length, 6)
    assert.ok(Date.parse(report.started_at) <= Date.parse(report.completed_at))
    assert.ok(report.duration_ms >= 0)

    const names = report.metrics.map((metric) => metric.name).sort()
    assert.deepEqual(names, [
      'agentJobStorage',
      'contextBuild',
      'memoryQuery',
      'readOnlyFanOut',
      'runtimeProfileResolve',
      'serialMutationOrdering',
    ])

    for (const metric of report.metrics) {
      assert.equal(metric.iterations, 2)
      assert.ok(metric.total_ms >= 0)
      assert.ok(metric.mean_ms >= 0)
      assert.ok(metric.min_ms >= 0)
      assert.ok(metric.max_ms >= 0)
      assert.ok(metric.max_ms >= metric.min_ms)
    }

    assert.equal(report.metrics.find((metric) => metric.name === 'readOnlyFanOut')?.metadata?.files, 4)
    assert.equal(report.metrics.find((metric) => metric.name === 'serialMutationOrdering')?.metadata?.writes, 3)
    assert.equal(report.metrics.find((metric) => metric.name === 'contextBuild')?.metadata?.messages, 16)
    const runtimeProfile = report.metrics.find((metric) => metric.name === 'runtimeProfileResolve')?.metadata
    assert.equal(runtimeProfile?.profiles, 8)
    assert.deepEqual(runtimeProfile?.modes, ['collect', 'organize', 'plan', 'solve', 'build', 'verify', 'review', 'ship'])
    assert.equal(runtimeProfile?.plan_permission_mode, 'plan')
    assert.deepEqual(runtimeProfile?.plan_toolsets, ['repo-readonly', 'planning', 'skills'])
    assert.equal(runtimeProfile?.verify_memory_policy, 'off')
    assert.equal(report.metrics.find((metric) => metric.name === 'memoryQuery')?.metadata?.results, 5)
    assert.equal(report.metrics.find((metric) => metric.name === 'agentJobStorage')?.metadata?.jobs, 2)
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})

test('runBenchmarks records context pipeline startup metadata', async () => {
  const dirs = await createBenchmarkDirs()
  const { runBenchmarks } = await import('../src/index.ts')
  await writeFile(join(dirs.root, 'clavue.md'), 'Benchmark context guidance.\n')

  try {
    const report = await runBenchmarks({
      cwd: dirs.root,
      iterations: 1,
      memory: { dir: dirs.memory },
      agentJobs: { dir: dirs.jobs, runtimeNamespace: 'benchmark-startup-test' },
    })

    const contextBuild = report.metrics.find((metric) => metric.name === 'contextBuild')
    assert.equal(contextBuild?.metadata?.sections, 2)
    assert.equal(contextBuild?.metadata?.rendered_context_included, true)
    assert.equal(contextBuild?.metadata?.project_sources, 1)
    assert.ok(Number(contextBuild?.metadata?.rendered_context_bytes) > 0)
  } finally {
    await rm(dirs.root, { recursive: true, force: true })
  }
})

test('runBenchmarks rejects invalid iteration counts', async () => {
  const { runBenchmarks } = await import('../src/index.ts')
  await assert.rejects(
    () => runBenchmarks({ iterations: 0 }),
    /Benchmark iterations must be a positive integer/,
  )
})
