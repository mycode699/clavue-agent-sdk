# Changelog

All notable changes to `clavue-agent-sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Schema-versioned public surfaces (SDK events, run results, traces, AgentJob
records, memory traces, controlled execution contract, proof-of-work) are noted
explicitly when they bump.

---

## [1.0.6] — 2026-05-15

Adaptive concurrency observability parity with `tool_cache`. **No source
behavior change in the hot agent loop default path.** No `*_SCHEMA_VERSION`
bump (new `TraceEvent.kind` value is host-extensible by contract). Tests
720 → **728 / 728** passing; `npm run build` clean; `bench:engine` green
(engine.ts 1054 → 1070 LoC, still under the 1100 SLO).

### New TraceEvent kind

- **`tool_concurrency_adjust` per-call event.** AIMD adaptive concurrency
  previously only surfaced through the run-level
  `AgentRunTrace.tool_concurrency_adaptive` aggregate. Hosts wiring a
  `TraceStore` / `OtelTraceExporter` now also receive a streamed event
  on every real limit change (halve / +1), with payload
  `{ batchIndex, previous, current, reason: 'error' | 'success' }` and
  spanId `'tool:concurrency'` (turn-level — concurrency is a fan-out
  decision, not bound to a specific tool). Pin-bounce against `min`/`max`
  emits nothing. Static-mode controller is byte-identical to legacy.
- **OTel mapping.** `eventToOtelSpan` maps the new kind to
  `tool.concurrency.adjust.error` / `tool.concurrency.adjust.success`
  with attributes `tool.concurrency.{reason,previous,current,batch_index}`.
- **Controller telemetry sink.** New
  `AdaptiveConcurrencyOptions.onAdjustment(adjustment)` callback fires
  synchronously inside the controller after every real limit change.
  `buildConcurrencyController` now takes an optional third `onAdjustment`
  parameter (additive, non-breaking). Engine wires this to
  `traceStore.appendToolConcurrencyAdjust` wrapped in try/catch —
  telemetry failures never break a run.

### Public surface (additive)

- `TraceEvent.kind = 'tool_concurrency_adjust'`
- `ToolConcurrencyAdjustEventData` (re-exported from `clavue-agent-sdk/tracing`)
- `TraceStore.appendToolConcurrencyAdjust(...)`
- `AdaptiveConcurrencyOptions.onAdjustment`
- `buildConcurrencyController(_, _, onAdjustment?)`

### Documentation

- `docs/USAGE.md` §11 lists `tool_concurrency_adjust` among the built-in
  TraceEvent kinds.
- `docs/USAGE.md` §20.1 gains a "实时 per-call 事件" paragraph for the
  AIMD axis, mirroring the `tool_cache` write-up shipped in 1.0.5.
- `tests/docs-usage-trace-fields.test.ts` grows from 7 → 8 assertions
  pinning the new doc claims.

### Tests

- New `tests/tracing-tool-concurrency-event.test.ts` (7 tests) locks the
  TraceStore / exporter / controller / `buildConcurrencyController` /
  `JsonlExporter` interleaving contract.
- Suite total: **728 / 728**.

---

## [1.0.5] — 2026-05-15

Runtime observability + enforced perf SLO gate. **No source behavior
change in the hot agent loop default path.** No `*_SCHEMA_VERSION` bump
(new `TraceEvent.kind` value is host-extensible by contract). Tests
701 → **720 / 720** passing; `npm run build` clean.

### Enforced regression gate

- **`npm run bench:engine` now exits non-zero on SLO breach.** Previously
  the script only printed metrics; `clavue.md` claimed it "enforces the
  line-count ceiling" — that claim was false. New pure-function module
  `scripts/bench/engine-slo.ts` evaluates the three SLOs already published
  in `docs/v2_benchmark_report.md §7` (engine.ts LoC < 1100, test count
  ≥ 625, wall-time < 60s) and prints a verdict table; the bench script
  calls `process.exit(1)` on any breach. `clavue.md` claim corrected;
  `docs/v2_benchmark_report.md §7` gains an "Enforced" column.
  Files: `scripts/bench/engine-slo.ts` (new), `scripts/bench/engine-footprint.ts`,
  `clavue.md`, `docs/v2_benchmark_report.md`. Tests:
  `tests/bench-engine-slo.test.ts` (new, 7 tests pinning every threshold
  + null-metric breach paths + renderer output).

### Tracing — per-call `tool_cache` event

- **New built-in `TraceEvent.kind: 'tool_cache'`** for real-time cache
  visibility. Previously the OTel/JSONL stream only had three built-in
  kinds (`graph_step`, `guardrail`, `tool_call`); cache outcomes lived
  only in the post-hoc `AgentRunTrace.tool_cache` aggregate. Engine now
  emits one event per cacheable dispatch (gated on `AgentOptions.trace`),
  payload `{ toolName, toolUseId, outcome: 'hit' | 'miss' }`, spanId
  `tool:<name>` (shared with `tool_call` for parent/child correlation).
- **OTel shim mapping**: `eventToOtelSpan` now maps `tool_cache` events
  to `tool.cache.hit` / `tool.cache.miss` spans with attributes
  `tool.name`, `tool.cache.outcome`, `tool.use_id`.
- **Public surface** (additive): `ToolCacheEventData` type re-exported
  from `clavue-agent-sdk/tracing`; `TraceStore.appendToolCache(payload,
  runId?)` convenience appender mirroring `appendToolCall`. Telemetry
  writes are wrapped in try/catch — a TraceStore failure cannot break
  a run.
  Files: `src/tracing/types.ts`, `src/tracing/runtime.ts`,
  `src/tracing/exporter.ts`, `src/tracing/index.ts`, `src/engine.ts`.
  Tests: `tests/tracing-tool-cache-event.test.ts` (new, 5 tests pinning
  payload shape, OTel span mapping for hit + miss, engine emission
  count for cacheable / non-cacheable tools, JsonlExporter correlation
  via shared `tool:<name>` spanId). `src/engine.ts` 1040 → 1054 LoC
  (under the enforced SLO ceiling of 1100).

### Docs alignment

- **`docs/USAGE.md §20.1` (new)** documents the two optional Tier A
  trace perf fields shipped in 1.0.3 — `tool_cache` and
  `tool_concurrency_adaptive`. Field-presence table, opt-in /
  consumption snippets, contract invariants per field, references to
  the canonical contract tests, and the new "实时 per-call 事件"
  paragraph covering the streaming TraceEvent + OTel span shape.
- **`docs/USAGE.md §11`** now lists `tool_cache` among the built-in
  `TraceEvent` kinds so OTel users discover the streaming signal
  without spelunking into §20.1.
  Files: `docs/USAGE.md`. Tests: `tests/docs-usage-trace-fields.test.ts`
  (new, 7 tests pinning headings, field names, contract invariants,
  test-file references, and ToC anchor wiring).

### Cumulative impact

- 5 retro rounds, 3 keeps, 0 discards in
  `2026-05-15-runtime-observability`.
- Tests 701 → 720 (+19).
- `src/engine.ts` 1040 → 1054 LoC (+14, well under enforced 1100 SLO).
- `bench:engine` becomes a real PR-time regression gate.
- Two new public surfaces (`ToolCacheEventData`,
  `TraceStore.appendToolCache`).

---



Docs alignment + two additive `doctor()` enhancements. **No source behavior
change in the hot agent loop.** No `*_SCHEMA_VERSION` bump. Tests 698 →
**701 / 701** passing; `npm run build` clean.

### Doctor (additive `DoctorReport` shape)

- **`package.entrypoints` now walks `package.json#exports`**. Previously only
  three files (`dist/index.js`, `dist/index.d.ts`, `dist/cli.js`) were
  verified; `package.json#exports` declares 13 subpaths (root + `core` /
  `tools` / `contracts` / `workflow` / `retro` / `testing` + 7 v3 axes).
  A silent subpath build failure would have shipped undetected and crashed
  hosts that did `import 'clavue-agent-sdk/graph'`. Doctor now recursively
  collects every `./...` target into a `Set`, `access()`-checks each, and
  reports `details.checked` alongside `details.missing` so hosts can
  introspect the verified surface. Falls back to the static 3-file list if
  `package.json` is missing or unparseable.
  Files: `src/doctor.ts`. Tests: `tests/doctor.test.ts` (×2 new).
- **New `contracts.schema_versions` check.** All 7 public schema-version
  constants (`SDK_EVENT_SCHEMA_VERSION`, `AGENT_RUN_RESULT_SCHEMA_VERSION`,
  `AGENT_RUN_TRACE_SCHEMA_VERSION`, `AGENT_JOB_RECORD_SCHEMA_VERSION`,
  `MEMORY_TRACE_SCHEMA_VERSION`, `PROOF_OF_WORK_SCHEMA_VERSION`,
  `CONTROLLED_EXECUTION_CONTRACT_VERSION`) are now validated against a
  tight semver pattern at doctor time. Typos like `'1.0'` or `'1.0.0a'`
  surface as `status: 'error'` pre-publish instead of after a downstream
  parser fails. `details.contracts` is a ready-to-display map for host UIs.
  **API**: new `DoctorCheckCategory` value `'contracts'` (additive).
  Files: `src/doctor.ts`, `src/types/runtime.ts`. Tests:
  `tests/doctor.test.ts` (×1 new).

### Examples / docs alignment

- **`examples/31-worker-thread-subagent.ts`** now imports `runAgentSubagent`
  from `'../src/index.js'` (public re-export) instead of
  `'../src/tools/agent-tool.js'` (private path that triggered a
  circular-import TDZ: *Cannot access `AgentTool` before initialization*).
- **`README.md`** test badge / install hint / "What's in 1.0.x" headline +
  metric table + offline-example list realigned to 1.0.3+. `examples/31`
  moved out of the "no API key" block into a separate "needs a real API
  key" snippet (the worker constructs its own Agent from env credentials
  by design). Cross-link to `docs/tier-a-summary.md` from the headline.
- **`docs/USAGE.md`** banner: `1.0.1 详细用法` → `1.0.3 详细用法`. §20
  stale version anchor: `1.0.1 全部仍是 '1.0.0'` → `1.0.3 全部仍是 '1.0.0'`
  (all 7 schema-version constants are still `'1.0.0'`; no semantic change).
- **`docs/production-agent-sdk-capabilities.md`** "Last updated" bumped to
  2026-05-14 (tagged "reflects 1.0.3"). Four "Current status" lines
  rewritten to mark shipped features as present with concrete file
  pointers: fallback chain (`src/engine/resilient-call.ts`), OpenTelemetry
  shim (`src/tracing/otel-shim.ts`), benchmark suite (`npm run bench`
  family), tool-result cache + opt-in adaptive AIMD concurrency,
  schema-versioned event/result/trace surfaces.
- **`docs/programmatic-integration-guide.md` §9** added array-form
  fallback-chain example plus a "Performance & resilience knobs (1.0.3)"
  six-row table covering tool-result cache, `adaptiveToolConcurrency`,
  `fallbackModel: string | string[]`, OpenAI `prompt_cache_key`, the four
  `invalidateXxxCache` hatches, and `consolidateMemories`. Cross-links
  `docs/tier-a-summary.md` and `docs/USAGE.md §21`.

### Tests / build

- `npm run test`: 698 → **701 / 701** passing (+2 doctor subpath tests,
  +1 doctor contracts test).
- `npm run build` clean (`tsc --strict`).
- README offline-list smoke (unset all `*_API_KEY` / `*_AUTH_TOKEN` envs +
  `perl -e 'alarm 30; exec @ARGV' npx tsx` for examples 19/20/21/22/23/
  24/27/28/29/30/32): **11 / 11 pass**.

### Compatibility

- No `*_SCHEMA_VERSION` change. All 7 still `'1.0.0'`.
- `DoctorReport.checks` gains one new entry (`contracts.schema_versions`)
  and `package.entrypoints.details` gains `checked: string[]`. Both
  changes are additive — pre-existing assertions on the report shape
  remain valid.
- `DoctorCheckCategory` union gains `'contracts'` (additive).
- No agent-loop, provider, tool, or trace behavior change.

---

## [1.0.3] — 2026-05-11

Tier A 性能落地 + Tier B list-cache 家族扩展。**默认行为字节级不变**——所有
Tier A 项都是 opt-in 或纯 additive；list cache 全部 transparent + 通过公开
`invalidateXxxCache(dir?)` 提供逃生口。无 `*_SCHEMA_VERSION` bump（保留给
1.1.0）。测试 645 → **698 / 698** passing；`npm run build` clean。

### Tier A — Performance & resilience

完整清单见 [`docs/tier-a-summary.md`](./docs/tier-a-summary.md)。

- **#1 Turn-scoped tool result cache** *(always-on, transparent)*. Read-only
  + concurrency-safe 工具在同一 turn 内被相同参数调用第二次，直接复用首次
  结果。Cache key = tool name + canonical-stringified `tool_input`；turn
  边界自动清空。Trace 增量字段 `AgentRunTrace.tool_cache?: { hits, misses }`
  （无 cacheable 命中时整字段省略）。Files: `src/engine/tool-result-cache.ts`。
  Tests: `tests/engine-tool-cache.test.ts`。
- **#2 Adaptive tool concurrency (AIMD)** *(opt-in)*. 一个 batch 出错时
  并发上限减半，干净批次 +1，clamp 在 `[min, max]`。Static path 完全
  no-op，trace 不写新字段，旧行为字节级不变。**新公开 API**:
  `AgentOptions.adaptiveToolConcurrency: boolean | { min?, max?, initial? }`
  与 `QueryEngineConfig.adaptiveToolConcurrency`；Trace
  `AgentRunTrace.tool_concurrency_adaptive?: AgentRunAdaptiveConcurrencyTrace`。
  Files: `src/engine/concurrency-controller.ts`, `src/engine/dispatch-executor.ts`。
- **#3 Multi-provider fallback chain**. `fallbackModel` 现在接受
  `string | string[]`，按顺序遍历直到一个成功或链耗尽。Single-string
  保持原语义。**API**:
  `AgentOptions.fallbackModel`、`QueryEngineConfig.fallbackModel`。
  复用既有 `retry_count` trace 字段，不新增。Files: `src/engine/resilient-call.ts`。
- **#4 OpenAI `prompt_cache_key`** *(always-on, provider-internal)*. 从
  system prompt + tools fingerprint 派生稳定 key 透传给 OpenAI Responses
  / Chat Completions。无 prefix 时省略。无新 trace。Files: `src/providers/openai.ts`。
- **#7 `listMemories` in-memory cache** *(always-on, transparent)*. 缓存
  按 absolute dir path 索引，`saveMemory` / `deleteMemory` 透过公共 API
  自动 invalidate；返回 `slice()` 副本，调用方 mutation 不会污染缓存。
  **新公开 API**: `invalidateMemoryCache(dir?: string): void`。
  Files: `src/memory.ts`、`src/memory/consolidate.ts`。
- **#8 Memory consolidation** *(opt-in, manual maintenance)*. 按 identity
  key (type + scope + normalized title + repo_path + session_id) 合并近重
  memories，单条 canonical 保留最新状态，其它独有 content lines 追加。
  **新公开 API**: `consolidateMemories(options?)`、
  `findDuplicateMemories(options?)`、`ConsolidateMemoriesOptions`、
  `ConsolidateMemoriesReport`。可选 embedder + `similarityThreshold`
  门控拆分。Files: `src/memory/consolidate.ts`。

### Tier B — List-cache family

与 `listMemories` 同形状的三个额外缓存层，全部 transparent，全部带
`invalidateXxxCache(dir?)` 公开逃生口。

- **`listAgentJobs` cache**. 缓存按 namespace dir 索引；`createAgentJob`/
  `runAgentJob`/`replayAgentJob`/`stopAgentJob`/`clearAgentJobs` 通过
  `writeAgentJobFile` 或 `rm` 透传 invalidation。Stale-refresh 逻辑保留
  在 cache 之外，状态迁移会写穿 `saveAgentJob` 自动失效缓存。
  **新公开 API**: `invalidateAgentJobsCache(dir?: string): void`。
  Files: `src/agent-jobs.ts`. Tests: `tests/agent-jobs-list-cache.test.ts`。
- **`listSessions` cache**. 缓存 + 并行化每个 session 的 `loadSession`
  读盘（此前是 serial）。`saveSession`/`deleteSession` 自动失效。
  **新公开 API**: `invalidateSessionCache(dir?: string): void`。
  Files: `src/session.ts`. Tests: `tests/session-list-cache.test.ts`。
- **`listIssueWorkflowRuns` cache**. 所有 create/stop/update 都从单一
  `writeIssueWorkflowRun` 漏斗写穿。**新公开 API**:
  `invalidateIssueWorkflowRunsCache(dir?: string): void`。
  Files: `src/issue-workflow.ts`. Tests: `tests/issue-workflow-list-cache.test.ts`。

### Documentation

- **`docs/tier-a-summary.md` (NEW)** — Tier A 6 项 + Tier B 3 项的 single
  source of truth：每项列 goal/files/默认行为/公开 API/trace 表面/验证用例。
- **`docs/USAGE.md` §21 (NEW section)** — 四个 list cache 的 `invalidate*`
  公开 API 用法（何时手动调用、跨进程并发写入注意事项）。
- **`README.md` — Key internals** — 新增 4 行 list cache + Tier A 适配
  指引；docs 索引补上 `tier-a-summary.md`。
- **`examples/32-tier-a-performance.ts` (NEW)** — 一个 offline-runnable
  示例同时跑通 #1 / #2 / #3 / #8（无需 API key），已纳入
  `npm run test:examples:offline`。
- **`.gitignore`** — 新增 `.clavue/{retro,coordination,goals,runs}/`，
  避免临时 retro/coordination 状态污染 working tree。

### Tests / build / bench

- `npm run test`: **698 / 698** passing。增量轨迹 645 → 652 (+#3) →
  665 (+#2) → 673 (+#8) → 679 (+#7) → 686 (+agent-jobs) → 692 (+session)
  → 698 (+issue-workflow)。
- `npm run build` clean (`tsc --strict`)。
- `npm run bench:engine`: `src/engine.ts` 1537 → **1041** lines (-32.3%)。
- `npm run bench:worker`: spawn p50 = 60.2 ms; abort-resolve p95 = 0.2 ms;
  pre-flight abort p95 = 0.0 ms。

### Compatibility

- 无 `*_SCHEMA_VERSION` 改动。
- 所有新公开 API 都是 **additive**（新字段、新导出、新方法）。
- Tier A #2 / #3 / #8 必须 opt-in 才会改变默认 trace；其余四项 trace 表面
  与 1.0.2 一致（要么不写新字段，要么字段在无活动时省略）。

---

## [1.0.2] — 2026-05-09

Documentation-only patch. No source changes; same 625/625 tests, same
`tsc --noEmit` clean, same dist contents apart from the bumped version
string. Published so the npm registry page reflects the 1.0.x scope
correctly (description + keywords only travel through `npm publish`).

### Documentation

- **README.md rewritten head-to-toe**: replaces the 0.7.x-era "What is
  new in 0.7.x" + "v3 capabilities (0.8.x)" sections with a single
  "What's in 1.0.1" block that lists hard numbers reproducible via
  `npm run bench` (engine 1537→965 lines, 272→625 tests, token estimator
  density spread 0.000→0.373, worker_thread spawn p50 56ms). The v3
  axis table now points to `examples/19` through `31` and to
  `docs/USAGE.md` for per-axis instructions.
- **`docs/USAGE.md` (NEW, 946 lines)**: feature-by-feature usage guide
  covering all 20 capabilities — three Agent entrypoints, streaming,
  `outputSchema`, prompt caching verification, toolsets, autonomy/
  permission axes, hooks vs middleware, `worker_thread` subagent
  isolation, the seven v3 axes (graph DSL, guardrails, tracing,
  sandbox, RAG, generative UI, voice), `runIssueWorkflowWithAgent`,
  background AgentJobs, quality gates / proof-of-work, structured
  memory + vector retrieval, and schema-version contracts. Each
  section answers four questions: 是什么 / 何时用 / 怎么用 / 要小心
  什么.
- **`package.json` description + keywords**: rewritten to surface the
  v3 axes (graph, tracing, guardrails, sandbox, RAG, generative UI,
  voice) plus 1.0.x-era capabilities (streaming, prompt-caching,
  structured-outputs, worker-threads). The 0.7.x description that
  only mentioned "controlled autonomous workflows, workflow contracts,
  proof-of-work artifacts, durable AgentJobs, memory, and orchestration
  policy" is gone. Added 17 new keyword tags (claude, streaming,
  prompt-caching, structured-outputs, multi-agent, agent-graph,
  guardrails, tracing, opentelemetry, rag, retriever, pgvector,
  sandbox, capability-tokens, generative-ui, voice, worker-threads,
  esm).

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
