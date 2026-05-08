---
title: clavue-agent-sdk v3 RFC — semantic decisions before GA
date: 2026-05-08
status: draft
baseline:
  tests: 472/472
  build: tsc 0 error
  examples_offline: 12 (examples/19~30)
prior_art:
  - docs/v2_v3_v4_upgrade_chain.md
  - src/graph/runtime.ts
  - src/guardrails/runtime.ts
  - src/tracing/exporter.ts
  - src/rag/runtime.ts
---

# clavue-agent-sdk v3 RFC

## Why this exists

7/7 v3 axis prototypes have landed as side modules with **zero touch** to the
engine hot path. Two integrations (graph↔trace, graph↔guardrail-output) are
in. One exporter (OTel-shape) is in. **Before GA**, four semantic decisions
need to be locked or every remaining integration will rediscover the same
questions with worse context.

This document is the lock. Each decision: background → options → pick →
acceptance criteria. No code changes here — code lands once we agree.

## Out of scope

- Provider adapter choice (Whisper-local vs Deepgram vs both): tracked
  separately, not load-bearing for GA shape.
- README rewrite: deferred until decisions land so the comparison matrix
  reflects the real GA surface.
- Engine pipeline split into more sub-helpers: only if a decision below
  forces it.

---

## D1 — Tool-scope guardrail enforcement point

### Background

`GuardrailRegistry.evaluate('tool_input', …)` and `evaluate('tool_output', …)`
exist (`src/guardrails/runtime.ts:58`) but **no caller hits them yet**. The
graph runtime only evaluates `output` (`src/graph/runtime.ts:~270`); it
deliberately punts on tool scopes because graph nodes never see raw tool
calls. The two extra scopes are the v3.4 代差 vs `openai-agents` (which
only has `input` / `output`); shipping GA without wiring them would erase
that gap.

The hot path is `Engine.runTool()` in `src/engine.ts:~110+`. Tool dispatch
already has policy decisions, safety classification, retries, concurrency
gating. Adding a fifth gate is the natural fit — *if* we accept touching
the hot path.

### Options

| | Where it fires | Pros | Cons |
|---|---|---|---|
| **A** | Graph-node wrapper (decorate `agent` nodes that own a tool dispatcher) | Stays additive, no engine touch | Only works inside graphs; engine-direct callers (`agent.prompt()`) still bypass |
| **B** | Engine tool dispatcher (`runTool` pre-call + post-call hook) | Universal coverage, single source of truth | Touches `src/engine.ts`; risk of regression in 1010 LOC file |
| **C** | Both — graph wrapper for graph runs, engine hook for direct runs | No coverage gap | Two code paths, double review surface, two test matrices |
| **D** | Tool-helper layer (`src/engine/tool-helpers.ts`) — wrap `summarizeToolInput` / result normalisation | Smallest engine diff; helpers are already isolated | Helpers are not the dispatcher; wrap site is one layer too low (no agentId / no abort point) |

### Recommendation: **B — engine dispatcher**

Tool calls happen exactly once per request, in one place. Wrap the existing
`runTool` with a guardrail pre-check + post-check. Reasons:

1. **Coverage is the whole point.** A user who registers `tool_input: redact_pii`
   and then calls `agent.prompt()` directly (no graph) expects redaction. Option
   A breaks that contract; option C fixes it by writing the same logic twice.
2. **The hot-path risk is real but bounded.** The integration mirrors the
   existing graph↔guardrail integration: `evaluate()` → optional `onViolation`
   hook → default abort. Diff size is comparable to the graph version (~30
   lines), and 427 tests gate regressions.
3. **Capability tokens (D2) live next to tool dispatch.** They share the same
   site, so doing both at once is one review, not two.

### Acceptance criteria

1. `Engine.runTool()` calls `guardrails.evaluate('tool_input', input, { toolName, agentId })`
   before invoking the tool; if `passed=false` and policy is `abort`, the tool
   call is rejected without firing.
2. After the tool returns, `guardrails.evaluate('tool_output', result, ctx)`
   runs; same abort semantics.
3. When `trace` is provided to the engine, both evaluations append `guardrail`
   events with `tool.name` set — same shape the OTel exporter already maps.
4. Engine API gains `onToolViolation` mirroring `onViolation` from `runGraph`
   (default `'abort'`, return `'continue'` to log-only, throw to abort).
5. New tests cover: input-blocking, output-blocking, async check, throwing
   check, `'continue'` policy, missing-toolName guard already enforced by
   registry. Existing tests unchanged.
6. Engine remains usable without guardrails (registry omitted → fast path,
   zero overhead).

---

## D2 — Capability-deny semantics

> **Status (2026-05-08)**: Implemented. `onToolViolation` callback wired
> through `AgentOptions` → `QueryEngineConfig` → engine; default policy
> remains `'skip'`. Action matrix exercised in
> `tests/engine-guardrails-policy.test.ts` (7 tests covering abort/skip/
> continue × request/response phases + throwing-callback). `'abort'`
> raises `GuardrailAbortError` past `executeSingleTool`'s inner catch and
> the engine top-level emits a terminal `error_guardrail_abort` result.

### Background

Capability tokens (planned alongside tool-scope guardrails) attach to a tool
call: "this dispatch is allowed to write to disk", "this dispatch may not
exfiltrate to network". When a guardrail or policy denies a capability, what
happens to the **agent's reasoning loop**?

`onViolation` for the graph runtime already chose:

- default `abort` → run terminates with `status: 'aborted'`
- `continue` → log only, run proceeds
- throw → also abort

Tool-scope deny is louder than output-scope deny. Output-scope means "what
the model said is bad" — abort is correct, retry is the LLM's job. Tool
scope means "the tool we were about to run is forbidden" — there are
*more* sensible reactions:

### Options

| | Behavior on deny | When this is right |
|---|---|---|
| **A** | Abort the run (mirror `onViolation`) | Safety-critical defaults; matches existing graph semantics |
| **B** | Skip the step — return synthetic `{ ok: false, denied: true, reason }` to the model so it can replan | The model has agency; let it try a different tool |
| **C** | Log only — let the call go through | Audit-only mode; never the right *default* |
| **D** | Caller-policy hook returning `'abort' \| 'skip' \| 'continue'` (extends `onToolViolation`) | All of the above, no commitment |

### Recommendation: **D, with default = `'skip'`**

Adopt option-D shape (matches `onViolation`'s callback contract) but the
**default is different** from `onViolation`:

- output-scope default = `abort` (model output is final, no recovery)
- tool-scope default = `skip` (model can replan; this is what an LLM agent
  does best)

Concretely, the policy hook signature:

```ts
onToolViolation?: (
  evaluation: GuardrailEvaluation,
  call: { toolName: string; phase: 'request' | 'response'; agentId?: string },
) => 'abort' | 'skip' | 'continue' | Promise<'abort' | 'skip' | 'continue'>
```

`'skip'` returns to the agent loop a denied result with the violation
message; the agent typically picks a different tool or stops. `'abort'`
remains available for high-stakes deployments. `'continue'` is for
audit-only logging mode (matches `onViolation`'s `'continue'`).

### Rationale

1. **Asymmetry matches reality.** Output deny = bad emission, no remediation.
   Tool deny = "use a different door"; the agent loop is *designed* for that.
2. **Skip is reversible at request time.** Abort is reversible only across
   restarts.
3. **Same callback shape as graph guardrails** = users learn it once.

### Acceptance criteria

1. `'skip'` injects a `ToolResult` with `is_error: true` and a structured
   `denial` field; the existing tool-result truncation / micro-compact path
   handles it without special-casing.
2. The denial is visible in `AgentRunToolTrace` so audit logs show *what*
   was denied and *why*.
3. `'abort'` raises through `runTool`'s normal error channel and bubbles
   to the engine top-level abort path (existing behavior for hard errors).
4. Default-`'skip'` is documented as an explicit choice; opting into
   `'abort'` is a single-line config.
5. Test matrix: input-deny + skip → next iteration sees denial; input-deny
   + abort → run terminates; output-deny + skip → tool result discarded;
   output-deny + abort → run terminates.

---

## D3 — `issue-workflow` → graph DSL migration

> **Status update (2026-05-08)**: Honesty pivot after inspecting `src/issue-workflow.ts`.
> The legacy `runIssueWorkflow` is already marked `@deprecated since v0.8`; the
> modern path is `runIssueWorkflowWithAgent`. The legacy loop is ~70 lines of
> linear control flow plus heavy FS persistence (`writeIssueWorkflowRun`,
> `runAgentJob`, `appendIssueWorkflowJob`). Re-expressing it on `runGraph`
> would either duplicate the FS state machine inside graph nodes (large
> surface, no win) or only swap control flow while keeping every persistence
> call (low value — the existing 4-state loop is already clearer than a
> graph definition + custom output adapter would be). **Decision: defer to
> v4.** No replacement code lands now. README claim about "issue-workflow
> real loop" stays valid because `runIssueWorkflowWithAgent` is the real
> path. See "After this RFC lands" for the new ordering.

### Background

`src/issue-workflow.ts` (586 lines) hard-codes a 4-role loop:
`builder → reviewer → fixer → verifier`. The graph DSL (`src/graph/runtime.ts`)
expresses the same shape *more generally* (router + verifier nodes, with
re-entry edges). Today they are two separate code paths solving overlapping
problems. The roadmap calls for one.

The constraint: `IssueWorkflowRunRecord` is a public schema with a
`schema_version` field. Persisted runs in user repos must keep loading.

### Options

| | Approach | Public surface | Migration cost |
|---|---|---|---|
| **A** | Fork — keep `issue-workflow.ts` for back-compat, build new `issue-workflow-graph.ts` next to it | Both work, users pick | Two implementations, drift risk |
| **B** | Replace — re-implement `runIssueWorkflow` *internally* using `runGraph`, keep public signature identical | Same exports, same record schema | One implementation, but big refactor |
| **C** | Opt-in flag — `runIssueWorkflow({ engine: 'graph' })` selects new path; default stays legacy until v4 | Same exports, additive | Both paths live in tree until removal |
| **D** | Pure removal — drop `issue-workflow.ts`, document graph DSL as the replacement, ship a recipe in `examples/` | Smallest tree | Breaks anyone running stored 4-role workflows |

### Recommendation: **B — replace internally, keep the public signature**

`runIssueWorkflow(input)` keeps its exact signature, return type, and record
schema. The implementation builds an `AgentGraph` matching the 4 roles, hands
it to `runGraph`, then maps `RunGraphResult` → `IssueWorkflowResult`.

Reasons:

1. **One implementation to test.** Fork (A) and flag (C) double the surface
   forever; users will pin to whichever has the bug they understand. Replace
   collapses both.
2. **Public schema unchanged.** `IssueWorkflowRunRecord.schema_version` does
   not bump; persisted runs stay loadable. The record is a *projection* of
   the graph run, not the graph itself.
3. **Carries the trace + guardrail integrations for free.** `runGraph` already
   wires those; the legacy code path doesn't.
4. **Pure removal (D)** is the right v4 move, not v3. v3 should not ship
   public-API breaks unless forced.

### Acceptance criteria

1. `IssueWorkflowResult` shape, `IssueWorkflowRunRecord.schema_version`, and
   the role list (`'builder' | 'reviewer' | 'fixer' | 'verifier'`) all
   unchanged.
2. The internal graph uses one `agent` node per role plus one `verifier`
   node and a `router` for the fix-loop exit.
3. Existing `issue-workflow.test.ts` (or equivalent) passes byte-identically
   on the public surface; an additional test asserts that the new path
   produces a `TraceStore` event stream when one is provided.
4. Net LoC change ≤ 0 (the graph version replaces, doesn't accumulate).
5. README + examples gain one note: "issue-workflow now runs on the graph
   runtime; custom multi-role flows can build their own graph the same way."

---

## D4 — Retriever wiring into the agent loop

### Background

`src/rag/` ships an in-memory retriever (`Retriever` interface). No agent
node currently uses it; users have to call `retrieve()` manually and stuff
the hits into a prompt. Peers (LlamaIndex, LangChain) bake retrieval into
the loop. v3.5 wants the same.

The question is *where* in the loop retrieval fires.

### Options

| | Wiring | Latency cost | Composability |
|---|---|---|---|
| **A** | New graph node kind: `kind: 'retriever'` with `retriever`, `query` builder, `topK` | One extra node per turn | High — graphs already compose |
| **B** | Agent pre-prompt injection — `agent` node grows optional `retriever` field; runtime prepends hits to the prompt | Zero new nodes; transparent | Lower — only graph agents get it; engine-direct callers don't |
| **C** | Tool-based — retriever exposed as a `retrieve()` tool the agent can call | Model decides when | Highest agency, highest cost (round-trip per call) |
| **D** | Hybrid: B (default) + C (advanced) — most graphs get free retrieval; agents that want fine-grained control register the tool | Same as B for default path | Best of both |

### Recommendation: **A — new `retriever` graph node kind**

Add a 6th node kind to the graph DSL:

```ts
| {
    kind: 'retriever'
    id: string
    retriever: Retriever
    /** How to build the query from context. Default: ctx.input. */
    query?: (ctx: GraphContext) => string
    topK?: number
  }
```

Output kind: `{ kind: 'retrieval'; hits: RetrievalHit[]; query: string }`.
Downstream `agent` nodes read upstream retrieval output and prepend it to
their prompt by default (same default-prompt mechanism that already passes
`ctx.input`).

### Why A over B/C/D

1. **A composes.** A retriever node is just another step. You can put a
   guardrail before it (`tool_input` scope on the retriever query — yes,
   the v3.4 gear works here too), a router after it ("if no hits, ask
   user"), or chain two retrievers (vector + keyword).
2. **B is the right *implementation* of A.** Once node kind `retriever`
   exists, `agent` node's "use the most recent retriever output by default"
   is one helper. We don't need both `retriever` field and `kind: 'retriever'`.
3. **C is still possible** — host wraps `retriever.retrieve` in a tool and
   registers it. We don't *block* C; we just don't make it the default
   because it costs an LLM round-trip per query.
4. **D is what users will end up doing in practice** — graph node for the
   default flow, tool for the cases where the model needs to query more
   than once mid-turn. Both routes are open with A; only A is open with
   B/C alone.

### Acceptance criteria

1. New `kind: 'retriever'` node in `src/graph/types.ts` with the shape above.
2. Runtime in `src/graph/runtime.ts` calls `retriever.retrieve({ text, topK })`
   in a try/catch; failure marks the step `failed`; `RetrievalHit[]` lands
   in `ctx.outputs[id]`.
3. `eventToOtelSpan` (in `src/tracing/exporter.ts`) gains a span name for
   the new `graph_step.kind`: `graph.step.retriever` with attribute
   `retrieval.hit_count`.
4. New example `examples/28-rag-graph.ts` runs offline using
   `InMemoryRetriever` + a simulated embedder; demonstrates retrieve →
   agent → verifier graph.
5. Tool-scope guardrails fire on the *retriever query* if registered with
   `toolName: '__retriever__'` (or a dedicated `retrieval_query` scope —
   this sub-decision can defer if the simpler path is enough).
6. Test count grows by ≥3: happy-path retrieve, empty result, retriever
   throws.

---

## After this RFC lands

Order of execution, highest leverage first:

1. **D1+D2 together** — engine tool dispatcher gets guardrail pre/post +
   capability hook. ~60 lines + tests. Closes the v3.4 代差 fully.
   *(Status 2026-05-08: shipped, 13 tests in
   `tests/engine-guardrails.test.ts` + `tests/engine-guardrails-policy.test.ts`)*
2. **D4** — `retriever` node kind. ~40 lines + types + 1 example. Closes
   v3.5 axis fully.
   *(Status 2026-05-08: shipped, 5 tests in `tests/graph-retriever.test.ts`,
   `examples/28-rag-graph.ts` offline-green)*
3. **D3** — internal replacement of `issue-workflow`. Net-zero LoC, big
   trust win. *(Deferred to v4 — see D3 status update.)*
4. **README rewrite** — comparison matrix updated with real evidence from
   1–3.
5. **Real provider adapters** (Whisper / Deepgram / ElevenLabs / pgvector /
   OTel SDK) — independent, unblocked.
   *(Status 2026-05-08: all five shipped. `PgvectorRetriever` in
   `src/rag/pgvector.ts` (10 tests). `OtelTraceExporter` in
   `src/tracing/otel-shim.ts` (5 tests + `examples/29-otel-shim.ts`).
   `DeepgramAsrProvider` + `WhisperOpenAiAsrProvider` +
   `ElevenLabsTtsProvider` in `src/voice/adapters.ts` (12 tests in
   `tests/voice-adapters.test.ts`) — zero new runtime deps, structural
   `FetchLike` lets hosts inject custom HTTP without dragging axios.
   Out of scope: Deepgram Live / OpenAI Realtime websockets, local
   `whisper.cpp` binary — tracked as follow-up.)*

Each step keeps the baseline green and adds tests on top (now 472/472).
None break the public surface as defined today.
