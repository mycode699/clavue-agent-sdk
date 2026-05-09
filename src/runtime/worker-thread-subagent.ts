/**
 * Slice D phase 2 — worker_thread subagent runtime.
 *
 * The parent calls `runWorkerThreadSubagent` to spawn a Node worker that
 * runs the requested subagent prompt against a freshly-constructed Agent.
 * Hard isolation that the inprocess runtime cannot offer:
 *
 *   - V8 isolate boundary (separate heap, separate event loop).
 *   - Hard abort: parent .abort() ⇒ worker.terminate() within ~50ms.
 *   - Tool registries (tasks, teams, jobs, mailboxes, cron) are
 *     re-initialized in the worker, so a subagent's task/team writes do
 *     NOT leak into the parent's runtime registries.
 *   - The worker only receives a typed payload (no live functions or
 *     parent state). API credentials are read from the parent's env at
 *     spawn time and forwarded as `workerData.env`.
 *
 * Scope (intentionally small):
 *   - Subagent type defaults to 'general-purpose' (matches inprocess).
 *   - allowedTools narrowing happens parent-side before spawn, so the
 *     worker just receives the final list.
 *   - The worker returns the same `AgentJobCompletion` shape the
 *     inprocess path returns, so callers can treat both runtimes
 *     identically.
 *
 * The Phase 1 NotImplementedError class is preserved as a public export
 * for backwards compatibility — tests and downstream consumers still import
 * it, and it remains useful as a discriminator for "feature gated" errors.
 */
import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import type { AgentJobCompletion } from '../agent-jobs.js'
import type { ToolContext } from '../types.js'

export class NotImplementedError extends Error {
  constructor(feature: string) {
    super(`${feature} is not implemented yet`)
    this.name = 'NotImplementedError'
  }
}

export interface WorkerSubagentInput {
  prompt: string
  description?: string
  subagent_type?: string
  model?: string
  /** Append to the spawned Agent's system prompt. */
  append_system_prompt?: string
}

export interface RunWorkerThreadSubagentOptions {
  input: WorkerSubagentInput | unknown
  context: ToolContext
  abortSignal?: AbortSignal
  allowedTools?: string[]
  appendSystemPrompt?: string
  /**
   * Hard cap on worker run wall-time. Default 5 minutes. Set 0 to disable.
   * Parent will terminate() the worker on timeout.
   */
  timeoutMs?: number
  /**
   * Test seam — override the spawned worker entry path. Production callers
   * never set this; it lets unit tests run against a tiny stub worker that
   * exercises the parent-side wiring without booting a real Agent.
   */
  workerEntryPathOverride?: string
}

/**
 * Worker payload shape — must be structurally cloneable. No functions, no
 * AbortSignals, no class instances.
 */
export interface WorkerPayload {
  input: WorkerSubagentInput
  cwd: string
  allowedTools?: string[]
  appendSystemPrompt?: string
  apiType?: string
  model?: string
  /**
   * Subset of process.env that the worker is allowed to read for credentials
   * + transport config. We forward only the CLAVUE_AGENT_* keys + a few
   * standard provider keys, never the full parent env.
   */
  env: Record<string, string>
}

const FORWARDED_ENV_KEYS = [
  'CLAVUE_AGENT_API_KEY',
  'CLAVUE_AGENT_AUTH_TOKEN',
  'CLAVUE_AGENT_API_TYPE',
  'CLAVUE_AGENT_MODEL',
  'CLAVUE_AGENT_BASE_URL',
  'CLAVUE_AGENT_AUTONOMY',
  'CLAVUE_AGENT_PERMISSION_MODE',
  'AGENT_SDK_MAX_TOOL_CONCURRENCY',
  // Common ambient credentials (Anthropic SDK reads these by default).
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
] as const

function pickForwardedEnv(parentEnv: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of FORWARDED_ENV_KEYS) {
    const value = parentEnv[key]
    if (typeof value === 'string' && value.length > 0) {
      out[key] = value
    }
  }
  return out
}

function normalizeSubagentInput(raw: unknown): WorkerSubagentInput {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Worker subagent input must be an object with a prompt field')
  }
  const r = raw as Record<string, unknown>
  if (typeof r.prompt !== 'string' || r.prompt.length === 0) {
    throw new Error('Worker subagent input.prompt must be a non-empty string')
  }
  return {
    prompt: r.prompt,
    description: typeof r.description === 'string' ? r.description : undefined,
    subagent_type: typeof r.subagent_type === 'string' ? r.subagent_type : undefined,
    model: typeof r.model === 'string' ? r.model : undefined,
    append_system_prompt:
      typeof r.append_system_prompt === 'string' ? r.append_system_prompt : undefined,
  }
}

/**
 * Resolve the worker entrypoint script.
 *
 * Two cases:
 *   - Compiled (`dist/runtime/worker-thread-subagent.js`): the matching
 *     entry is `dist/runtime/worker-thread-entry.js` next to it.
 *   - Source (`src/runtime/worker-thread-subagent.ts` under tsx): the
 *     entry is `src/runtime/worker-thread-entry.ts`. We forward
 *     `process.env` so the tsx loader hook in the parent is visible to
 *     the worker.
 *
 * Either way, both files are siblings of this module, so we resolve them
 * via `import.meta.url`.
 */
function resolveWorkerEntryPath(): string {
  const here = fileURLToPath(import.meta.url)
  const dir = dirname(here)
  const isCompiled = here.endsWith('.js')
  return join(dir, isCompiled ? 'worker-thread-entry.js' : 'worker-thread-entry.ts')
}

interface WorkerCompletionMessage {
  kind: 'completion'
  completion: AgentJobCompletion
}

interface WorkerErrorMessage {
  kind: 'error'
  message: string
  stack?: string
}

type WorkerMessage = WorkerCompletionMessage | WorkerErrorMessage

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000

export async function runWorkerThreadSubagent(
  options: RunWorkerThreadSubagentOptions,
): Promise<AgentJobCompletion> {
  const input = normalizeSubagentInput(options.input)

  // Pre-flight abort: don't spawn anything if the parent already aborted.
  if (options.abortSignal?.aborted || options.context.abortSignal?.aborted) {
    throw new Error('Aborted before worker_thread subagent started')
  }

  const payload: WorkerPayload = {
    input,
    cwd: options.context.cwd ?? process.cwd(),
    allowedTools: options.allowedTools,
    appendSystemPrompt: options.appendSystemPrompt,
    apiType: options.context.apiType ?? process.env.CLAVUE_AGENT_API_TYPE,
    model: options.context.model ?? process.env.CLAVUE_AGENT_MODEL,
    env: pickForwardedEnv(process.env),
  }

  const entryPath = options.workerEntryPathOverride ?? resolveWorkerEntryPath()
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise<AgentJobCompletion>((resolve, reject) => {
    let settled = false
    const settleResolve = (value: AgentJobCompletion) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const settleReject = (err: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(err instanceof Error ? err : new Error(String(err)))
    }

    let worker: Worker
    try {
      worker = new Worker(entryPath, {
        workerData: payload,
        // Inherit env so tsx hook + parent CLAVUE_* vars are visible to the
        // worker entry. The payload.env we forward is what the worker code
        // *uses*; this just keeps the loader hook intact.
        env: process.env,
        // Forward the parent's --require / --import flags so loaders such
        // as tsx (used during dev/test) are active inside the worker. In
        // production where the entry is .js, execArgv is typically empty
        // and this is a no-op.
        execArgv: process.execArgv,
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)))
      return
    }

    // Abort wiring: if either the explicit abortSignal or the context's
    // abortSignal fires, terminate the worker. Both signals are linked so
    // either source aborts the run.
    const linkedAbort = (reason?: unknown) => {
      const message =
        reason instanceof Error
          ? reason.message
          : typeof reason === 'string'
            ? reason
            : 'aborted'
      settleReject(new Error(`Worker subagent aborted: ${message}`))
      worker.terminate().catch(() => {})
    }
    const onAbort = () => linkedAbort(options.abortSignal?.reason ?? options.context.abortSignal?.reason)
    options.abortSignal?.addEventListener('abort', onAbort, { once: true })
    options.context.abortSignal?.addEventListener('abort', onAbort, { once: true })

    // Timeout wiring.
    const timeoutHandle = timeoutMs > 0
      ? setTimeout(() => {
          settleReject(new Error(`Worker subagent timed out after ${timeoutMs}ms`))
          worker.terminate().catch(() => {})
        }, timeoutMs)
      : null
    if (timeoutHandle && typeof timeoutHandle.unref === 'function') timeoutHandle.unref()

    const cleanup = () => {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      options.abortSignal?.removeEventListener('abort', onAbort)
      options.context.abortSignal?.removeEventListener('abort', onAbort)
    }

    worker.on('message', (msg: WorkerMessage) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.kind === 'completion') {
        settleResolve(msg.completion)
        worker.terminate().catch(() => {})
        return
      }
      if (msg.kind === 'error') {
        const err = new Error(msg.message)
        if (msg.stack) err.stack = msg.stack
        settleReject(err)
        worker.terminate().catch(() => {})
      }
    })

    worker.on('error', (err) => settleReject(err))

    worker.on('exit', (code) => {
      if (settled) return
      // exit without a completion message ⇒ worker died unexpectedly.
      settleReject(new Error(`Worker subagent exited with code ${code} before sending a completion`))
    })
  })
}
