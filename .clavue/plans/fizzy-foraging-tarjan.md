# Coordinated Development Plan: Production-Grade Clavue Agent SDK

## Context

The current `clavue-agent-sdk` is already a strong in-process agent runtime: it has `run()`, `query()`, `createAgent()`, provider abstraction, tools/toolsets, MCP, hooks, sessions, memory, skills, subagents, durable `AgentJob`s, traces, evidence, quality gates, and retro/eval primitives.

The next product stage is not about adding many unrelated features. The core need is to turn existing primitives into enforceable, observable, safe, durable production contracts so application developers can embed Clavue as an agent operating layer, not just an LLM wrapper.

Target outcome: a production-grade TypeScript agent SDK where safety modes are enforced by runtime policy, workflow skills produce structured evidence, verification gates can affect terminal success, memory/jobs are auditable and recoverable, and performance/health are measurable.

## Executive Progress Audit — 2026-04-28

Current status: treat the working tree as a release-candidate batch, not as open-ended exploration.

Verified gates:
- `npm run build` passes.
- `npm test` passes: 151/151.
- `npx tsx --test tests/permissions.test.ts tests/memory-integration.test.ts tests/doctor.test.ts tests/package-payload.test.ts` passes: 56/56.

Completed or materially implemented in the current batch:
- Skill/tool prompt surfacing in the default system prompt.
- Inline skill activation with active prompt, model override, and allowed-tool constraints.
- Forked skills routed through durable background AgentJobs with trace/evidence/gates preserved.
- Lifecycle workflow skills: define, plan, build, verify, workflow-review, ship, repair.
- Skill manifest metadata: version, preconditions, artifacts, quality gates, permissions, compatibility, output schema.
- Tool safety annotations and built-in permission-mode semantics.
- Plan mode edit freeze and host `canUseTool` composition that cannot override built-in denials.
- Evidence and quality gates propagated into events and `AgentRunResult`.
- `qualityGatePolicy` terminal failure behavior.
- Memory policy modes: off, autoInject, brainFirst.
- Brain-first memory trace before the first provider call.
- Exported `doctor()` API with provider/tools/skills/MCP/storage/package checks.
- Exported `runBenchmarks()` API with offline metrics.
- Package payload and npm-style CLI symlink regression coverage.

Audit fix applied:
- `src/benchmark.ts` initialized benchmark metric metadata so TypeScript build and package tests pass.

Not done yet:
- README and examples do not yet explain the new public APIs.
- Event schemas are not explicitly versioned.
- Skill preconditions and required evidence are metadata unless a caller wires enforcement.
- Memory trace does not yet include score/source/scope/confidence/validation details.
- Background AgentJobs are durable and stale-detecting, but not replayable after process death.
- `doctor()` does not yet report stale-job recovery actions or live MCP connection health.

## Clavue Directive

Immediate objective: execute the next code-side SDK slice while Codex owns README/docs.

Ownership split:
- Codex owns README/docs public API guidance, examples, roadmap wording, and final docs verification.
- Clavue owns the next code-side, test-backed provider/model capability slice.
- Clavue should not edit `README.md`, `docs/*`, or Clavue/Codex planning docs unless explicitly asked.
- Codex is not editing `src/providers/*` or `tests/openai-provider.test.ts` right now.

Controlling upgrade program:
- `docs/agent-sdk-capability-upgrade-program.md`.
- Product target: not just coding automation. The SDK must support collection, organization, planning, problem solving, verification, review, shipping, memory intelligence, skill creation, and self-learning.
- Do not skip foundational runtime work. Reusable agents and workflow templates come after provider capability, runtime profiles, context packing, memory trace, and skill enforcement.

Approved Clavue slice: model capability registry and provider fallback/error policy.

Allowed write scope:
- `src/providers/types.ts`
- `src/providers/index.ts`
- `src/providers/openai.ts`
- `src/providers/anthropic.ts`
- `src/types.ts`
- `src/index.ts`
- `tests/openai-provider.test.ts`
- A new focused provider/model capability test file if cleaner.

Required product outcome:
- Hosts can ask the SDK what a model supports before running an agent.
- OpenAI-compatible GPT models, Anthropic models, and common gateway-prefixed model IDs map to deterministic capability metadata.
- Fallback or unsupported-capability decisions are explicit and tested; do not hide them in prompt text.
- Provider error categories are normalized where feasible without breaking existing thrown error metadata.

Required API shape guidance:
- Prefer a small exported API such as `getModelCapabilities(model, options?)`.
- Keep model capability data conservative. Unknown models should return safe defaults, not optimistic claims.
- Include fields only if tests prove useful behavior: tool calling, context window, reasoning/thinking support, image input/output, JSON/schema support, streaming, and cost metadata.
- Keep existing provider behavior compatible. Do not change transport selection unless a failing test requires it.

Acceptance gates:
- `npx tsx --test tests/openai-provider.test.ts`
- Any new provider/model capability focused test.
- `npm run build`
- `npm test`

Stop conditions:
- If any gate fails, stop feature expansion and fix the gate first.
- If public API shape becomes unclear, add a minimal failing test and leave docs handoff for Codex.
- Do not start AgentJob replay, plugin lifecycle, or broad orchestration work in this slice.

Next slices after provider/model capability:
1. Reusable runtime profiles and startup/context-build benchmarks.
2. `ContextPack` / `ContextPipeline` with budgeted sections and trace.
3. Richer memory retrieval trace, score reasons, validation state, and stronger `brainFirst`.
4. Exported skill validation plus optional skill gate/precondition enforcement.
5. Skill authoring/scaffolding APIs and bundled authoring skills.
6. Skill-aware self-improvement and skill retro evaluators.
7. Reusable problem-solving agents and typed workflow templates.

## North Star

Position Clavue Agent SDK as an embeddable AI worker runtime for Node.js applications:

- One call for simple use cases.
- Progressive adoption of tools, skills, memory, MCP, sessions, jobs, and gates.
- Every autonomous action is bounded, auditable, recoverable, and measurable.
- Host applications can stream, inspect, resume, benchmark, and enforce agent behavior without rebuilding runtime policy themselves.

## P0 Roadmap: Enforced Safety and Workflow Contracts

### Slice P0.1 — Skill/tool prompt surfacing

Goal: make the model consistently aware of available skills and tool operating rules without relying on ad hoc discovery.

Likely files:
- `src/engine.ts`
- `src/skills/index.ts`
- `src/tools/index.ts`
- `src/types.ts`
- relevant tests under `tests/`

Reuse:
- Existing default system prompt construction in `src/engine.ts`.
- Existing skill prompt formatting such as `formatSkillsForPrompt()` from `src/skills/index.ts`.
- Existing tool registry and tool `prompt()` fragments in `src/tools/index.ts` and individual tool files.

Implementation shape:
- Add bounded collection of tool prompt fragments when building the system prompt.
- Use one canonical skill-list formatter for all bundled/custom skill surfacing.
- Ensure disabled tools/skills are omitted.
- Add stub-provider tests that inspect generated system text.

Acceptance gates:
- Focused prompt/system tests.
- `npm test`.
- `npm run build`.

### Slice P0.2 — Skill activation as executable contract

Goal: ensure skills are not only prompt snippets; activation must constrain tools/model/context and produce traceable metadata.

Likely files:
- `src/tools/skill-tool.ts`
- `src/engine.ts`
- `src/skills/index.ts`
- `src/agent.ts`
- `src/types.ts`
- tests for skill activation and provider stubs

Reuse:
- Existing `Skill` tool implementation.
- Existing inline/forked skill activation behavior.
- Existing subagent/background job runner for forked skills.
- Existing trace, evidence, quality gate, and model usage fields.

Implementation shape:
- Formalize typed skill activation result metadata.
- Ensure inline activation temporarily applies skill prompt, allowed tools, model override, and context rules.
- Ensure forked activation routes through durable `AgentJob` with trace/evidence/gates preserved.
- Add tests proving `allowedTools`, `model`, and context constraints are honored.

Acceptance gates:
- Skill tool activation tests.
- Stub-provider tests for model/tool constraints.
- `npm test`.
- `npm run build`.

### Slice P0.3 — Lifecycle workflow skills and proof gates

Goal: encode the product workflow as reusable executable skills: analyze/plan/build/verify/review/ship/repair.

Likely files:
- `src/skills/index.ts`
- `src/types.ts`
- `src/engine.ts`
- `src/index.ts`
- examples such as `examples/12-skills.ts`
- tests for bundled skill registry and metadata

Reuse:
- Existing bundled skill registry.
- Existing evidence and quality gate result fields.
- Existing retro/eval verification concepts from `src/retro/`.

Implementation shape:
- Add lifecycle skill manifests with process steps, anti-rationalization guidance, allowed tools, required evidence, and expected output shape.
- Introduce a small `VerificationGate` / `SkillChecklist` metadata type if existing quality-gate types are insufficient.
- Expose workflow proof metadata through `AgentRunResult` without breaking current consumers.

Acceptance gates:
- Tests for lifecycle skill registration and prompt content.
- Stub workflow test proving required evidence metadata appears.
- `npm test`.
- `npm run build`.

### Slice P0.4 — Built-in permission mode semantics

Goal: move common safety behavior from prompts/host callbacks into SDK-enforced policy.

Likely files:
- `src/types.ts`
- `src/tools/index.ts`
- `src/engine.ts`
- `src/agent.ts`
- `src/tools/bash.ts`, file-edit tools, web/MCP tools as needed
- `tests/permissions.test.ts`
- `tests/runtime-isolation.test.ts`

Reuse:
- Existing `canUseTool`, allow/deny filters, permission denials, sandbox settings, toolsets, and subagent policy inheritance.

Implementation shape:
- Add semantic tool annotations: read, write, shell, network, external state, destructive, concurrency-safe, approval-required.
- Enforce default semantics for read-only, plan/freeze, accept-edits, and trusted automation.
- In plan mode, deny mutating tools except plan-exit/user-question-style workflow tools.
- Ensure skills, subagents, background jobs, and MCP tools inherit policy decisions.

Acceptance gates:
- Focused permission-mode tests.
- Subagent inheritance tests.
- Denial trace tests.
- `npm test`.
- `npm run build`.

## P1 Roadmap: Operability, Memory, and Measurement

### Slice P1.1 — Brain-first memory policy and trace

Goal: make memory retrieval auditable and optionally mandatory before the first provider call.

Likely files:
- `src/memory.ts`
- `src/memory-policy.ts`
- `src/engine.ts`
- `src/types.ts`
- `src/index.ts`
- `tests/memory.test.ts`
- `tests/memory-integration.test.ts`

Reuse:
- Existing structured memory store/query.
- Existing optional memory injection.
- Existing trace/evidence metadata.

Implementation shape:
- Add `memoryPolicy`: `off`, `autoInject`, `brainFirst`.
- In `brainFirst`, perform retrieval before first provider call and record trace metadata: query, selected memories, score, source, validation state, injection status.
- Extend memory evidence/provenance fields cautiously.
- Add deterministic retrieval benchmark fixture.

Acceptance gates:
- Test proving retrieval precedes the first provider call.
- Test proving memory trace appears in run result.
- Retrieval fixture with expected top result.
- `npm test`.
- `npm run build`.

### Slice P1.2 — Production health checks / `doctor()` API

Goal: give hosts a structured way to validate runtime readiness.

Likely files:
- new or existing health module under `src/`
- `src/index.ts`
- `src/cli.ts` later, after API stabilizes
- `tests/package-payload.test.ts`
- new focused doctor tests

Reuse:
- Existing provider config resolution in `src/agent.ts`.
- Existing MCP config/client paths under `src/mcp/`.
- Existing session/memory/job storage helpers.
- Existing skill registry.

Implementation shape:
- Export `doctor()` returning structured checks for provider env, toolsets, skills, MCP config, session dir, memory dir, job storage, and package entrypoints.
- Keep CLI command optional until API shape is stable.

Acceptance gates:
- Unit tests for passing and failing checks.
- Package payload/export tests if public API changes.
- `npm test`.
- `npm run build`.

### Slice P1.3 — Benchmark harness

Goal: measure performance before claiming speed or scalability improvements.

Likely files:
- `tests/` or `examples/` benchmark script
- `package.json` only if adding an explicit script is approved during implementation
- trace-related code only if missing metrics block measurement

Reuse:
- Existing traces, usage/cost, compaction events, read-only concurrency, subagents, memory query.

Implementation shape:
- Add offline benchmark script that emits JSON.
- Measure read-only tool fan-out, serial mutation ordering, context build/compaction, memory query latency, and subagent startup overhead.
- Keep budgets advisory initially.

Acceptance gates:
- Benchmark script runs without network/API calls.
- JSON output is machine-readable for CI comparison.
- `npm test`.
- `npm run build`.

### Slice P1.4 — Model capability and fallback policy

Goal: make provider/model routing explicit instead of implicit.

Likely files:
- `src/providers/index.ts`
- `src/providers/openai.ts`
- `src/providers/anthropic.ts`
- `src/types.ts`
- provider tests such as `tests/openai-provider.test.ts`

Reuse:
- Existing provider abstraction, retry/backoff, usage/cost tracking, OpenAI-compatible transport behavior.

Implementation shape:
- Add model capability metadata for tool support, context window, reasoning, image, streaming, JSON/schema, and cost.
- Add explicit fallback policy semantics for unsupported capability, rate limit, timeout, or provider errors.
- Normalize errors into stable categories where feasible.

Acceptance gates:
- Provider conformance tests with stubs.
- OpenAI-compatible provider tests.
- `npm test`.
- `npm run build`.

## P2 Roadmap: Robust Long-Running Autonomy

### Slice P2.1 — AgentJob resume/replay semantics

Goal: improve durable background jobs from stale detection to safe restart recovery.

Likely files:
- `src/agent-jobs.ts`
- `src/tools/agent-tool.ts` or equivalent subagent tool implementation
- `src/agent.ts`
- `src/session.ts`
- runtime isolation and job tests

Reuse:
- Existing `AgentJob` records, heartbeat, stale detection, cancellation, trace/evidence/gate persistence, runtime namespace isolation.

Implementation shape:
- Persist enough input/provider/tool context for safe queued-job resume or explicit stale replay.
- Add timeout policy per job.
- Add operational inspection for stale jobs through API and later `doctor()`/CLI.

Acceptance gates:
- Tests for queued resume or explicit stale recovery.
- Namespace isolation tests for concurrent jobs.
- `npm test`.
- `npm run build`.

### Slice P2.2 — Multi-agent coordination contracts

Goal: make collaboration among subagents explicit, inspectable, and conflict-aware.

Likely files:
- `src/agent.ts`
- subagent/team modules under `src/`
- `src/tools/agent-tool.ts` or equivalent
- `src/types.ts`
- tests for parent-child traces and policy inheritance

Reuse:
- Existing subagents, teams, background jobs, task tools, messages, policy inheritance, trace/evidence aggregation.

Implementation shape:
- Add dependency metadata for delegated work.
- Add parent-child trace linking and budget/recursion guards.
- Add write-scope guidance/conflict detection for concurrent agents.

Acceptance gates:
- Tests for policy/budget inheritance.
- Tests for trace linking.
- Conflict-detection fixture if edits are involved.
- `npm test`.
- `npm run build`.

### Slice P2.3 — Retention, cleanup, and replay fixtures

Goal: make persisted artifacts manageable in long-lived deployments.

Likely files:
- `src/session.ts`
- `src/memory.ts`
- `src/agent-jobs.ts`
- trace/replay modules if present
- tests for cleanup policies

Reuse:
- Existing local filesystem storage for sessions, memory, jobs, traces, and retro ledgers.

Implementation shape:
- Add cleanup/retention policies for sessions, jobs, memory, and traces.
- Add replayable run fixtures for difficult failures.
- Keep destructive cleanup opt-in and explicit.

Acceptance gates:
- Unit tests for retention policy decisions.
- Replay fixture test.
- `npm test`.
- `npm run build`.

## Clavue and Codex Collaboration Split

General rule: one agent owns implementation for each slice; the other reviews, tests, and challenges assumptions. Avoid concurrent edits in the same files unless explicitly coordinated.

### Clavue ownership

Clavue should own runtime-enforcement and integration-heavy slices:

- P0.1 skill/tool prompt surfacing.
- P0.2 skill activation enforcement.
- P0.4 permission mode semantics.
- P1.1 brain-first memory policy.
- P2.1 AgentJob resume/replay semantics.

Why: these slices touch core runtime behavior, tool execution, plan/read-only safety, memory injection, and durable job state where Clavue can maintain coherent end-to-end invariants.

### Codex ownership

Codex should own product-operability and independent validation slices:

- P0.3 lifecycle workflow skill manifests and proof-gate wording.
- P1.2 `doctor()` health checks.
- P1.3 benchmark harness.
- P1.4 model capability/fallback tests and provider conformance pass.
- P2.2/P2.3 coordination, retention, and replay design reviews.

Why: these slices benefit from independent product/SDK perspective, deterministic tests, schema review, and external challenge against overfitting runtime internals.

### Review protocol

For every slice:

1. Implementer writes focused tests first or alongside implementation.
2. Reviewer checks public API shape, safety regressions, and missing edge cases.
3. Shared findings become tests or roadmap TODOs, not chat-only notes.
4. If both agents edit, split by disjoint scopes, for example:
   - Clavue: `src/engine.ts`, `src/tools/*`, core policy.
   - Codex: tests, examples, docs, benchmark/doctor harness.
5. No slice is considered done until build and relevant tests pass.

## Concrete Implementation Order

1. P0.1 — skill/tool prompt surfacing.
2. P0.2 — skill activation executable contract.
3. P0.3 — lifecycle workflow skills and proof metadata.
4. P0.4 — built-in permission mode semantics.
5. P1.1 — brain-first memory policy and trace.
6. P1.2 — `doctor()` API.
7. P1.3 — benchmark harness.
8. P1.4 — model capability/fallback policy.
9. P2.1 — AgentJob resume/replay.
10. P2.2 — multi-agent coordination contracts.
11. P2.3 — retention, cleanup, and replay fixtures.

## Verification Strategy

Per slice:

- Run the smallest focused test first, for example:
  - `npx tsx --test tests/permissions.test.ts`
  - `npx tsx --test tests/memory.test.ts`
  - `npx tsx --test tests/openai-provider.test.ts`
  - `npx tsx --test tests/package-payload.test.ts`
- Then run `npm test`.
- Then run `npm run build`.

For public API/export changes:

- Check `src/index.ts` exports.
- Run `npx tsx --test tests/package-payload.test.ts`.
- Run `npm pack --dry-run --json` if package payload changed.

For examples/user-facing behavior:

- Update the relevant numbered example only when the exported behavior changes.
- Prefer deterministic stub-provider tests over live provider calls.

For performance claims:

- Do not claim speed improvements until the benchmark script emits comparable JSON.

## Immediate First Slice After Approval

Start with P0.1 because it is low-risk and unlocks better routing for later workflow skills:

1. Inspect current system prompt construction in `src/engine.ts`.
2. Inspect skill registry/formatter in `src/skills/index.ts`.
3. Inspect tool registry and prompt fragments in `src/tools/index.ts` plus relevant tool implementations.
4. Add tests using a stub provider to assert:
   - enabled skills appear in system prompt;
   - disabled skills/tools are omitted;
   - bounded tool prompt fragments are included;
   - prompt size remains controlled.
5. Implement the minimal runtime changes needed to pass tests.
6. Run focused tests, `npm test`, and `npm run build`.
