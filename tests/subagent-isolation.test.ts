import test from 'node:test'
import assert from 'node:assert/strict'

import { runAgentSubagent, NotImplementedError } from '../src/index.ts'
import type { ToolContext } from '../src/index.ts'
import type { LLMProvider } from '../src/providers/types.ts'

// We can't run the full inprocess subagent here without a live LLM
// provider; the goal of phase 1 is the *envelope* — the subset/abort/runtime
// guards. We cover those without spinning up a real network call.
//
// Important: ambient env (ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN) can
// silently make `apiKey: undefined` *succeed* against a proxy. Tests must
// pin a synthetic throwing provider via `context.provider` to keep the
// envelope assertions deterministic and offline.
function makeFailingProvider(message = 'no provider configured for test'): LLMProvider {
  return {
    apiType: 'anthropic-messages',
    async createMessage() { throw new Error(message) },
  }
}

test('Slice D phase 2: runtime="worker_thread" spawns a worker (no longer the NotImplemented stub)', async () => {
  // Phase 2 replaces the stub with a real worker_thread runtime. The
  // stub error class (NotImplementedError) is retained as a public export
  // for backwards compat, but the runtime no longer throws it.
  // We can't run a full subagent here without a live LLM provider, so we
  // verify the worker is reachable via a stub entry script that posts a
  // synthetic completion. That proves the parent-side wiring (spawn +
  // message + terminate) without booting the real Agent.
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const stubEntry = join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'worker-thread-stub-entry.mjs',
  )

  const { runWorkerThreadSubagent } = await import('../src/runtime/worker-thread-subagent.ts')
  const completion = await runWorkerThreadSubagent({
    input: { prompt: 'noop', description: 'noop' },
    context: { cwd: process.cwd() },
    workerEntryPathOverride: stubEntry,
    timeoutMs: 5000,
  })
  assert.equal(completion.output, 'stub-completion')
})

test('Slice D: strictToolSubset rejects subagent tools not in parent availableTools', async () => {
  const context: ToolContext = {
    cwd: process.cwd(),
    availableTools: ['Read', 'Glob'],
  }
  await assert.rejects(
    () => runAgentSubagent({
      input: { prompt: 'noop', description: 'noop' },
      context,
      allowedTools: ['Read', 'Bash'],
      strictToolSubset: true,
    }),
    /tools not available to parent/i,
  )
})

test('Slice D: strictToolSubset accepts a true subset (then fails later — that is fine)', async () => {
  const context: ToolContext = {
    cwd: process.cwd(),
    availableTools: ['Read', 'Glob', 'Bash'],
    // Pin a synthetic provider so the test does NOT hit the network even if
    // ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN are set in the environment.
    provider: makeFailingProvider('synthetic engine failure (test fixture)'),
  }
  // We expect the subset check to pass. The subagent will fail later
  // because the synthetic provider throws, but it must NOT fail with
  // the subset error. So we capture the error and assert message shape.
  let err: unknown
  try {
    await runAgentSubagent({
      input: { prompt: 'noop', description: 'noop' },
      context,
      allowedTools: ['Read', 'Glob'],
      strictToolSubset: true,
    })
  } catch (caught) {
    err = caught
  }
  assert.ok(err instanceof Error, 'subagent should reach the engine and surface the synthetic provider error')
  assert.doesNotMatch(String((err as Error).message), /tools not available to parent/i)
  assert.match(String((err as Error).message), /synthetic engine failure/i)
})

test('Slice D phase 2: pre-existing parent abort rejects worker_thread with "Aborted before ... started"', async () => {
  // Once phase 2 landed, an already-aborted parent signal short-circuits
  // before any Worker is spawned. The rejection message is the explicit
  // pre-flight sentinel — not NotImplementedError, which only applied to
  // the phase 1 stub.
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const context: ToolContext = { cwd: process.cwd(), abortSignal: controller.signal }
  await assert.rejects(
    () => runAgentSubagent({
      input: { prompt: 'noop', description: 'noop' },
      context,
      runtime: 'worker_thread',
    }),
    /aborted before worker_thread subagent started/i,
  )
})

test('Slice D: NotImplementedError class is exported and has correct name', () => {
  const err = new NotImplementedError('test feature')
  assert.equal(err.name, 'NotImplementedError')
  assert.match(err.message, /test feature/)
  assert.match(err.message, /not implemented/i)
})
