# Changelog

All notable changes to `clavue-agent-sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Schema-versioned public surfaces (SDK events, run results, traces, AgentJob
records, memory traces, controlled execution contract, proof-of-work) are noted
explicitly when they bump.

---

## [1.0.1] — 2026-05-09

First 1.x release. Closes the 17-item v2 audit
([docs/v2_audit_report.md](./docs/v2_audit_report.md)) and ships the
v3 seven-axis capability layer behind subpath imports. Numbered 1.0.1
rather than 1.0.0 because the underlying work cuts the 0.7.x line in
half (engine.ts 1537 → 965, +353 tests, +15 helper modules) and the
maintainer wanted to skip the 0.10.x stretch that other roadmaps
sometimes use as a soft 1.0.

This entry collects everything that previously sat under
`[Unreleased] — path to 1.0.0`. The "Earlier slices" subsection
preserves slice-level provenance for hosts auditing the 0.7.5 → 1.0.1
migration.

### Added (since v0.9.0)

- **P1-6 phase 2: real `worker_thread` subagent runtime**
  (`src/runtime/worker-thread-subagent.ts` rewritten,
  `src/runtime/worker-thread-entry.ts` added). `runtime: 'worker_thread'`
  now spawns a Node `Worker` that runs a fresh `Agent` isolated from the
  parent: separate V8 isolate, re-initialized tool registries (tasks,
  teams, jobs, mailboxes, cron — none leak to the parent), pre-flight
  abort short-circuit, `execArgv` forwarding so tsx/loaders survive into
  the worker, hard 5-minute default timeout. Benchmarks
  (`npm run bench:worker`) report spawnLatency p50 ~56ms,
  abortResolveLatency p50 ~0.1ms, preflightAbort p95 ~0ms. The Phase 1
  `NotImplementedError` class is preserved as a public export for
  backwards compat. Covered by `tests/worker-thread-subagent.test.ts`
  (8 tests) + 5 updated tests under `tests/subagent-isolation.test.ts`.
  Example: `examples/31-worker-thread-subagent.ts`.
- **Slice K1-K5: engine refactor continuation** (audit P1-1). Extracted
  9 more pure helpers from `QueryEngine.submitMessage` so the
  generator method shrinks without behavior change:
  - `src/engine/compact-stage.ts` — pre-turn auto-compaction + micro-compact.
  - `src/engine/turn-request.ts` — skill scope, model selection, streaming
    callback wiring, outputSchema routing.
  - `src/engine/resilient-call.ts` — single retry + fallback + abort/oversize
    guard wrapper; closes audit P1-4 (previously three overlapping paths).
  - `src/engine/turn-bookkeeping.ts` — prompt-too-long compact-and-rewind
    recovery + per-turn usage / cost / trace bookkeeping.
  - `src/engine/result-events.ts` — uniform `SDKResultMessage` builders
    for error (model / guardrail-abort / UserPromptSubmit-block) and
    final (success / max-turns / max-budget / gate-failed) paths.
  - `src/engine/tool-results.ts` — per-tool-call SDK event stream and
    history append in Anthropic's tool_result shape.
  - `src/engine/dispatch-executor.ts` — serial/concurrent batch execution
    with per-call trace callbacks.
  - `src/engine/single-tool-helpers.ts` — uniform error result
    construction, 4-scope guardrail evaluator, skill activation
    side-effect ingestion.

  Net `src/engine.ts`: 1162 → 965 lines (-17%, audit baseline was 1537
  so cumulative reduction is 37%). 15 helper modules under
  `src/engine/*.ts`. `tests/resilient-call.test.ts` (+8),
  `tests/turn-bookkeeping.test.ts` (+7),
  `tests/result-events.test.ts` (+8),
  `tests/tool-results.test.ts` (+7),
  `tests/dispatch-executor.test.ts` (+6),
  `tests/single-tool-helpers.test.ts` (+12).
- **`scripts/bench/` benchmark suite**. Three offline, no-API-key-required
  benches: token estimator accuracy (`bench:tokens`), worker_thread
  spawn/abort latency (`bench:worker`), engine LoC + suite wall-time
  (`bench:engine`). Results pasted into
  [docs/v2_benchmark_report.md](./docs/v2_benchmark_report.md). Added
  npm scripts: `bench`, `bench:tokens`, `bench:worker`, `bench:engine`.
- **Token estimator classifier tuning**. Lowered the code-detection
  threshold from 0.18 to 0.08 and extended the symbol set to cover
  `[ ] , . : | & * + - ! ?` in addition to the C-style punctuation.
  TypeScript and Python snippets now classify as `code` (density
  0.333 tokens/char) instead of degrading to `english` (0.253). Verified
  by `bench:tokens` v2 density spread = 0.373 across 4 content classes.
- **Honest test hygiene fix for Slice D**. `tests/subagent-isolation.test.ts:39`
  was passing silently on CI/dev machines that set `ANTHROPIC_BASE_URL`
  + `ANTHROPIC_AUTH_TOKEN` (such as Claude Code itself) because the
  Anthropic SDK silently picked up the ambient proxy and returned 200s
  instead of failing. Fixed by pinning an explicit throwing
  `LLMProvider` via `context.provider` so the envelope assertion is
  deterministic and offline. Runtime dropped from ~13s to ~0.8s.

### Documentation

- [docs/v2_benchmark_report.md](./docs/v2_benchmark_report.md) — every
  v2 improvement paired with a reproducible measurement, plus explicit
  "what was NOT measured" list. Reproduce with `npm run bench`.
- [docs/v1_to_v2_migration.md](./docs/v1_to_v2_migration.md) — upgrade
  guide for 0.7.x hosts. Covers streaming adoption, Anthropic caching
  verification, subpath imports, deprecations
  (`runIssueWorkflow`, `jsonSchema`, `maxThinkingTokens`, `cost`), and
  the `worker_thread` subagent runtime choice.

### Verified at release

```
src/engine.ts:    965 lines (-37% vs audit 0.7.5 baseline 1537)
helpers:          15 files under src/engine/* (1644 lines)
tests:            625 / 625 pass (vs 272 at audit baseline)
tsc --noEmit:     0 errors
test wall-time:   ~35 s (single sequential run, no parallelism)
```

Reproduce with `npm run test`, `npx tsc --noEmit`, and `npm run bench`.

### Not shipped (deferred to 1.1.x)

- Anthropic `countTokens` integration in the online bench path — blocked
  by proxy that returns 404 on `/v1/messages/count_tokens`; the bench
  falls back to offline mode.
- Full M2 pipeline refactor (Guard → Compact → Render → Call → Stream →
  Tools → Decide). Slice K extraction landed 9 pure helpers but the
  generator body itself is still ~400 lines; true pipeline lands later.

---

## [Unreleased]

(empty — all unreleased entries graduated into 1.0.1 above.)

### Earlier slices on the unreleased branch

The 1.0.0 work-up continues per:

- [docs/v2_audit_report.md](./docs/v2_audit_report.md) — 17-issue audit of 0.7.5
- [docs/v2_roadmap.md](./docs/v2_roadmap.md) — milestones M0..M7 → 1.0.0
- [docs/v2_implementation_slices.md](./docs/v2_implementation_slices.md) — worker-disjoint slice catalog for the 12 remaining P1/P2/P3 items

### Added

- **Slice H tool dispatch planner** (`planToolDispatch`) — extracts the
  order-preserving concurrent grouping algorithm from
  `QueryEngine.executeTools` into a pure helper in
  `src/engine/tool-helpers.ts`. Same semantics: consecutive
  concurrency-safe tools collapse into a single `concurrent` batch;
  non-concurrent tools become `serial` singletons that fence the run.
  The engine now consumes the plan instead of maintaining inline
  pending-batch state. Separately testable without spinning up the
  engine. Covered by `tests/tool-dispatch-plan.test.ts` (6 tests).
  Zero new runtime deps.
- **Slice G token counter API warmup (additive)** —
  `src/tokens/api-counter.ts` introduces a structural `TokenCounter`
  interface and an `ApiBackedCounter` that calibrates an EMA-smoothed
  correction factor against a host-supplied
  `client.messages.countTokens` endpoint. The synchronous `count(text)`
  always returns immediately (heuristic until the first calibration
  resolves), so this is a drop-in counter for hosts that want better
  accuracy than the chars-per-token heuristic. Engine integration is
  intentionally deferred to keep this slice non-breaking; hosts can
  opt-in directly by constructing the counter and feeding observations
  via `observeUsage`.
  New public exports: `TokenCounter`, `CountTokensClientLike`,
  `ApiBackedCounter`, `ApiBackedCounterOptions`,
  `createApiBackedCounter`, `heuristicCounter`. Covered by
  `tests/token-counter.test.ts` (8 tests including async warmup,
  EMA blending, throwing-API fallback, periodic re-probe). Zero new
  runtime deps.
- **Slice D phase 1 subagent runtime + isolation** —
  `runAgentSubagent` accepts two new options:
  - `runtime?: 'inprocess' | 'worker_thread'` — defaults to `'inprocess'`
    (existing behavior). `'worker_thread'` is a stable type signature
    backed by `runWorkerThreadSubagent`, which throws `NotImplementedError`
    in phase 1; phase 2 will swap in the real worker_thread runtime.
  - `strictToolSubset?: boolean` — when true, throws synchronously if the
    subagent's `allowedTools` contains any name not in the parent's
    `availableTools`. Default false preserves the legacy silent
    intersection behavior.

  Parent abort signals are now linked through a forked
  `AbortController`, so a parent abort propagates to the child engine
  while the child cannot abort the parent. The fork is disposed
  deterministically when the subagent finishes (success or throw).

  New public exports: `SubagentRuntime`, `NotImplementedError`,
  `runWorkerThreadSubagent`. Covered by
  `tests/subagent-isolation.test.ts` (5 tests). Zero new runtime deps.
- **Slice I file state cache ↔ Read/Edit interlock** — `ToolContext` gains
  an optional `fileStateCache?: FileStateCache`. When provided:
  - `FileReadTool` populates the cache (content + `mtimeMs`) on every
    successful read.
  - `FileEditTool` checks `stat().mtimeMs` against the cached timestamp
    before reading; if the file changed out-of-band since the last Read,
    it returns an error directing the agent to re-Read. After a
    successful edit it refreshes the cache to its own write.
  Without a cache in context the tools behave exactly as before
  (back-compat verified by a dedicated test). Covered by 4 new tests in
  `tests/tools.test.ts`. Zero new runtime deps.
- **Slice F unified WorkItem core type** (`src/workflow/work-item.ts`) — a
  single `{ id, title, acceptance, status, evidence, links, rawStatus? }`
  shape spanning the three workflow data views (`WorkflowDefinition`,
  `OrchestrationIssue`, `IssueWorkflowRecord`). Pure converters in both
  directions; round-trips are stable for `OrchestrationIssue` and
  `IssueWorkflowRecord`. Original types and exports are unchanged. New
  public exports: `WorkItem`, `WorkItemStatus`, `WorkItemLink`,
  `workflowDefinitionToWorkItem`, `orchestrationIssueToWorkItem`,
  `issueWorkflowRecordToWorkItem`, `workItemToOrchestrationIssue`,
  `workItemToIssueWorkflowRecord`, `normalizeStateToWorkItemStatus`.
  Covered by `tests/work-item.test.ts` (11 tests). Zero new runtime deps.
- **Slice J runtime profile shorthand** (`AgentPreset`) — `createAgent({
  profile })` and `new Agent({ profile })` now accept four named presets that
  expand into preconfigured `AgentOptions`:
  - `autonomous` — `mode: 'trustedAutomation'`, `autoInject: true`,
    `maxTurns: 50`
  - `interactive` — `mode: 'plan'`, `interactionMode: 'supervised'`,
    `maxTurns: 10`
  - `sandboxed` — `mode: 'auto'`, repo-readonly toolset, `memory: { enabled:
    false }`, `maxTurns: 5`
  - `minimal` — `mode: 'default'`, `memory: { enabled: false }`
  Explicit caller fields always win; the preset only fills gaps. The
  `profile` field is stripped from the merged config so retries / nested
  constructors don't re-apply. New public exports: `AgentPreset`,
  `applyAgentPreset`, `expandAgentPreset`. Covered by
  `tests/runtime-profiles.test.ts` (13 tests). Zero new runtime deps.
- **P1-5 koa-style middleware layer** (`src/middleware/`) — `agent.use(mw)`
  registers `(ctx, next) => Promise<void>` middlewares that wrap every
  `agent.query()` / `agent.run()` / `agent.prompt()` invocation. Mutating
  `ctx.prompt` and `ctx.options` before `next()` is honored; skipping
  `next()` short-circuits the engine call. Composes with existing event
  hooks (does not replace them). New public exports: `Middleware`,
  `MiddlewareContext`, `composeMiddleware`, `createMiddlewareContext`,
  `CoreRunner`. Covered by `tests/middleware.test.ts` (12 tests including
  rate-limit, audit-log, PII-redact patterns). Zero new runtime deps.
- **P1-7 memory vector retrieval (additive)** — `MemoryConfig.retrieval`
  accepts `'keyword'` (default, unchanged), `'vector'`, or `'hybrid'`.
  Hosts inject a structural `EmbedderLike { embed(text): Promise<number[]> }`;
  the SDK adds zero new runtime deps. `queryMemoryMatches` dispatches to
  cosine-similarity scoring when `strategy` is vector / hybrid; the legacy
  keyword path is byte-identical for `strategy: 'keyword'` (default).
  New public exports: `EmbedderLike`, `MemoryRetrievalStrategy`,
  `cosineSimilarity`. Covered by `tests/memory-vector.test.ts` (10 tests
  including pure cosine helper, synonym retrieval, hybrid union, no-embedder
  fallback, and embedder-throwing fallback).

### Planned (carry-overs from v2 audit)

- M2 turn pipeline (`Guard → Compact → Render → Call → Stream → Tools → Decide`)
  replacing the monolithic `QueryEngine.submitMessage` hot path.
- P1-4 unified `ResilientCall` wrapping retry / fallback / compact-recovery in
  one path, replacing the current three-branch error handling in
  `QueryEngine.submitMessage`.
- M6 subagent isolation (`inprocess` / `worker_thread`), tool-inheritance
  narrowing, budget propagation.
- M7 v1→v2 migration guide, benchmark report (TTFT, multi-turn cost, hot-path
  LoC, dispatch overhead, abort latency), README split into topic pages.

---

## [0.9.0] — 2026-05-09

v3 capability layer release. Additive: zero engine API breakage, zero new
runtime npm dependencies. SemVer minor bump because seven new public
subsurfaces and seven new subpath exports are introduced; existing 0.8.0
imports keep working unchanged.

- **Multi-agent graph DSL** (`src/graph/`) with 6 node kinds — `agent`,
  `verifier`, `router`, `parallel`, `human`, `retriever` — plus `runGraph`
  runtime. Trace-aware and guardrail-aware out of the box. Covered by
  `tests/graph.test.ts` + `tests/graph-retriever.test.ts`. Examples:
  `examples/19-graph-dsl.ts`, `examples/28-rag-graph.ts`.
- **4-scope Guardrails** (`src/guardrails/`) — `input`, `output`,
  `tool_input`, `tool_output` — with policy hook
  (`'abort' | 'skip' | 'continue'`, default `'skip'` for tool scopes).
  `GuardrailAbortError` sentinel + `error_guardrail_abort` terminal
  subtype. Engine integration in `src/engine.ts` fires pre/post `runTool`.
  Covered by `tests/guardrails.test.ts`,
  `tests/engine-guardrails.test.ts`,
  `tests/engine-guardrails-policy.test.ts`. Example:
  `examples/20-guardrails.ts`.
- **Live Tracing + replay + OTel SDK bridge** (`src/tracing/`) —
  `TraceStore` records every step; `OtelTraceExporter`
  (`src/tracing/otel-shim.ts`) bridges into any
  `@opentelemetry/api` tracer via the structural `OtelTracerLike`
  interface. Covered by `tests/tracing.test.ts`,
  `tests/tracing-exporter.test.ts`,
  `tests/tracing-otel-shim.test.ts`. Examples:
  `examples/21-tracing-replay.ts`, `examples/27-trace-exporter.ts`,
  `examples/29-otel-shim.ts`.
- **Capability tokens / sandbox primitives** (`src/sandbox/`). Covered by
  `tests/sandbox.test.ts`. Example: `examples/22-capability-tokens.ts`.
- **RAG retriever interface + `InMemoryRetriever` + `PgvectorRetriever`**
  (`src/rag/`). Pgvector adapter uses structural `PgClientLike`, no `pg`
  npm dep. `retriever` graph node kind feeds hits into downstream
  `agent` nodes by default. Covered by `tests/rag.test.ts`,
  `tests/rag-pgvector.test.ts`, `tests/graph-retriever.test.ts`.
  Examples: `examples/23-rag-retriever.ts`, `examples/28-rag-graph.ts`.
- **Framework-agnostic Generative UI stream**
  (`src/genui/` — `UiStreamSink` / `UiStreamSource`). Covered by
  `tests/genui.test.ts`. Example: `examples/24-generative-ui.ts`.
- **Provider-agnostic voice (ASR + TTS)** (`src/voice/`) — stubs +
  `DeepgramAsrProvider`, `WhisperOpenAiAsrProvider`,
  `ElevenLabsTtsProvider` real adapters. All three use structural
  `FetchLike`, no `axios` / `node-fetch` deps. Covered by
  `tests/voice.test.ts`, `tests/voice-adapters.test.ts`. Examples:
  `examples/25-voice.ts`, `examples/30-voice-adapters.ts`.
- **Subpath exports** (`package.json` `exports`) — every v3 axis ships
  its own subpath for tree-shaken imports:
  - `clavue-agent-sdk/graph`
  - `clavue-agent-sdk/guardrails`
  - `clavue-agent-sdk/tracing`
  - `clavue-agent-sdk/sandbox`
  - `clavue-agent-sdk/rag`
  - `clavue-agent-sdk/genui`
  - `clavue-agent-sdk/voice`
  Resolvability + symbol smoke tests in `tests/subpath-exports.test.ts`.
- **Test coverage net additions** beyond the v3 axes:
  - `tests/tokens.test.ts` (12 cases) — `estimateTokens`,
    `estimateMessagesTokens`, `getContextWindowSize`,
    `getAutoCompactThreshold`, `estimateCost` branches.
  - `tests/memory-policy.test.ts` (9 cases) —
    `extractSessionMemoryCandidates` classification + dedup + tag
    building behavior pinned.
- **Capability comparison matrix** (`README.md`) — 7-row matrix vs
  `claude-agent-sdk-python` / `openai-agents-python` / `Mastra` /
  `Vercel AI SDK` with clickable source + test paths for every claim.

### Verification (post-v3 axes)

- `npm run build` (tsc) — 0 errors
- `npm test` — 500/500 pass (was 472 at audit baseline)
- 12/12 offline examples (`examples/19~30`) green without API keys
- Zero new runtime npm dependencies (all external integrations use
  structural typing: `FetchLike`, `PgClientLike`, `OtelTracerLike`)

### Out of scope (explicit, not yet shipped)

- Realtime websocket voice (Deepgram Live, OpenAI Realtime API).
- Local Whisper binary runner (`whisper.cpp` / `faster-whisper`).
- pgvector real-Postgres integration test (CI runs against a stub
  `PgClientLike`).
- D3 (`runIssueWorkflow` → graph DSL internal replacement) — deferred
  to v4 after honest cost/benefit re-analysis; `runIssueWorkflowWithAgent`
  is already the real path.
- v4 `clavue-orchestrator` platform layer (separate repository).

### Planned (carry-overs from v2 audit)

- M2 turn pipeline (`Guard → Compact → Render → Call → Stream → Tools → Decide`)
  replacing the monolithic `QueryEngine.submitMessage` hot path.
- P1-4 unified `ResilientCall` wrapping retry / fallback / compact-recovery in
  one path, replacing the current three-branch error handling in
  `QueryEngine.submitMessage`.
- P1-5 middleware (`agent.use()`) layer with built-in rate-limit / audit /
  PII-scrubber adapters.
- M6 subagent isolation (`inprocess` / `worker_thread`), tool-inheritance
  narrowing, budget propagation.
- M7 v1→v2 migration guide, benchmark report (TTFT, multi-turn cost, hot-path
  LoC, dispatch overhead, abort latency), README split into topic pages.

---

## [0.8.0] — 2026-05-08

Audit-driven release: 11 of the 17 issues catalogued in
[docs/v2_audit_report.md](./docs/v2_audit_report.md) have landed with
verification (typecheck clean + 325/325 tests + build clean). No breaking
changes; all new APIs are additive and existing entry points keep working.

### Added

- **P0-1 real `runIssueWorkflow` loop** — `src/workflow/issue-workflow-real.ts`
  (307 LoC) and `src/workflow/verifier.ts` (187 LoC) drive a real
  Agent + `Verifier` builder/reviewer/fixer cycle; the legacy
  `evaluateRole` path is retained as a deprecated shim. Demonstrated in
  `examples/17-issue-workflow-real.ts`. Covered by
  `tests/issue-workflow-real.test.ts` and `tests/workflow-verifier.test.ts`.
- **P0-2 structured output via `outputSchema`** — Anthropic synthesizes a
  forced `_output` tool with `tool_choice: { type: 'tool', name: ... }`;
  OpenAI Chat sends `response_format: { type: 'json_schema', json_schema }`.
  The previous `jsonSchema` field is kept as a deprecated alias forwarded
  as `{ schema: jsonSchema }`.
- **M1 streaming integration** — `CreateMessageParams.stream.onText` is now
  forwarded by `QueryEngine`. The Anthropic provider takes the streaming
  path via `client.messages.stream(...).on('text', ...).finalMessage()`.
  When `Agent({ includePartialMessages: true })`, the engine emits
  `partial_message` SDK events for each non-empty text delta before the
  aggregated assistant message. Defaults stay non-streaming so existing
  callers are unaffected. Covered by `tests/streaming.test.ts` (3 tests)
  and the streaming subset of `tests/anthropic-provider.test.ts`.
  Demonstrated in `examples/18-streaming.ts`.
- **M3 Anthropic prompt caching** — `applyToolCaching` and
  `applySystemCaching` set `cache_control: { type: 'ephemeral' }` on the
  trailing tool and trailing system block. Expected to cut multi-turn
  cost by 70–80% on cache hits.
- **M3 fallback-model retry parity** — `shouldUseFallbackModel` now
  triggers on normalized provider 404s in addition to the legacy
  retryable-error path; the unsupported-capability category alone does
  not (regression-guarded by `tests/model-fallback.test.ts`).
- **M3 skill `forked` state tracking** — forked activations are merged
  into `requiredSkillQualityGates` and surfaced via a new
  `forkedSkills: SkillActivation[]` array; `activeSkill` remains
  populated only for `inline` activations.
- **`AUTOCOMPACT_BUFFER_FRACTION = 0.08`** is now exported, so
  1M-token models reserve ~80k headroom instead of the previous
  hard-coded 13k buffer.
- **OpenAI error categorization on the Responses API path** —
  `categorizeOpenAIErrorBody` now also fires on the Responses API failure
  path (covered by `tests/openai-provider.test.ts`).
- **P1-2 / M5 subpath exports** — `package.json#exports` now publishes
  six narrow entry points alongside the root barrel:
  `clavue-agent-sdk/core`, `/tools`, `/contracts`, `/workflow`,
  `/retro`, `/testing`. Each subpath wildcard-re-exports from its
  canonical source modules in `src/subpath/*.ts`. The root barrel is
  unchanged so existing imports keep working. Covered by
  `tests/subpath-exports.test.ts` (8 tests).

### Changed

- **P0-3 token estimation** — `src/utils/tokens.ts` adds CJK / code /
  JSON heuristics with an EMA-calibrated coefficient table (~92 LoC).
  Expected error band tightens from ±35% to ±5–10% on representative
  payloads.
- **P1-3 `types.ts` split** — `src/types.ts` is now a 17-line re-export
  barrel; concrete definitions moved to `src/types/{agent,content,
  context-pack,engine,evidence,mcp,memory,messages,permissions,runtime,
  sandbox,schema-versions,token-usage,tools,trace}.ts`. No public surface
  change — every name is still importable from `clavue-agent-sdk`.
- **P1-1 engine god-class partial extraction** — pure helpers extracted
  from `src/engine.ts` into `src/engine/{memory-helpers,tool-helpers,
  skill-helpers,error-helpers,prompt-helpers,message-helpers,
  quality-gate-helpers}.ts`. `engine.ts` shrinks from 1626 to 1012 LoC
  (~38%). The system-prompt builder, phase-message constructors, and
  quality-gate policy resolution + terminal-failure detection now live
  outside the class. New `tests/quality-gate-helpers.test.ts` (10
  tests) exercises gate resolution without instantiating the engine.
  No behavior change; hot-path semantics preserved. Full M2 pipeline
  rewrite still deferred.

### Deferred to a future release

P1-4 retry/fallback/compact unification, P1-5 middleware, P1-6 subagent
isolation, P1-7 vector memory retrieval, P1-8 unified `WorkItem`,
P2-1..P2-4 (token-warmup, smart concurrency batching, file-state cache
hookup, profile shorthand), P3-1..P3-2 (README split, CLAUDE/AGENTS
deduplication). These are mostly structural refactors best batched with
the M2 pipeline rewrite.

---


## [0.7.5] — 2026-05-05

Last release on the 0.7.x line. See git history (`git log v0.7.5`) for details:
controlled autonomous mode, public schema metadata, local issue workflow
commands, workflow contracts, proof-of-work artifacts, orchestration policy
helpers, capability preflight, normalized provider errors, Responses API
routing with fallback.

---

## Earlier releases

For 0.6.x and earlier, see the git tag history. A consolidated entry will be
added when the v1→v2 migration guide ships in M7.
