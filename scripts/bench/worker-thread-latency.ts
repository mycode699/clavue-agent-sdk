/**
 * Bench — worker_thread subagent runtime latency.
 *
 * Three measurements:
 *
 *   spawnLatency:  time from `runWorkerThreadSubagent()` call to receiving
 *                  a synthetic completion (stub worker that posts a message
 *                  immediately). This is the floor cost of choosing the
 *                  worker_thread runtime over inprocess.
 *
 *   abortResolveLatency:
 *                  time from `controller.abort()` to the rejected promise.
 *                  Note: this measures the PARENT-SIDE unblock time; the
 *                  actual worker thread terminate() happens asynchronously
 *                  right after the reject fires. It's the right SLO for
 *                  "how long does my code wait?" but not "how long until
 *                  the V8 isolate is gone".
 *
 *   preflightAbort: time from call to rejection when the parent signal is
 *                   already aborted. This must not pay worker startup
 *                   cost — should be sub-millisecond.
 *
 * No iteration timing for accuracy comparison — timing varies by machine
 * and CI noise; we report p50 / p95 over N iterations so the numbers are
 * useful for setting SLOs without pretending they're exact.
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { runWorkerThreadSubagent } from '../../src/runtime/worker-thread-subagent.ts'

const FIXTURES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'tests',
  'fixtures',
)

const STUB_ENTRY = join(FIXTURES_DIR, 'worker-thread-stub-entry.mjs')
const SLOW_ENTRY = join(FIXTURES_DIR, 'worker-thread-slow-entry.mjs')

const ITERATIONS = 30

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return NaN
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))
  return sorted[idx]!
}

interface Stat {
  name: string
  iterations: number
  p50: number
  p95: number
  min: number
  max: number
}

function summarize(name: string, durations: number[]): Stat {
  return {
    name,
    iterations: durations.length,
    p50: quantile(durations, 0.5),
    p95: quantile(durations, 0.95),
    min: Math.min(...durations),
    max: Math.max(...durations),
  }
}

async function measureSpawn(): Promise<number[]> {
  const ds: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = nowMs()
    await runWorkerThreadSubagent({
      input: { prompt: 'noop' },
      context: { cwd: process.cwd() },
      workerEntryPathOverride: STUB_ENTRY,
      timeoutMs: 5000,
    })
    ds.push(nowMs() - t0)
  }
  return ds
}

async function measureAbort(): Promise<number[]> {
  const ds: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const ctrl = new AbortController()
    // Spawn a worker that will sleep 5s. Abort it after a short delay
    // and measure the time from abort() to the promise rejection.
    let abortAt = 0
    setTimeout(() => {
      abortAt = nowMs()
      ctrl.abort(new Error('bench cancel'))
    }, 30)
    try {
      await runWorkerThreadSubagent({
        input: { prompt: 'noop' },
        context: { cwd: process.cwd() },
        abortSignal: ctrl.signal,
        workerEntryPathOverride: SLOW_ENTRY,
        timeoutMs: 10_000,
      })
    } catch {
      ds.push(nowMs() - abortAt)
    }
  }
  return ds
}

async function measurePreflightAbort(): Promise<number[]> {
  const ds: number[] = []
  for (let i = 0; i < ITERATIONS; i++) {
    const ctrl = new AbortController()
    ctrl.abort(new Error('preflight'))
    const t0 = nowMs()
    try {
      await runWorkerThreadSubagent({
        input: { prompt: 'noop' },
        context: { cwd: process.cwd() },
        abortSignal: ctrl.signal,
        workerEntryPathOverride: STUB_ENTRY,
      })
    } catch {
      // Expected — record latency.
    }
    ds.push(nowMs() - t0)
  }
  return ds
}

function printStats(stats: Stat[]) {
  console.log('\n## worker_thread runtime latency (ms)\n')
  console.log(`Iterations per measurement: ${ITERATIONS}\n`)
  console.log('| Measurement | p50 | p95 | min | max |')
  console.log('|---|---:|---:|---:|---:|')
  for (const s of stats) {
    console.log(
      `| ${s.name} | ${s.p50.toFixed(1)} | ${s.p95.toFixed(1)} | ${s.min.toFixed(1)} | ${s.max.toFixed(1)} |`,
    )
  }
  console.log('')
  console.log(
    'Interpretation guidelines:\n' +
    '  - spawnLatency p50 < 80ms ⇒ acceptable hot path; > 200ms ⇒ check loader hooks.\n' +
    '  - abortResolveLatency p95 < 5ms ⇒ parent unblocks promptly; \n' +
    '    (NB: actual worker terminate happens asynchronously after this).\n' +
    '  - preflightAbort p95 < 5ms ⇒ short-circuit working; > 50ms ⇒ regression.',
  )
}

async function main(): Promise<void> {
  console.log('# worker_thread runtime benchmarks\n')
  console.log('Warming up...')
  await runWorkerThreadSubagent({
    input: { prompt: 'warmup' },
    context: { cwd: process.cwd() },
    workerEntryPathOverride: STUB_ENTRY,
    timeoutMs: 5000,
  })

  console.log('Measuring spawnLatency...')
  const spawn = await measureSpawn()

  console.log('Measuring abortLatency...')
  const abort = await measureAbort()

  console.log('Measuring preflightAbort...')
  const preflight = await measurePreflightAbort()

  printStats([
    summarize('spawnLatency', spawn),
    summarize('abortResolveLatency', abort),
    summarize('preflightAbort', preflight),
  ])
}

main().catch((err) => {
  console.error('bench failed:', err)
  process.exit(1)
})
