# Tier A Performance — Landing Summary

Status: 6/8 items delivered (numbered #1, #2, #3, #4, #7, #8). Items #5 and #6
were never assigned a concrete scope and are not part of this cycle.

All items are **opt-in or wholly additive** — default behavior is byte-identical
with prior versions. No `*_SCHEMA_VERSION` was bumped (held for v1.1.0).

## Quick reference

| # | Capability | Default | Public API | Trace field | Tests |
|---|---|---|---|---|---|
| 1 | Turn-scoped tool result cache | always-on (transparent) | none (internal) | `AgentRunToolCacheTrace` | `tests/engine-tool-cache.test.ts` |
| 2 | Adaptive tool concurrency (AIMD) | off | `AgentOptions.adaptiveToolConcurrency` | `AgentRunAdaptiveConcurrencyTrace` | `tests/dispatch-executor.test.ts` |
| 3 | Multi-provider fallback chain | accepts string today | `AgentOptions.fallbackModel: string \| string[]` | `retry_count` (existing) | `tests/resilient-call.test.ts` |
| 4 | OpenAI `prompt_cache_key` | always-on (no-op when no prefix) | none (provider-internal) | none (provider request body) | `tests/openai-provider.test.ts` |
| 7 | `listMemories` in-memory cache | always-on (transparent) | `invalidateMemoryCache(dir?)` | none | `tests/memory-list-cache.test.ts` |
| 8 | Memory consolidation | off (manual) | `consolidateMemories`, `findDuplicateMemories` | none | `tests/memory-consolidate.test.ts` |

---

## #1 — Turn-scoped tool result cache

**Goal.** A read-only concurrency-safe tool called twice with identical
arguments inside the same turn should run once.

- **Files.** `src/engine/tool-result-cache.ts` (122 LoC, internal export).
  Wired in `src/engine.ts` at the per-turn dispatch boundary.
- **Eligibility.** Tool must declare `isReadOnly() === true` AND
  `isConcurrencySafe() === true`. Anything else bypasses the cache (and is
  not counted in hits/misses).
- **Cache key.** Tool name + canonical-stringified `tool_input` (stable key
  ordering). Cache scope is one engine turn; cleared between turns.
- **Public API.** None — module is intentionally internal. Example 32 uses a
  deep import (`src/engine/tool-result-cache.ts`) for demo purposes only.
- **Trace surface.** `AgentRunTrace.tool_cache?: { hits, misses }`. Field
  is omitted entirely when no cacheable tool ran (preserves byte-identical
  default traces).
- **Verification.** `tests/engine-tool-cache.test.ts` covers hit / miss /
  bypass-when-not-cacheable / cleared-between-turns.

## #2 — Adaptive tool concurrency (AIMD)

**Goal.** When the host opts in, halve the concurrent chunk size after a
batch with any tool error; add 1 after a clean batch. Bounded by `[min, max]`.

- **Files.** `src/engine/concurrency-controller.ts` (129 LoC),
  `src/engine/dispatch-executor.ts` (93 LoC). Both are internal.
- **Default.** Static no-op pass-through — without opt-in the engine uses
  the existing `maxToolConcurrency` static limit and emits no adaptive
  trace.
- **Public API.** `AgentOptions.adaptiveToolConcurrency: boolean | { min?: number; max?: number; initial?: number }`
  (and the matching `QueryEngineConfig.adaptiveToolConcurrency`). Defaults
  resolve to `min = 1`, `max = resolved maxToolConcurrency`.
- **Trace surface.**
  - `AgentRunAdaptiveConcurrencyTrace { enabled: true, initial, min, max, final, adjustments[] }`
    on `AgentRunTrace.tool_concurrency_adaptive`.
  - `AgentRunAdaptiveConcurrencyAdjustment { batch_index, previous, current, reason }`
    where `reason: 'error' | 'success'`.
  - Field is **absent** in the static-fallback path so legacy traces stay
    byte-identical.
- **Verification.** `tests/dispatch-executor.test.ts` (Tier A #2 section)
  covers AIMD halving on error, additive growth on success, min/max clamps,
  static-mode no-op (trace absent).

## #3 — Multi-provider fallback chain

**Goal.** When the primary model fails with a retryable error, try a chain
of fallback models in order until one succeeds or the chain is exhausted.

- **Files.** `src/engine/resilient-call.ts` (104 LoC). The legacy single-string
  fallback is preserved; the array form is the new path.
- **Public API.** `AgentOptions.fallbackModel: string | string[]` (and
  `QueryEngineConfig.fallbackModel`). Backwards-compatible: string still
  means "one fallback attempt".
- **Trace surface.** Re-uses existing `AgentRunTrace.retry_count`. No new
  trace field — each fallback attempt increments `retry_count` like any
  other retry.
- **Verification.** `tests/resilient-call.test.ts` (Tier A #3 section) covers
  ordered fallback, exhaust-and-fail, single-string back-compat, retryable-
  vs-non-retryable error classification.

## #4 — OpenAI `prompt_cache_key`

**Goal.** Make repeated prefix-shaped requests cache-friendly on the
OpenAI side (Chat Completions and Responses APIs both accept a
`prompt_cache_key`).

- **Files.** `src/providers/openai.ts` — derive a stable key from system
  prompt + tools fingerprint and emit it on every request body that has a
  non-empty prefix.
- **Default.** Always-on. When there is no system prompt and no tools the
  key is omitted (nothing to fingerprint, no cache benefit).
- **Public API.** None — provider-internal. Hosts that disable caching at
  the OpenAI tier still see the unchanged request shape minus the key.
- **Trace surface.** None. The value lives in the request body and never
  leaves the provider boundary.
- **Verification.** `tests/openai-provider.test.ts` — five `Tier A #4` cases
  cover Responses API emission, stability across turns, change-on-prompt-or-
  tools-change, omission when prefix is empty, and Chat Completions parity.

## #7 — `listMemories` in-memory cache

**Goal.** `listMemories()` is on the retrieval hot path. With N memories on
disk it does N file reads + JSON.parses every call. Cache the sorted array
keyed by absolute dir path; invalidate on every write through the public
API.

- **Files.** `src/memory.ts` (cache lives in module scope, ~50 LoC inline
  alongside `listMemories` / `saveMemory` / `deleteMemory`).
  `src/memory/consolidate.ts` was updated to call `invalidateMemoryCache`
  after its direct disk write.
- **Default.** Always-on. Cached entries are returned via `slice()` so
  callers can mutate the result without poisoning the cache.
- **Public API.** New export: `invalidateMemoryCache(dir?: string): void`
  — drops the entry for `dir`, or clears all entries when `dir` is omitted.
  This is the documented escape hatch for sibling processes / external
  writers.
- **Trace surface.** None — the cache is transparent to the engine.
- **Verification.** `tests/memory-list-cache.test.ts` (6 cases): warm-and-
  reuse, save invalidates, delete invalidates, global clear, cached-array
  is mutation-safe (returns a copy), hot-path serves without re-reading
  disk.

## #8 — Memory consolidation

**Goal.** Merge near-duplicate memories that share a stable identity key
(type + scope + normalized title + repo_path + session_id). Single canonical
entry retains the freshest state; older copies' unique content lines are
appended.

- **Files.** `src/memory/consolidate.ts` (317 LoC, fully exported).
- **Default.** Off — host calls `consolidateMemories()` explicitly (e.g.
  on session boundary or via a maintenance task). Default read/write paths
  are untouched.
- **Public API.**
  - `consolidateMemories(options?): Promise<ConsolidateMemoriesReport>`
    — performs merges (or dry-run when `apply: false`).
  - `findDuplicateMemories(options?)` — typed alias for the read-only
    preview (`apply: false`).
  - `ConsolidateMemoriesOptions { apply?, embedder?, similarityThreshold? }`
    extends `MemoryStoreOptions`. With an embedder, cluster members below
    `similarityThreshold` cosine (default 0.85) against the canonical entry
    are split back out as singletons.
  - `ConsolidateMemoriesReport { scanned, duplicate_groups, removed, groups[], dry_run }`.
- **Trace surface.** None — consolidation is a maintenance task, not part
  of any agent turn.
- **Verification.** `tests/memory-consolidate.test.ts` covers identity-key
  grouping, freshness rules (newest `updatedAt` wins, earliest `createdAt`
  preserved, max confidence, freshest `lastValidatedAt`), tag union,
  content-line merge, dry-run mode, embedder-guarded splits, and that
  `invalidateMemoryCache` is called after the direct write.

---

## Items #5 / #6

Reserved slots; never assigned. No deliverables, no tracking issues, no
trace fields.

## Test count delta

Conversation start: 645 passing.

| After | Delta | Source |
|---|---|---|
| 652 | +7 | #3 fallback chain |
| 665 | +13 | #2 adaptive concurrency |
| 673 | +8 | #8 consolidation |
| 679 | +6 | #7 listMemories cache |

Final: **679 / 679** passing on `npm run test`. Build clean on `npm run build`.

## Bench gates (still green)

`npm run bench` regressions checked:

- `engine.ts` line count: audit baseline 1537 → current 1041 (-32.3%).
- worker-thread spawn p50: 60.2 ms.
- worker-thread abort-resolve p95: 0.2 ms.
- worker-thread pre-flight abort p95: 0.0 ms.

## Offline example

`examples/32-tier-a-performance.ts` runs all four offline-testable items
(#1, #2, #3, #8) without an API key. It is included in the curated
`npm run test:examples:offline` set alongside 19 / 22 / 23 / 24 / 25.

---

## Tier B follow-on (same pattern, same shape)

Three additional list-cache layers were added after Tier A, mirroring the
`listMemories` cache exactly:

| Layer | Cache key | Invalidated by | Public escape hatch | Tests |
|---|---|---|---|---|
| `listAgentJobs` | namespace dir | `createAgentJob` / `runAgentJob` / `replayAgentJob` / `stopAgentJob` / `clearAgentJobs` (all routed through `writeAgentJobFile` or `rm`) | `invalidateAgentJobsCache(dir?)` | `tests/agent-jobs-list-cache.test.ts` (7) |
| `listSessions` | sessions dir | `saveSession` / `deleteSession` | `invalidateSessionCache(dir?)` | `tests/session-list-cache.test.ts` (6) |
| `listIssueWorkflowRuns` | namespace dir | every `writeIssueWorkflowRun` (single create / stop / update funnel) | `invalidateIssueWorkflowRunsCache(dir?)` | `tests/issue-workflow-list-cache.test.ts` (6) |

The session list cache also parallelizes the per-session `loadSession`
reads (the previous loop was serial). Stale-refresh logic in
`listAgentJobs` still runs per call — cache only avoids the disk I/O on
clean snapshots; any state transition writes through `saveAgentJob`,
which itself invalidates the cache for the next list.

Final after Tier B: **698 / 698** passing (`+19` from Tier A's 679).

