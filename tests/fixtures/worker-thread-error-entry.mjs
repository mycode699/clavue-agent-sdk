/**
 * Test fixture — worker_thread entry that posts an error then exits.
 */
import { parentPort } from 'node:worker_threads'

parentPort?.postMessage({
  kind: 'error',
  message: 'stub failure: simulated',
  stack: 'Error: stub failure: simulated\n    at fixture',
})
