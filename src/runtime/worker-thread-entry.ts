/**
 * Slice D phase 2 — worker_thread subagent entrypoint.
 *
 * This file is loaded by `runWorkerThreadSubagent` (parent side) via
 * `new Worker(entryPath)`. It:
 *
 *   1. Reads the typed `WorkerPayload` from `worker_threads.workerData`.
 *   2. Re-exports the forwarded credentials into the worker's `process.env`
 *      so the freshly-constructed Agent finds them via the same code paths
 *      the inprocess runtime uses.
 *   3. Constructs a clean Agent in this worker (no shared state with parent).
 *   4. Calls `agent.run(prompt)` and posts back an `AgentJobCompletion`-shape
 *      message on success, or an error message on failure.
 *
 * Tool calls and inner LLM requests happen entirely inside this worker —
 * the parent only sees the final completion. Abort is enforced by the
 * parent calling `worker.terminate()`; we don't need a graceful shutdown
 * path here (terminate is hard, which is the point of this runtime).
 */
import { parentPort, workerData } from 'node:worker_threads'

import { createAgent } from '../agent.js'
import type { AgentJobCompletion } from '../agent-jobs.js'
import type { WorkerPayload } from './worker-thread-subagent.js'

function postError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err)
  const stack = err instanceof Error ? err.stack : undefined
  try {
    parentPort?.postMessage({ kind: 'error', message, stack })
  } catch {
    // If postMessage itself fails (parent already terminated), there's
    // nothing we can do — the worker will exit shortly.
  }
}

function applyForwardedEnv(env: Record<string, string>): void {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string' && value.length > 0) {
      process.env[key] = value
    }
  }
}

async function main(): Promise<void> {
  if (!parentPort) {
    throw new Error('worker_thread entry must be loaded as a Node worker')
  }
  const payload = workerData as WorkerPayload | undefined
  if (!payload || typeof payload !== 'object' || !payload.input) {
    throw new Error('Worker payload missing or malformed')
  }

  applyForwardedEnv(payload.env ?? {})

  const agent = createAgent({
    cwd: payload.cwd,
    apiType: payload.apiType as any,
    model: payload.model,
    allowedTools: payload.allowedTools,
    appendSystemPrompt: payload.appendSystemPrompt,
    // Worker subagents must not persist sessions silently — that would
    // leak state outside the isolation boundary.
    persistSession: false,
  })

  try {
    const result = await agent.run(payload.input.prompt, {
      cwd: payload.cwd,
      model: payload.input.model ?? payload.model,
      allowedTools: payload.allowedTools,
      appendSystemPrompt: payload.input.append_system_prompt ?? payload.appendSystemPrompt,
    })

    const completion: AgentJobCompletion = {
      output: result.text,
      trace: result.trace,
      evidence: result.evidence,
      quality_gates: result.quality_gates,
    }
    parentPort.postMessage({ kind: 'completion', completion })
  } finally {
    try {
      await agent.close()
    } catch {
      // Best-effort cleanup; the parent terminates the worker after the
      // completion message anyway.
    }
  }
}

main().catch(postError)
