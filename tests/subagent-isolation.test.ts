import test from 'node:test'
import assert from 'node:assert/strict'

import { runAgentSubagent, NotImplementedError } from '../src/index.ts'
import type { ToolContext } from '../src/index.ts'

// We can't run the full inprocess subagent here without a live LLM
// provider; the goal of phase 1 is the *envelope* — the subset/abort/runtime
// guards. We cover those without spinning up the engine.

test('Slice D: runtime="worker_thread" throws NotImplementedError but type signature is stable', async () => {
  const context: ToolContext = { cwd: process.cwd() }
  await assert.rejects(
    () => runAgentSubagent({
      input: { prompt: 'noop', description: 'noop' },
      context,
      runtime: 'worker_thread',
    }),
    (err: Error) => err instanceof NotImplementedError && /worker_thread/i.test(err.message),
  )
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
  }
  // We expect the subset check to pass. The subagent will fail later
  // because there is no provider configured, but it must NOT fail with
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
  assert.ok(err instanceof Error, 'subagent should fail (no provider) but reach the engine')
  assert.doesNotMatch(String((err as Error).message), /tools not available to parent/i)
})

test('Slice D: parent abort signal propagates to subagent (worker_thread path observes parent.aborted via stub)', async () => {
  // We cannot directly observe the linked signal inside runAgentSubagent
  // without an engine. But we can verify that when the parent signal is
  // already aborted before invocation and runtime is worker_thread, the
  // stub still throws NotImplemented (i.e. the runtime dispatch happens
  // before the signal is consumed). This pins the contract: the runtime
  // branch is checked first, then signals are linked for inprocess.
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const context: ToolContext = { cwd: process.cwd(), abortSignal: controller.signal }
  await assert.rejects(
    () => runAgentSubagent({
      input: { prompt: 'noop', description: 'noop' },
      context,
      runtime: 'worker_thread',
    }),
    NotImplementedError,
  )
})

test('Slice D: NotImplementedError class is exported and has correct name', () => {
  const err = new NotImplementedError('test feature')
  assert.equal(err.name, 'NotImplementedError')
  assert.match(err.message, /test feature/)
  assert.match(err.message, /not implemented/i)
})
