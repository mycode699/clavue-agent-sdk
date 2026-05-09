/**
 * Slice D phase 1 — worker_thread subagent runtime stub.
 *
 * The type signature is stable so callers can wire `runtime:
 * 'worker_thread'` through the public API today. Phase 2 will replace
 * this stub with a real worker_thread implementation.
 */
import type { AgentJobCompletion } from '../agent-jobs.js'
import type { ToolContext } from '../types.js'

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented yet`)
    this.name = 'NotImplementedError'
  }
}

export interface RunWorkerThreadSubagentOptions {
  input: unknown
  context: ToolContext
  abortSignal?: AbortSignal
  allowedTools?: string[]
  appendSystemPrompt?: string
}

export async function runWorkerThreadSubagent(
  _options: RunWorkerThreadSubagentOptions,
): Promise<AgentJobCompletion> {
  throw new NotImplementedError('worker_thread subagent runtime')
}
