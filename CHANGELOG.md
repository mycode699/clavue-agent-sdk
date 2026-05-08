# Changelog

All notable changes to `clavue-agent-sdk` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Schema-versioned public surfaces (SDK events, run results, traces, AgentJob
records, memory traces, controlled execution contract, proof-of-work) are noted
explicitly when they bump.

---

## [Unreleased] — path to 1.0.0

The 1.0.0 work-up is tracked in:

- [docs/v2_audit_report.md](./docs/v2_audit_report.md) — 17-issue audit of 0.7.5
- [docs/v2_architecture.md](./docs/v2_architecture.md) — turn-pipeline target design
- [docs/v2_roadmap.md](./docs/v2_roadmap.md) — milestones M0..M7 → 1.0.0

### Planned (not yet started)

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
