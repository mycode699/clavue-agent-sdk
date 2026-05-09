/**
 * Test fixture — minimal worker_thread entry that posts a synthetic
 * completion. Used by tests that need to exercise the parent-side spawn /
 * message / terminate wiring without booting a real Agent (which would
 * require a live LLM provider).
 *
 * Plain ESM (.mjs) so it loads in any Node 18+ test runner without a
 * loader hook — keeping the test fixture independent of tsx.
 */
import { parentPort, workerData } from 'node:worker_threads'

function main() {
  if (!parentPort) {
    throw new Error('stub entry must be loaded as a worker')
  }
  // Acknowledge that we received a payload; tests can grow this assertion.
  const ok = workerData && typeof workerData === 'object' && workerData.input
  if (!ok) {
    parentPort.postMessage({ kind: 'error', message: 'stub: malformed payload' })
    return
  }
  parentPort.postMessage({
    kind: 'completion',
    completion: {
      output: 'stub-completion',
    },
  })
}

try {
  main()
} catch (err) {
  parentPort?.postMessage({
    kind: 'error',
    message: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  })
}
