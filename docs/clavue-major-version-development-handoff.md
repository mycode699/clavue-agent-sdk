# Clavue Major-Version Development Handoff

Last updated: 2026-04-29

## Purpose

This document is the execution handoff for Clavue to continue major-version development of `clavue-agent-sdk`.

The product goal is to turn the SDK from a broad agent toolkit into a world-class embeddable autonomous-work runtime. The reference lesson from `karpathy/autoresearch` is not "add more tools." The lesson is controlled repeatability:

- Constrained action surface.
- Fixed KPI and evaluation loop.
- Prompt-as-program through explicit instructions and manifests.
- Reproducible autonomous iteration.
- Clear human control over budget, permissions, and final acceptance.

## Current Accepted Baseline

The current working tree already contains substantial release-candidate work. Do not revert it.

Accepted green gates from Codex review on 2026-04-29:

- `npm run build` passed.
- `npx tsx --test tests/permissions.test.ts tests/package-payload.test.ts` passed 56/56 after the controlled-execution slice.
- `npx tsx --test tests/evaluation-loop.test.ts tests/package-payload.test.ts` passed 12/12 after the evaluation-loop slice.
- `npx tsx --test tests/skills.test.ts tests/package-payload.test.ts tests/permissions.test.ts` passed 62/62 after the skill-validation slice.
- `npm test` passed 185/185 after the skill-validation slice.

Accepted public surfaces already added or stabilized:

- `CONTROLLED_EXECUTION_CONTRACT_VERSION`
- `CONTROLLED_EXECUTION_CONTRACT_SCHEMA`
- `getControlledExecutionContract()`
- `ControlledExecutionContract`
- `WorkflowMode`
- `RuntimeProfile`
- `getRuntimeProfile()`
- `getAllRuntimeProfiles()`
- `applyRuntimeProfile()`
- `createEvaluationLoopContract()`
- `normalizeEvaluationLoopContract()`
- `EvaluationLoopContract` and related evaluation-loop types
- `validateSkillDefinition()`
- `SkillValidationIssue`
- `SkillValidationResult`
- `SkillValidationOptions`

Do not rename these APIs without explicit controller approval.

## Non-Negotiable Engineering Rules

- Keep `run()`, `query()`, and `createAgent()` compatible.
- Prefer narrow additive APIs over broad rewrites.
- Every public API change needs package payload/type export coverage.
- Every workflow capability needs deterministic tests.
- Every autonomous capability needs a measurable gate or evidence artifact.
- Runtime safety must be enforced by code, not only by prompt text.
- Do not rely on assistant prose as proof of success when a test, gate, trace, or structured result can represent it.
- Do not edit generated `dist/` manually.
- Do not publish, tag, commit, push, or change package version unless explicitly instructed.
- Do not revert unrelated dirty-tree changes.

## Product North Star

The SDK should become:

> The embeddable autonomous-work runtime where every agent action is constrained, inspectable, reproducible, measurable, and recoverable.

The user experience should have three layers:

- Simple: one prompt into `run()`, one typed result out.
- Live: `query()` streams stable events suitable for UI, terminal, and dashboards.
- Production: `createAgent()` composes tools, memory, skills, MCP, sessions, jobs, hooks, workflows, gates, and telemetry under explicit policy.

## V1 Definition: Production-Safe Controlled Runtime

V1 is not full autonomy. V1 means the current runtime is safe, inspectable, and stable enough for production hosts.

V1 must provide:

- Stable public result, event, trace, profile, skill, memory, and diagnostic contracts.
- Workflow modes that deterministically expand into toolsets, permission mode, memory policy, prompt guidance, and quality-gate policy.
- Conservative provider/model capability detection.
- Tool safety metadata and built-in permission enforcement.
- Skills as validated executable manifests, not only prompt snippets.
- Quality gates that can determine terminal success or failure.
- Memory trace that explains retrieval and injection.
- Doctor and benchmark surfaces for readiness and performance checks.
- Package export and payload tests for every public surface.

V1 is complete only when public docs and examples explain the stable surfaces. Runtime behavior must land before docs.

## V2 Definition: Reproducible Autonomous-Work Platform

V2 builds on V1 and adds repeatable autonomous iteration.

V2 must provide:

- Fixed-budget autonomous loops with baseline, metric, candidate change, verification, and keep/discard decision.
- Workflow templates such as `define -> solve -> verify -> repair` and `collect -> organize -> decide -> plan`.
- Durable run/job/eval ledgers with replay or explicit unrecoverable-state semantics.
- Skill creation, loading, validation, enforcement, and promotion.
- Multi-agent coordination with inherited policy, budgets, trace IDs, and write-scope arbitration.
- Memory validation lifecycle and retrieval quality benchmarks.
- CI-compatible benchmark history and regression comparison.

Do not start V2 orchestration until V1 contracts and enforcement are stable.

## Development Sequence

### Slice 1: Skill Loader And Scaffolding APIs

Status: next recommended implementation slice.

Goal: make validated skills easy to author and load without changing runtime execution semantics.

Deliverables:

- Add `createSkill()` or `skillFromManifest()` helper that builds a `SkillDefinition` from a typed manifest plus prompt content.
- Add `loadSkillsFromDir()` for a simple filesystem format:
  - Directory contains `skill.json` or `skill.config.json`.
  - Directory contains `SKILL.md` as the prompt body.
  - Loader validates with `validateSkillDefinition()` before registration.
- Add an option to load without registering, and an option to register into a runtime namespace.
- Add clear structured errors for missing manifest, missing prompt, invalid JSON, invalid manifest, duplicate names, and unknown tools.
- Keep `registerSkill()` behavior compatible.

Preferred files:

- `src/skills/types.ts`
- `src/skills/registry.ts`
- `src/skills/index.ts`
- New `src/skills/authoring.ts`
- New `src/skills/loader.ts`
- `src/index.ts`
- New `tests/skills-loader.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- Valid temp-directory fixture loads deterministically.
- Invalid manifest fails before registration.
- Missing `SKILL.md` fails clearly.
- Unknown top-level `allowedTools` fails when available tools are supplied.
- Loader can return definitions without registering.
- Loader can register into a runtime namespace without leaking globally.
- Public exports are present in `dist/index.d.ts`.
- `npm run build`
- `npx tsx --test tests/skills.test.ts tests/skills-loader.test.ts tests/package-payload.test.ts`
- `npm test`

Stop conditions:

- Stop if this requires engine behavior changes.
- Stop if the filesystem format becomes complex enough to require a separate design review.

### Slice 2: Skill Gate Enforcement

Goal: make skill-level gates and required artifacts capable of affecting terminal run status when enforcement is enabled.

Deliverables:

- Add an opt-in run option, for example `skillGatePolicy`, `enforceSkillGates`, or a conservative extension to `qualityGatePolicy`.
- When a skill activation declares required `qualityGates`, expose them as expected gate requirements.
- Missing or failed required skill gates should produce a clear terminal subtype only when enforcement is enabled.
- Inline and forked skill activations must preserve skill name, required artifacts, gates, allowed tools, and model in structured metadata.
- Do not make all skills strict by default.

Preferred files:

- `src/types.ts`
- `src/tools/skill-tool.ts`
- `src/engine.ts`
- `src/agent.ts`
- `tests/permissions.test.ts`
- `tests/skills.test.ts`

Acceptance gates:

- Existing skill activation tests still pass.
- Enforcement off preserves current behavior.
- Enforcement on fails terminally for missing required skill gates.
- Gate failure is represented in `AgentRunResult.errors`, `quality_gates`, and final result event.
- Forked skill jobs preserve gate expectations in job metadata.
- `npm run build`
- Focused skill and permissions tests.
- `npm test`

Stop conditions:

- Stop if automatic enforcement cannot be represented without ambiguous terminal semantics.
- Stop if this creates a breaking change for existing skill users.

### Slice 3: Context Pipeline Contract

Goal: make prompt assembly budgeted and inspectable.

Deliverables:

- Add `ContextPack` or `ContextPipeline` planner.
- Track sections for base system prompt, tool prompts, skill listing, project instructions, git status, user context, memory, and appended system prompt.
- Each section records included/dropped/truncated, estimated tokens, source, and reason.
- Add trace output for context packing without changing prompt contents unnecessarily.
- Keep default prompt behavior compatible.

Preferred files:

- `src/utils/context.ts`
- `src/utils/tokens.ts`
- `src/engine.ts`
- `src/types.ts`
- `tests/context.test.ts`
- New `tests/context-pack.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Context packing is deterministic in fixture tests.
- Host apps can inspect why a section was included, dropped, or truncated.
- Token estimates are stable enough for tests.
- Existing context tests still pass.
- `npm run build`
- Focused context tests.
- `npm test`

Stop conditions:

- Stop if the slice changes prompt semantics broadly.
- Stop if token counting is treated as exact provider billing rather than an estimate.

### Slice 4: Rich Memory Trace

Goal: make memory useful and safe enough for production.

Deliverables:

- Extend memory trace with retrieval ID, duration, store, candidate count, selected count, filters, strategy, score breakdown, source, scope, confidence, validation state, stale marker, and redaction status.
- Keep `brainFirst` retrieval before first provider call.
- Add reason codes explaining why each memory was selected.
- Add deterministic memory retrieval benchmark fixtures with distractors and stale entries.
- Add prompt guidance that stale repo memories must be verified against current files before acting.

Preferred files:

- `src/memory.ts`
- `src/memory-policy.ts`
- `src/engine.ts`
- `src/types.ts`
- `tests/memory.test.ts`
- `tests/memory-integration.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Trace records candidate and selected counts.
- Selected memories include score, source, scope, confidence, validation state, stale marker, and reason.
- Distractor fixture ranks expected memory first.
- Secrets remain redacted in self-improvement paths.
- `npm run build`
- Focused memory tests.
- `npm test`

Stop conditions:

- Stop if memory becomes trusted without validation metadata.
- Stop if retrieval quality cannot be deterministically tested.

### Slice 5: Event And Result Schema Versioning

Goal: make streaming and result consumers safe across releases.

Deliverables:

- Add schema version fields or exported schema constants for SDK events and final results.
- Extend `getControlledExecutionContract()` if appropriate.
- Document compatibility expectations in types and tests first; public docs later.
- Add golden tests for event/result shape from stub-provider runs.

Preferred files:

- `src/types.ts`
- `src/engine.ts`
- `src/runtime-profiles.ts`
- `tests/permissions.test.ts`
- New `tests/event-contract.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- Init, assistant, tool result, final result, status, task notification, compaction, and rate-limit event shapes are covered.
- New schema information is additive.
- Existing consumers remain compatible.
- `npm run build`
- Focused event tests.
- `npm test`

Stop conditions:

- Stop if this requires renaming existing event fields.
- Stop if schema versioning creates false stability promises for fields that are still experimental.

### Slice 6: Job Recovery Semantics

Goal: make background jobs operationally honest after interruption.

Deliverables:

- Persist enough replay input for queued or stale jobs.
- Add explicit `replay`, `mark_stale`, or `cannot_resume` semantics.
- Do not claim active model/tool execution can resume after process death unless it truly can.
- Add doctor checks for stale jobs and recovery recommendations.
- Preserve namespace isolation.

Preferred files:

- `src/agent-jobs.ts`
- `src/tools/agent-tool.ts`
- `src/tools/agent-job-tools.ts`
- `src/doctor.ts`
- `src/types.ts`
- `tests/permissions.test.ts`
- `tests/doctor.test.ts`

Acceptance gates:

- Stale jobs are reported with actionable status.
- Replay uses persisted input and respects parent policy.
- Cancellation is preserved.
- Namespace isolation tests pass.
- Doctor warns about stale/replayable jobs.
- `npm run build`
- Focused job and doctor tests.
- `npm test`

Stop conditions:

- Stop if recovery semantics become ambiguous.
- Stop if replay can violate original tool or permission policy.

### Slice 7: Benchmark Expansion

Goal: make performance claims measurable.

Deliverables:

- Expand `runBenchmarks()` to include provider conversion overhead, context pack planning, compaction summary cost, skill validation/load cost, and subagent/job startup storage overhead.
- Keep benchmarks offline and deterministic.
- Add stable JSON fields suitable for CI comparison.
- Do not enforce hard budgets until baselines are observed.

Preferred files:

- `src/benchmark.ts`
- `src/types.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Benchmarks run without provider credentials or network.
- Metric names are stable and documented in types.
- Invalid iteration counts still fail.
- `npm run build`
- `npx tsx --test tests/benchmark.test.ts`
- `npm test`

Stop conditions:

- Stop if a benchmark requires live network or real model calls.
- Stop if benchmark output is nondeterministic enough to break CI.

### Slice 8: Public Docs And Examples

Goal: make the new V1 surfaces usable.

Only start after runtime APIs are stable.

Deliverables:

- README section for workflow modes.
- README section for controlled-execution contract.
- README section for evaluation-loop contract.
- README section for skill validation and loader.
- README section for doctor and benchmarks.
- Examples for:
  - `workflowMode: 'review'`
  - `qualityGatePolicy`
  - `createEvaluationLoopContract()`
  - `validateSkillDefinition()`
  - `loadSkillsFromDir()`

Preferred files:

- `README.md`
- `examples/`
- `docs/agent-sdk-capability-upgrade-program.md`
- `docs/next-stage-development-plan.md`

Acceptance gates:

- Examples compile or run under `npx tsx`.
- README commands are realistic.
- No docs claim production readiness beyond tested behavior.
- `npm run build`
- `npm test`

Stop conditions:

- Stop if docs need to describe APIs not yet implemented.

## Shared API Quality Bar

Public helper APIs should be:

- Deterministic.
- JSON-serializable where possible.
- Easy to test without network.
- Conservative by default.
- Typed with exported TypeScript interfaces.
- Covered by package payload tests.
- Stable in naming and semantics once accepted.

Avoid:

- Hidden global state unless namespace-isolated.
- Runtime behavior that depends on prompt compliance only.
- New CLI flags before library APIs are stable.
- Broad refactors mixed with public API additions.
- New dependencies unless there is a clear payoff and tests justify them.

## Verification Matrix

Use the smallest focused gate first, then full tests.

Common gates:

```bash
npm run build
npm test
```

Package/export gate:

```bash
npx tsx --test tests/package-payload.test.ts
```

Workflow/permission/skill gate:

```bash
npx tsx --test tests/permissions.test.ts tests/skills.test.ts tests/package-payload.test.ts
```

Evaluation loop gate:

```bash
npx tsx --test tests/evaluation-loop.test.ts tests/package-payload.test.ts
```

Provider gate:

```bash
npx tsx --test tests/openai-provider.test.ts tests/model-fallback.test.ts
```

Memory gate:

```bash
npx tsx --test tests/memory.test.ts tests/memory-integration.test.ts
```

Doctor and benchmark gate:

```bash
npx tsx --test tests/doctor.test.ts tests/benchmark.test.ts
```

## Required Clavue Work Report Format

Every Clavue implementation slice must end with:

- Verdict: `Keep`, `Revise`, or `Blocked`.
- Changed files.
- Public API names added or changed.
- Tests run and exact pass/fail counts.
- Residual risks.
- Next recommended slice.

If a focused gate fails, stop feature work and fix the gate first.

## Controller Review Checklist

Codex should review each Clavue slice for:

- Did it preserve `run()`, `query()`, and `createAgent()` compatibility?
- Did it add tests before relying on behavior?
- Did package typings export new public APIs?
- Did it avoid broad engine/provider rewrites outside scope?
- Did it preserve runtime namespace isolation?
- Did it keep autonomy bounded by policy, budget, gate, or trace?
- Did it add machine-readable evidence rather than prose-only success?
- Did it run focused tests and full `npm test`?

## First Command To Give Clavue

Use this exact packet for the next development slice:

```text
Controller packet for /Users/lu/openagent/open-agent-sdk-typescript.

Mission: implement Slice 1 from docs/clavue-major-version-development-handoff.md: Skill Loader And Scaffolding APIs.

You are not alone in the codebase. Do not revert unrelated edits. Do not edit docs. Do not publish, tag, commit, or push.

Read docs/clavue-major-version-development-handoff.md first and follow the Slice 1 scope, preferred files, acceptance gates, and stop conditions.

Required gates before final response:
- npm run build
- npx tsx --test tests/skills.test.ts tests/skills-loader.test.ts tests/package-payload.test.ts
- npm test if focused gates pass

Final response must include Verdict, changed files, public API names, tests with pass/fail counts, residual risks, and next recommended slice.
```
