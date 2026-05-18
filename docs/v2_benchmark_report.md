# Clavue Agent SDK — v2 Benchmark Report

> **Run date**: 2026-05-08
> **Hardware**: Darwin 24.6.0 (Apple Silicon class), Node.js v22.22.0
> **Source**: every number below is reproduced by `npm run bench` and lives
> in `scripts/bench/`. No hand-edited values.

This report quantifies the v2 (0.7.5 → 0.9.x) work. Every audit P0/P1 item
that promised a measurable improvement is paired with a real measurement
here. Where a benchmark could not be run offline (e.g. `messages.countTokens`
behind a proxy that returns 404), the section says so.

---

## 1. Engine refactor (audit P1-1: god-class)

```
Audit baseline (0.7.5, commit 2567223): src/engine.ts = 1537 lines
Pre-K     (Slices A-J landed):           src/engine.ts = 1162 lines  (-24%)
Post-K    (Slices K1-K5 landed):         src/engine.ts =  965 lines  (-37%)
```

**Helper modules**: 0 → 15 (`src/engine/*.ts`, 1644 lines total).

The remaining ~465 lines of `submitMessage` (vs the v2 architecture goal of
<500) are the generator yield chain plus top-level run orchestration. Those
require a true pipeline (Guard → Compact → Render → Call → Stream → Tools →
Decide), not local extraction. That's M2 phase 2; explicitly out of scope
for 1.0.0.

| Metric | Audit baseline | After Slice A-J | After Slice K1-K5 |
|---|---:|---:|---:|
| `engine.ts` LoC | 1537 | 1162 | **965** |
| Helper modules | 0 | 7 | **15** |
| Helper LoC | 0 | 797 | **1644** |
| Test count | 272 | ~520 | **625** |

Reproduce: `npm run bench:engine`.

---

## 2. Token estimator accuracy (audit P0-3: 4-chars/token)

The legacy estimator (`Math.ceil(text.length / 4)`) produced a constant
density of 0.25 tokens/char regardless of content. Real tokenizers cluster
around ~0.25 for English prose but diverge sharply on code, JSON, and CJK.

### Offline comparison

```
| Content | chars | legacy tokens | legacy density | v2 tokens | v2 density |
|---------|------:|--------------:|---------------:|----------:|-----------:|
| english |   174 |            44 |          0.253 |        44 |      0.253 |
| code    |   129 |            33 |          0.256 |        43 |      0.333 |
| json    |   216 |            54 |          0.250 |        84 |      0.389 |
| cjk     |    99 |            25 |          0.253 |        62 |      0.626 |
```

**v2 density spread = 0.373** across 4 content classes (legacy = 0.000;
its density was a constant). Higher spread = better content separation,
which is the prerequisite for using these estimates as a compaction
trigger.

### Online comparison (vs Anthropic `messages.countTokens`)

Skipped on this run — the proxy in our test environment returns 404 on
`/v1/messages/count_tokens` ("Invalid URL"). Re-run with a direct
Anthropic endpoint via `ANTHROPIC_API_KEY` + unset `ANTHROPIC_BASE_URL`
to populate this section.

**This is by design**: the bench has both an offline and online path so
CI can validate the estimator at all, even when the test environment
doesn't have a working `countTokens` route.

Reproduce: `npm run bench:tokens` (or `ANTHROPIC_API_KEY=... npm run bench:tokens`).

---

## 3. worker_thread subagent runtime latency (audit P1-6 phase 2)

Phase 1 was a `NotImplementedError` stub. Phase 2 is a real
`worker_threads.Worker`-backed runtime. Numbers below are p50/p95 over 30
iterations on a development laptop, measured against tiny stub workers
(no LLM calls — pure spawn/teardown overhead):

```
| Measurement         |   p50 |   p95 |   min |   max |
|---------------------|------:|------:|------:|------:|
| spawnLatency        |  55.6 |  58.1 |  47.9 |  59.3 |  ms
| abortResolveLatency |   0.1 |   0.2 |   0.1 |   0.2 |  ms (parent unblock)
| preflightAbort      |   0.0 |   0.0 |   0.0 |   0.0 |  ms (short-circuit)
```

**spawnLatency** is the floor cost of choosing `runtime: 'worker_thread'`
over `'inprocess'`. ~56ms p50 is the price you pay for a fresh V8 isolate
plus tsx loader propagation. Inprocess subagents skip this cost entirely.

**abortResolveLatency** measures parent-side promise rejection time, NOT
worker-side termination. The parent `settleReject` fires before
`worker.terminate()` resolves, so this metric reflects "how long does my
code wait?" — not "how long until the V8 isolate is gone". The latter is
asynchronous and not measured here.

**preflightAbort** is sub-millisecond because we short-circuit before
spawning any worker when the parent signal is already aborted. This is a
correctness property as much as a performance one — without it, an
already-cancelled parent run would still pay 56ms of worker startup cost.

Reproduce: `npm run bench:worker`.

---

## 4. Test suite size and wall-time

```
Tests passing: 625
Tests failing:   0
Wall-time (single run, no parallelism): 34.7s
```

Test count progression:

| Stage | Tests |
|---|---:|
| Audit baseline (0.7.5) | 272 |
| After Slice K1-K5 | 605 |
| After Worker phase 2 | **625** |

Reproduce: `npm run test`.

---

## 5. What was NOT measured here

Honesty matters more than coverage:

- **End-to-end LLM cost** (audit P0-5: prompt caching). Anthropic's
  `cache_control: ephemeral` is wired in `src/providers/anthropic.ts:84-118`
  and verified by tests, but real cache hit rate / cost reduction depends
  on conversation shape and is not reproducible offline. Hosts can verify
  by inspecting `usage.cache_creation_input_tokens` and
  `usage.cache_read_input_tokens` on `AgentRunResult`.

- **Streaming first-token latency** (audit P0-4). Wired in
  `src/providers/anthropic.ts:213` via `client.messages.stream(...)` and
  verified by `tests/streaming.test.ts`. Real TTFT depends on the LLM
  endpoint and network and is not reproducible offline.

- **outputSchema structured output round-trip** (audit P0-2). Verified
  by provider unit tests; live model behavior is provider-specific.

- **Anthropic countTokens error rate** as ground truth for the token
  estimator. Skipped on this run because the test environment proxy
  returns 404; will be populated when the bench is run against a direct
  Anthropic endpoint.

- **Engine pipeline-style throughput** (M2 phase 2). Out of scope for
  1.0.0; current engine is generator-style.

---

## 6. How to run all benchmarks

```bash
npm run bench              # all three benches sequentially
npm run bench:tokens       # token estimator accuracy
npm run bench:worker       # worker_thread spawn/abort latency
npm run bench:engine       # engine LoC + test suite size
```

All bench scripts live under `scripts/bench/` and are pure TypeScript with
no external dependencies beyond the SDK's own dev deps.

---

## 7. SLOs for 1.0.0 regression detection

Treat these as guard-rails for future PRs. The first four rows
(`engine.ts` LoC, test count, test wall-time, retro overall) are
**enforced** — `npm run bench:engine` exits non-zero on breach. The rest
are advisory: `bench:tokens` / `bench:worker` print metrics for human
inspection but do not gate.

| Metric | Threshold | Source | Enforced |
|---|---|---|---|
| `engine.ts` LoC | < 500 | `npm run bench:engine` | ✅ |
| Test count | ≥ 720 | `npm run bench:engine` | ✅ |
| Test wall-time | < 60s | `npm run bench:engine` | ✅ |
| Retro overall | ≥ 70 | `npm run bench:engine` | ✅ |
| Token v2 density spread | > 0.30 | `npm run bench:tokens` | ❌ advisory |
| spawnLatency p95 | < 200ms | `npm run bench:worker` | ❌ advisory |
| preflightAbort p95 | < 5ms | `npm run bench:worker` | ❌ advisory |
| abortResolveLatency p95 | < 5ms | `npm run bench:worker` | ❌ advisory |

> Tightened in v2.0 (M2 phase 2 — top-level loop extraction): engine.ts
> LoC ceiling moved from 1100 → 1000 → 500 (current 350, -77.2% vs the
> 1537-line audit baseline). Test floor 625 → 720 (current 797 incl. M3
> sandbox + tool-policy regression tests).
>
> M3.3 added the **retro overall** SLO: `bench:engine` runs the default
> retro evaluators against the live repo and gates on
> `scores.overall.score ≥ 70`. Set `BENCH_ENGINE_SKIP_RETRO=1` to opt
> out (offline / detached worktrees).
