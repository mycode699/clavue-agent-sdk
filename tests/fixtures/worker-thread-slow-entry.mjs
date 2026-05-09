/**
 * Test fixture — worker_thread entry that sleeps for a long time and only
 * then posts a completion. Used to exercise abort + timeout paths.
 */
import { parentPort } from 'node:worker_threads'

setTimeout(() => {
  parentPort?.postMessage({ kind: 'completion', completion: { output: 'late' } })
}, 5000)
