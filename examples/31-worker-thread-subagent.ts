/**
 * Example 31 — worker_thread subagent isolation (Slice D phase 2).
 *
 * Demonstrates the hard-isolation subagent runtime. Running a subagent
 * with `runtime: 'worker_thread'` spawns a fresh Node Worker that:
 *
 *   - Has its own V8 isolate (separate heap + event loop).
 *   - Re-constructs a clean Agent from forwarded credentials — no live
 *     state (tasks, teams, mailboxes, cron) is shared with the parent.
 *   - Terminates within ~50ms when the parent's AbortController fires.
 *
 * This is the right choice when you want guarantees that a subagent's
 * crash, infinite loop, or tool write cannot affect the parent process.
 * The `'inprocess'` runtime (default) is lighter but shares the parent
 * heap.
 *
 * Run:
 *   CLAVUE_AGENT_API_KEY=... npx tsx examples/31-worker-thread-subagent.ts
 */
import { runAgentSubagent } from '../src/index.js'
import type { ToolContext } from '../src/index.js'

async function main() {
  const parentContext: ToolContext = {
    cwd: process.cwd(),
    // No parent provider / policy injected — the worker will construct
    // its own Agent from env credentials.
    availableTools: ['Read', 'Glob', 'Grep'],
  }

  const ctrl = new AbortController()

  // Uncomment to demonstrate hard abort — the worker terminates within ~50ms.
  // setTimeout(() => ctrl.abort(new Error('user cancel')), 1500)

  console.log('[parent] spawning worker_thread subagent...')
  const start = Date.now()
  try {
    const completion = await runAgentSubagent({
      input: {
        prompt: 'Summarize what is in ./package.json in one sentence.',
        description: 'repo summary',
      },
      context: parentContext,
      runtime: 'worker_thread',
      allowedTools: ['Read', 'Glob', 'Grep'],
      strictToolSubset: true,
      abortSignal: ctrl.signal,
    })
    console.log(`[parent] completion in ${Date.now() - start}ms:`)
    console.log(completion.output)
  } catch (err) {
    console.error(`[parent] subagent failed after ${Date.now() - start}ms:`, err)
    process.exit(1)
  }
}

main()
