/**
 * Worker thread subagent — phase 2 unit tests.
 *
 * These tests target the parent-side wiring of `runWorkerThreadSubagent`
 * directly so we can cover spawn / message / abort / timeout / error
 * paths without booting a real Agent inside the worker. A stub worker
 * entry under tests/fixtures emits the message we want for each scenario.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import { runWorkerThreadSubagent } from '../src/runtime/worker-thread-subagent.ts'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')

test('worker_thread: completes successfully when stub posts a completion', async () => {
  const completion = await runWorkerThreadSubagent({
    input: { prompt: 'hello', description: 'noop' },
    context: { cwd: process.cwd() },
    workerEntryPathOverride: join(FIXTURES_DIR, 'worker-thread-stub-entry.mjs'),
    timeoutMs: 5000,
  })
  assert.equal(completion.output, 'stub-completion')
})

test('worker_thread: rejects pre-aborted explicit signal without spawning the worker', async () => {
  const ctrl = new AbortController()
  ctrl.abort(new Error('cancel before spawn'))
  await assert.rejects(
    () => runWorkerThreadSubagent({
      input: { prompt: 'hello' },
      context: { cwd: process.cwd() },
      abortSignal: ctrl.signal,
      workerEntryPathOverride: join(FIXTURES_DIR, 'worker-thread-stub-entry.mjs'),
    }),
    /aborted before worker_thread subagent started/i,
  )
})

test('worker_thread: rejects pre-aborted context.abortSignal without spawning the worker', async () => {
  const ctrl = new AbortController()
  ctrl.abort(new Error('cancel before spawn'))
  await assert.rejects(
    () => runWorkerThreadSubagent({
      input: { prompt: 'hello' },
      context: { cwd: process.cwd(), abortSignal: ctrl.signal },
      workerEntryPathOverride: join(FIXTURES_DIR, 'worker-thread-stub-entry.mjs'),
    }),
    /aborted before worker_thread subagent started/i,
  )
})

test('worker_thread: rejects with explicit message when stub posts an error', async () => {
  await assert.rejects(
    () => runWorkerThreadSubagent({
      input: { prompt: 'hello' },
      context: { cwd: process.cwd() },
      workerEntryPathOverride: join(FIXTURES_DIR, 'worker-thread-error-entry.mjs'),
      timeoutMs: 5000,
    }),
    /stub failure: simulated/i,
  )
})

test('worker_thread: terminates and rejects when parent aborts mid-flight', async () => {
  const ctrl = new AbortController()
  // Worker will sleep 5s before completing; we abort after 50ms.
  setTimeout(() => ctrl.abort(new Error('mid-flight cancel')), 50)
  const start = Date.now()
  await assert.rejects(
    () => runWorkerThreadSubagent({
      input: { prompt: 'hello' },
      context: { cwd: process.cwd() },
      abortSignal: ctrl.signal,
      workerEntryPathOverride: join(FIXTURES_DIR, 'worker-thread-slow-entry.mjs'),
      timeoutMs: 10_000,
    }),
    /worker subagent aborted/i,
  )
  const elapsed = Date.now() - start
  assert.ok(elapsed < 1500, `expected quick abort, took ${elapsed}ms`)
})

test('worker_thread: enforces hard timeout when stub never replies', async () => {
  const start = Date.now()
  await assert.rejects(
    () => runWorkerThreadSubagent({
      input: { prompt: 'hello' },
      context: { cwd: process.cwd() },
      workerEntryPathOverride: join(FIXTURES_DIR, 'worker-thread-slow-entry.mjs'),
      timeoutMs: 200,
    }),
    /timed out after 200ms/i,
  )
  const elapsed = Date.now() - start
  assert.ok(elapsed < 1500, `timeout enforcement took ${elapsed}ms (expected <1500)`)
})

test('worker_thread: rejects malformed input (missing prompt) without spawning', async () => {
  await assert.rejects(
    () => runWorkerThreadSubagent({
      input: { description: 'no prompt' },
      context: { cwd: process.cwd() },
      workerEntryPathOverride: join(FIXTURES_DIR, 'worker-thread-stub-entry.mjs'),
    }),
    /input\.prompt must be a non-empty string/i,
  )
})

test('worker_thread: rejects when worker exits without sending a completion', async () => {
  await assert.rejects(
    () => runWorkerThreadSubagent({
      input: { prompt: 'hello' },
      context: { cwd: process.cwd() },
      workerEntryPathOverride: join(FIXTURES_DIR, 'worker-thread-silent-exit-entry.mjs'),
      timeoutMs: 5000,
    }),
    /exited with code .* before sending a completion/i,
  )
})
