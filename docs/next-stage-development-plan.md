# Next-Stage Development Plan

Last updated: 2026-04-28

## Objective

Move `clavue-agent-sdk` from a feature-rich agent toolkit into a production-grade agent operating layer for TypeScript applications. The next stage should make agent behavior safer, more measurable, more durable, and more ergonomic while keeping the simple `run()`, `query()`, and `createAgent()` entrypoints intact.

This plan synthesizes:

- Clavue's production SDK analysis in `docs/production-agent-sdk-analysis.md`.
- Codex's production capability analysis in `docs/production-agent-sdk-capabilities.md`.
- The existing runtime roadmap in `docs/agent-runtime-roadmap.md`.
- The active optimization roadmap in `docs/superpowers/plans/2026-04-28-agent-runtime-optimization-roadmap.md`.
- The capability upgrade program in `docs/agent-sdk-capability-upgrade-program.md`.

## North Star

The product should feel like an embeddable AI worker runtime:

- Developers start with one call.
- Production hosts can add policy, memory, skills, tools, MCP, workflows, jobs, and telemetry without changing mental models.
- Every autonomous action is bounded, inspectable, recoverable, and backed by evidence.
- The SDK never relies on assistant prose alone to decide whether work succeeded.

## Current Strategic Upgrade

The next product step is broader than code automation. The SDK should become a work operating layer for:

- Collecting sources, files, MCP resources, and user inputs.
- Organizing raw material into notes, decisions, todos, and memory.
- Planning scoped work with assumptions, acceptance criteria, and gates.
- Solving ambiguous problems with hypotheses, evidence, and verification.
- Building, verifying, reviewing, and shipping implementation or content.
- Learning from repeated failures and successful patterns.
- Creating new skills and workflow templates safely.

Execution details are tracked in `docs/agent-sdk-capability-upgrade-program.md`.

## Product Experience Principles

- Simple path stays simple: `run()` should remain the fastest path for one-shot automation.
- Streaming path feels live: `query()` should provide enough events to power a UI, terminal, or dashboard.
- Advanced path is composable: `createAgent()` should be the stable host for sessions, memory, MCP, hooks, custom tools, subagents, and workflows.
- Safety is enforced by runtime policy, not just model instructions.
- Skills are executable workflows, not prompt snippets.
- Quality gates can determine terminal success.
- Memory is traceable, scoped, and never blindly trusted.
- Long-running work is durable and inspectable.
- Performance claims require benchmarks.

## Current Baseline

Already strong:

- In-process agent loop.
- Anthropic and OpenAI-compatible providers.
- Broad built-in tool registry and named toolsets.
- Tool ordering with read-only concurrency and serial mutation execution.
- Sessions, memory, skills, hooks, MCP, subagents, tasks, teams, scheduling, worktrees, and LSP tools.
- Durable background `AgentJob` records with heartbeat, stale detection, output, trace, evidence, and quality gates.
- Structured `AgentRunResult` with usage, cost, timings, trace, evidence, quality gates, and errors.
- Retro/eval pipeline for deterministic scoring, verification, comparison, and retry loops.

Verified progress snapshot, 2026-04-28:

- `npm test` passes: 151/151 tests.
- `npm run build` passes.
- Focused gate passes: `npx tsx --test tests/permissions.test.ts tests/memory-integration.test.ts tests/doctor.test.ts tests/package-payload.test.ts`.
- Current working tree now covers tool prompt surfacing, inline/forked skill activation constraints, lifecycle workflow skill metadata, built-in permission-mode enforcement, quality-gate terminal failure policy, brain-first memory trace, `doctor()`, package/CLI symlink regression coverage, and an offline `runBenchmarks()` harness.
- Stabilization fix applied during audit: initialized benchmark metric metadata in `src/benchmark.ts` so `tsc` and package tests pass.

Closed or mostly closed in the current working tree:

- Permission modes now have built-in semantics for `plan`, `default`, `acceptEdits`, high-trust modes, and host callback composition.
- Tool safety annotations are present across built-in tools.
- Workflow gates can affect terminal success when `qualityGatePolicy` is configured.
- Skills have typed workflow metadata and lifecycle skills are registered.
- Brain-first memory retrieval is traced before the first provider call.
- `doctor()` exists and has focused tests.
- A deterministic local benchmark API exists as `runBenchmarks()`.

Remaining maturity gaps:

- Public docs and examples do not yet explain the new policy, workflow, memory, doctor, and benchmark APIs.
- Public event schemas are useful but not explicitly versioned.
- Policy decision traces still need richer behavior/source/timestamp detail beyond denial summaries.
- Skill preconditions and required evidence are surfaced and validated, but not fully enforced as automatic workflow blockers.
- Memory trace lacks detailed scores, source, scope, confidence, and validation fields in the final trace.
- Background jobs are durable but not truly replayable or recoverable after process death.
- `doctor()` does not yet report stale-job recovery actions or live MCP connection health.
- Benchmark coverage is useful but still initial; provider conversion, compaction quality, and subagent startup overhead need deeper measurement.

## Phase Plan

### Phase 0: Stabilize Shared Planning And Baseline

Goal: avoid fragmented direction and protect current green behavior.

Deliverables:

- Keep `docs/production-agent-sdk-analysis.md`, `docs/production-agent-sdk-capabilities.md`, and this plan as planning artifacts.
- Treat `docs/next-stage-development-plan.md` as the execution coordination source.
- Confirm baseline before code work: `npm test`, `npm run build`, and package payload tests.
- Do not overwrite untracked `.clavue/` artifacts unless explicitly requested.

Acceptance gates:

- Baseline test result is recorded in final handoff for each implementation slice.
- No unrelated user or Clavue work is reverted.

### Phase 1: Safety And Policy Enforcement

Goal: make common safety modes enforceable by default.

Scope:

- Add semantic tool safety metadata: read, write, shell, network, external state, destructive, idempotent, concurrency safe, approval required.
- Implement built-in permission behavior for `plan`, `default`, `acceptEdits`, `trustedAutomation`, `dontAsk`, and `bypassPermissions`.
- Make `plan` mode deny mutating tools except explicit plan-exit and user-question tools.
- Ensure subagents, skills, background jobs, and MCP tools inherit parent policy unless explicitly narrowed.
- Add policy decision trace fields for behavior, reason, source, and timestamp.

Primary files:

- `src/types.ts`
- `src/tools/types.ts`
- `src/tools/index.ts`
- `src/engine.ts`
- `src/agent.ts`
- `src/tools/agent-tool.ts`
- `tests/permissions.test.ts`
- `tests/runtime-isolation.test.ts`

Acceptance gates:

- Read-only mode cannot write, edit, run shell mutation, or call unsafe MCP tools.
- Plan mode cannot mutate files or external state.
- Subagents inherit deny rules.
- Background jobs inherit deny rules.
- Existing allow/deny filters still work.
- `npm test`
- `npm run build`

### Phase 2: Workflow Gates And Lifecycle Skills

Goal: make high-quality agent work repeatable and evidence-gated.

Scope:

- Add lifecycle workflow skills: `define`, `plan`, `build`, `verify`, `review`, `ship`, and `repair`.
- Extend skill metadata with optional `version`, `preconditions`, `artifactsProduced`, `qualityGates`, `permissions`, `compatibility`, and `outputSchema`.
- Add required evidence/checklist metadata for workflow skills.
- Add run option that lets failed required quality gates mark the final run as failed.
- Keep existing bundled skills compatible.
- Add tests proving workflow skill prompts advertise required gates and artifacts.

Primary files:

- `src/skills/types.ts`
- `src/skills/registry.ts`
- `src/skills/bundled/`
- `src/tools/skill-tool.ts`
- `src/engine.ts`
- `src/types.ts`
- `tests/tools.test.ts`
- New focused skill/workflow test file if useful.

Acceptance gates:

- Existing skills still register and invoke.
- Invalid manifest metadata fails clearly.
- Lifecycle skills are discoverable.
- Required gates can be surfaced in `AgentRunResult`.
- Optional gate-failure terminal semantics are tested.
- `npm test`
- `npm run build`

### Phase 3: Observability, Event Contracts, And Doctor API

Goal: make production runs easy to inspect, debug, and validate before use.

Scope:

- Version public event schemas.
- Document event compatibility expectations.
- Add `doctor(options)` API for provider config, model selection, toolset names, MCP configs, skill registry, session store, memory store, job store, package entrypoints, and permission profile sanity.
- Include real MCP connection statuses in `system:init`.
- Add structured diagnostics for stale jobs and storage health.
- Add redacted log/trace helper as a shared internal utility.

Primary files:

- `src/types.ts`
- `src/index.ts`
- `src/agent.ts`
- `src/mcp/client.ts`
- New `src/doctor.ts`
- `tests/package-payload.test.ts`
- New `tests/doctor.test.ts`
- README after API stabilizes.

Acceptance gates:

- `doctor()` returns structured pass/warn/fail checks.
- Package exports include the new API.
- Package payload tests are updated if exports change.
- Event schemas are documented.
- `npm test`
- `npm run build`

### Phase 4: Memory Trace And Brain-First Mode

Goal: make memory useful without making it invisible or unsafe.

Scope:

- Add memory policy: `off`, `autoInject`, and `brainFirst`.
- In `brainFirst`, retrieve memories before the first provider call and record trace metadata.
- Add memory trace to final result: query, selected memory IDs, scores, source, scope, confidence, validation state, and injection status.
- Add provenance fields for memory entries where needed.
- Add deterministic memory retrieval fixtures and benchmark-style tests.
- Add prompt guidance that stale repo memories must be verified against current files before acting.

Primary files:

- `src/types.ts`
- `src/memory.ts`
- `src/memory-policy.ts`
- `src/engine.ts`
- `tests/memory.test.ts`
- `tests/memory-integration.test.ts`
- New retrieval fixture or benchmark test.

Acceptance gates:

- Brain-first retrieval happens before the first provider call.
- Memory trace appears in `AgentRunResult`.
- Retrieval order is deterministic for fixture data.
- Secrets remain redacted in self-improvement memory paths.
- `npm test`
- `npm run build`

### Phase 5: Durable Job Replay And Recovery

Goal: make background work operationally recoverable after interruption.

Scope:

- Persist enough launch context to safely replay queued or stale jobs.
- Add explicit replay/resume policy rather than pretending active model/tool execution can continue after process death.
- Add job timeout and retention policy.
- Add parent session/run linkage.
- Add doctor checks for stale jobs, abandoned runners, and storage health.
- Add tests for success, failure, cancellation, stale marking, replay, and namespace isolation.

Primary files:

- `src/agent-jobs.ts`
- `src/tools/agent-tool.ts`
- `src/tools/agent-job-tools.ts`
- `src/types.ts`
- `tests/runtime-isolation.test.ts`
- New focused agent job recovery test file if useful.

Acceptance gates:

- Queued jobs can be replayed.
- Stale jobs expose explicit recovery options.
- Cancelled jobs do not restart accidentally.
- Namespace isolation remains intact.
- Trace, evidence, and gates survive job completion.
- `npm test`
- `npm run build`

### Phase 6: Benchmark Harness And Performance Budgets

Goal: measure the runtime before optimizing it.

Scope:

- Add deterministic local benchmark harness with no live provider calls.
- Measure read-only tool fan-out, serial mutation ordering, context build/compaction, memory query latency, provider conversion overhead, and subagent startup overhead.
- Emit machine-readable JSON.
- Keep budgets advisory at first.
- Add CI-friendly command once stable.

Primary files:

- New `tests/benchmarks/` or `examples/benchmark-runtime.ts`
- `package.json` script if stable.
- `src/utils/compact.ts`
- `src/memory.ts`
- `src/engine.ts`

Acceptance gates:

- Benchmark command runs without network/API keys.
- Output is deterministic enough for trend comparison.
- No hard performance gates until baseline stabilizes.
- `npm test`
- `npm run build`

### Phase 7: Model Capability Registry And Provider Hardening

Goal: make model/provider behavior predictable.

Scope:

- Add `getModelCapabilities(model)` API.
- Track context window, tool support, reasoning/thinking support, multimodal support, JSON schema support, streaming support, cache behavior, and cost model.
- Add fallback model policy for unsupported capability, provider outage, or rate limit.
- Normalize provider error taxonomy.
- Prepare provider-level streaming design, but avoid forcing it into this phase unless scope remains controlled.

Primary files:

- `src/providers/types.ts`
- `src/providers/index.ts`
- `src/providers/openai.ts`
- `src/providers/anthropic.ts`
- `src/types.ts`
- `src/index.ts`
- Provider tests.

Acceptance gates:

- Capability lookup is deterministic.
- Fallback behavior is explicit and tested.
- Provider errors map to stable subtypes.
- Existing provider behavior remains compatible.
- `npm test`
- `npm run build`

## Collaboration Model

### Codex Role

Codex owns architecture synthesis, implementation patches when requested, test-driven hardening, code review, and final integration quality.

Primary responsibilities:

- Convert planning into concrete vertical slices.
- Protect public API compatibility.
- Implement focused runtime changes.
- Add deterministic tests.
- Run verification gates and report failures clearly.
- Review Clavue-authored patches for correctness, scope, and safety.
- Keep documentation aligned with actual behavior.

### Clavue Role

Clavue owns product reasoning, parallel analysis, UX expectation pressure, implementation exploration, and second-opinion validation.

Primary responsibilities:

- Challenge whether runtime behavior matches product-grade UX.
- Propose interaction flows and workflow skill behavior.
- Explore edge cases around CLI, package UX, memory, jobs, and provider behavior.
- Independently audit risky patches.
- Maintain user-facing north-star clarity.
- Validate whether the implementation actually feels ergonomic.

### Shared Ownership

Shared workstreams:

- Safety policy semantics.
- Workflow skill contract.
- Evidence and quality gate model.
- Memory retrieval trace.
- Durable job recovery.
- Event schema and observability.
- Production examples and README updates.

Coordination rules:

- One owner edits a file set at a time.
- Before touching core runtime files, state the intended write scope.
- Do not overwrite untracked files from the other agent.
- Each slice must have tests before moving to the next slice.
- Every public API change must update exports, tests, and docs in the same slice.
- No performance claims without a benchmark.
- No “production-grade” claim without policy, observability, and recovery evidence.

## Parallel Work Split

### Track A: Safety And Policy

Lead: Codex

Support: Clavue reviews UX and edge-case risk.

Outputs:

- Tool safety annotations.
- Built-in permission policy enforcement.
- Plan mode freeze behavior.
- Policy inheritance tests.

### Track B: Workflow And Skills

Lead: Clavue for product flow and skill UX, Codex for implementation and tests.

Outputs:

- Lifecycle skill definitions.
- Skill manifest metadata.
- Required evidence and gate model.
- Skill routing and enforcement tests.

### Track C: Observability And Doctor

Lead: Codex

Support: Clavue validates operator experience.

Outputs:

- Event schema versioning.
- `doctor()` API.
- MCP/session/memory/job health checks.
- Stable diagnostics format.

### Track D: Memory And Learning

Lead: Codex for implementation, Clavue for retrieval expectations.

Outputs:

- Brain-first memory policy.
- Memory trace in run results.
- Retrieval fixtures and benchmarks.
- Staleness and verification guidance.

### Track E: Durable Jobs

Lead: Codex

Support: Clavue tests long-running UX and stale-job workflows.

Outputs:

- Replay context.
- Timeout and retention policy.
- Stale recovery operations.
- Namespace isolation tests.

### Track F: Benchmarks And Provider Reliability

Lead: Codex

Support: Clavue pressure-tests product claims and first-run experience.

Outputs:

- Local benchmark harness.
- Model capability registry.
- Provider error taxonomy.
- Fallback policy tests.

## Milestone Schedule

### Milestone 1: Safe Runtime Foundation

Target result:

- Hosts can trust permission modes without rebuilding them.

Includes:

- Phase 1 safety and policy enforcement.
- Focused docs update.
- Full test/build verification.

Exit criteria:

- Read-only and plan workflows are impossible to mutate through built-in tools.
- Subagent and skill policy inheritance is tested.

### Milestone 2: Evidence-Gated Workflow UX

Target result:

- The SDK can run a plan-build-verify-review style workflow and report success based on evidence.

Includes:

- Phase 2 workflow gates and lifecycle skills.
- Optional gate-failure terminal behavior.
- README examples for evidence-gated runs.

Exit criteria:

- A workflow run can expose required gates and fail when configured gates fail.

### Milestone 3: Production Operability

Target result:

- Operators can diagnose configuration and inspect run behavior without reading source code.

Includes:

- Phase 3 event contracts and doctor API.
- Initial redaction helper.
- MCP/job/session/memory diagnostics.

Exit criteria:

- `doctor()` can identify missing credentials, invalid toolsets, broken stores, stale jobs, and MCP config issues.

### Milestone 4: Durable Intelligence

Target result:

- Memory and jobs are traceable and recoverable enough for long-lived products.

Includes:

- Phase 4 brain-first memory.
- Phase 5 job replay/recovery.

Exit criteria:

- Memory injection is visible in traces.
- Stale background work has explicit recovery behavior.

### Milestone 5: Measured Performance And Provider Maturity

Target result:

- Runtime claims are backed by measurements and provider capabilities are explicit.

Includes:

- Phase 6 benchmark harness.
- Phase 7 model capability registry and fallback policy.

Exit criteria:

- Benchmark JSON is available without live model calls.
- Provider capability and fallback behavior are tested.

## Review Loop For Every Slice

1. Define exact write scope and acceptance gates.
2. Implement the smallest vertical slice.
3. Add or update tests.
4. Run targeted tests.
5. Run `npm test`.
6. Run `npm run build`.
7. Ask the other agent for review focused on correctness, safety, and product experience.
8. Fix review findings or explicitly defer them.
9. Update docs and examples only after behavior is real.

## Standard Verification Commands

Baseline:

```bash
npm test
npm run build
```

Targeted checks:

```bash
npx tsx --test tests/permissions.test.ts
npx tsx --test tests/tools.test.ts
npx tsx --test tests/runtime-isolation.test.ts
npx tsx --test tests/memory.test.ts
npx tsx --test tests/memory-integration.test.ts
npx tsx --test tests/package-payload.test.ts
npm pack --dry-run --json
```

Add new targeted test commands as new slices introduce `doctor`, workflow, benchmark, job recovery, or provider capability tests.

## Immediate Next Actions

1. Freeze broad feature expansion until the current batch is reviewed as one release candidate.
2. Update README and examples for `permissionMode`, `qualityGatePolicy`, lifecycle skills, memory policy, `doctor()`, and `runBenchmarks()`.
3. Add explicit public API notes for result trace, memory trace, evidence, quality gates, doctor checks, and benchmark output.
4. Review safety semantics for tools that are currently classified conservatively, especially shell, MCP, web, task, cron, and subagent tools.
5. Only after docs and API review pass, start Phase 5 job replay/recovery or Phase 7 model capability work.
6. Keep this file as the coordination source for Codex and Clavue until a release checklist replaces it.

## Executive Control Notes

- Stop shipping new primitives without a user-facing integration story.
- Treat the current patch set as a release candidate, not a sandbox.
- Clavue should not begin job replay, provider capability, or plugin-lifecycle work until README/API stabilization is complete.
- Any new slice must name the exact public behavior, tests, docs, and rollback risk before implementation.
- Every claim of “production-grade” must point to policy enforcement, structured evidence, recovery behavior, or benchmark output.

## Product-Level Success Criteria

The next development stage is successful when:

- A host can run read-only review with no possible writes.
- A host can run plan mode with a real edit freeze.
- A host can run an edit workflow that cannot claim success until configured gates pass.
- A host can stream progress into a UI and reconstruct the run from structured events.
- A host can inspect every tool call, denial, retry, compaction, cost, evidence item, and gate result.
- A host can recover or explicitly replay interrupted background work.
- A host can use memory with visible retrieval trace and stale-fact safeguards.
- A host can benchmark latency, throughput, context behavior, memory retrieval, and job startup.
- A host can validate production configuration with `doctor()`.
- The simple quick-start path remains easy and stable.
