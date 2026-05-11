/**
 * Tier A #1 — turn-scoped tool result memoization.
 *
 * Caches the output of `tool.call()` for tools that declare
 * `isReadOnly() && isConcurrencySafe()`. Cache lookup is keyed by
 * `(toolName, stable JSON of input)`, so two model-emitted tool_use blocks
 * that ask for the same read with the same arguments hit the cache rather
 * than re-doing the IO.
 *
 * Engine placement: lookup happens *around* `tool.call()` only —
 * permission checks, PreToolUse/PostToolUse hooks, and guardrail
 * `tool_input` / `tool_output` evaluations still run on every call. The
 * cache only elides the actual tool work; host control points are
 * preserved.
 *
 * Concurrency: read-only concurrency-safe tools dispatch in parallel via
 * `Promise.all`. `getOrCompute` dedupes in-flight calls so duplicate
 * inputs scheduled in the same batch share one `tool.call()` Promise
 * rather than racing four separate fetches against an empty cache.
 *
 * Lifetime: one cache per turn (created in `executeTools`). Across-turn
 * sharing is intentionally avoided so model state never sees a stale read.
 */
import type { ToolResult } from '../types.js'

export function stableInputKey(input: unknown): string {
  try {
    return JSON.stringify(input, replacerSortedKeys())
  } catch {
    return String(input)
  }
}

function replacerSortedKeys(): (key: string, value: unknown) => unknown {
  return function replacer(_key, value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const sorted: Record<string, unknown> = {}
      for (const k of Object.keys(value as Record<string, unknown>).sort()) {
        sorted[k] = (value as Record<string, unknown>)[k]
      }
      return sorted
    }
    return value
  }
}

export interface ToolResultCacheStats {
  hits: number
  misses: number
  size: number
}

export interface ToolResultCacheOutcome {
  result: ToolResult
  cached: boolean
}

/**
 * Per-turn cache for read-only concurrency-safe tool results. The cache
 * shares one in-flight `compute()` across concurrent duplicate callers
 * and stores the resolved result for later sequential duplicates.
 *
 * `is_error` results are never retained — replaying them would mask
 * retries when the next call could succeed.
 */
export class ToolResultCache {
  private store = new Map<string, Promise<ToolResult>>()
  private resolved = new Map<string, ToolResult>()
  private hits = 0
  private misses = 0

  static keyFor(toolName: string, input: unknown): string {
    return `${toolName}::${stableInputKey(input)}`
  }

  async getOrCompute(
    toolName: string,
    input: unknown,
    compute: () => Promise<ToolResult>,
  ): Promise<ToolResultCacheOutcome> {
    const key = ToolResultCache.keyFor(toolName, input)

    // Already resolved (sequential duplicate after the producer finished).
    const settled = this.resolved.get(key)
    if (settled !== undefined) {
      this.hits++
      return { result: settled, cached: true }
    }

    // Concurrent duplicate — wait on the in-flight producer.
    const inflight = this.store.get(key)
    if (inflight !== undefined) {
      this.hits++
      const result = await inflight
      // Producer dropped the entry (is_error). Re-run compute() locally
      // so the late caller still gets a real result.
      if (result.is_error === true) {
        const fresh = await compute()
        if (fresh.is_error !== true) this.resolved.set(key, fresh)
        return { result: fresh, cached: false }
      }
      return { result, cached: true }
    }

    // First caller — own the producing Promise.
    this.misses++
    const promise = compute()
    this.store.set(key, promise)
    let produced: ToolResult
    try {
      produced = await promise
    } finally {
      this.store.delete(key)
    }
    if (produced.is_error !== true) this.resolved.set(key, produced)
    return { result: produced, cached: false }
  }

  stats(): ToolResultCacheStats {
    return { hits: this.hits, misses: this.misses, size: this.resolved.size }
  }
}
