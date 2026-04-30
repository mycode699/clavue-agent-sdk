# Clavue Current Upgrade Execution Plan

Last updated: 2026-04-29

## Purpose

This document records the current upgrade status and defines the next implementation packets for Clavue.

It supersedes older "next slice" assumptions where the skill-loader work was still pending. The repo now already contains skill authoring and filesystem skill loading APIs, so the next upgrade should move to explicit tool concurrency and durable job orchestration.

## Verified Baseline

Verified locally by Codex on 2026-04-29:

- `npm run build` passed.
- `npx tsx --test tests/skills.test.ts tests/skills-loader.test.ts tests/package-payload.test.ts tests/permissions.test.ts tests/benchmark.test.ts` passed 73/73.
- `npm test` passed 194/194.

Working tree note:

- The repo is heavily modified and includes many uncommitted release-candidate changes.
- Do not revert unrelated edits.
- Do not treat untracked new source/test files as disposable.

## Upgrade Status

Completed or mostly completed in the current working tree:

- Controlled execution contract:
  - `CONTROLLED_EXECUTION_CONTRACT_VERSION`
  - `CONTROLLED_EXECUTION_CONTRACT_SCHEMA`
  - `getControlledExecutionContract()`
  - `WorkflowMode`
  - runtime profiles
- Fixed KPI/evaluation-loop contract:
  - `createEvaluationLoopContract()`
  - `normalizeEvaluationLoopContract()`
  - `EvaluationLoopContract`
- Model capability baseline:
  - `getModelCapabilities()`
  - `decideModelCapability()`
  - conservative unknown-model behavior
- Provider fallback baseline:
  - fallback model tests exist
  - cancellation and prompt-too-long are protected from unsafe fallback
- Skill manifest validation:
  - `validateSkillDefinition()`
  - structured validation issues
  - top-level `allowedTools` validation
  - permission metadata drift detection
- Skill authoring/loading:
  - `createSkill()`
  - `skillFromManifest()`
  - `loadSkillsFromDir()`
  - filesystem fixture tests
- Lifecycle workflow skills:
  - define, plan, build, verify, workflow-review, ship, repair
- Runtime readiness:
  - `doctor()`
  - `runBenchmarks()`
- Durable job baseline:
  - `AgentJob` records
  - heartbeat
  - stale detection
  - replay helper
  - job list/get/stop tools

## Remaining Upgrade Gaps

The product is better but still not world-class. Further upgrades are needed.

High-priority gaps:

- Tool concurrency is still configured only through `AGENT_SDK_MAX_TOOL_CONCURRENCY`.
- `AgentRunTrace` records `concurrency_batches`, but not the configured concurrency limit or source.
- Background subagent batches are not yet a first-class helper over durable `AgentJob`s.
- Job progress summaries are not yet a dedicated public API.
- Teams/messages are still shallow coordination primitives and not backed by jobs.
- Provider taxonomy still lacks explicit `unsupported_capability` design approval and implementation.
- Memory trace is useful but not rich enough for score breakdown, stale markers, retrieval IDs, and reason codes.
- Event/result schema versioning is not complete enough for long-term UI consumers.
- Public docs/examples lag behind runtime capabilities.

## Architecture Decision

`AgentJob` is the durable orchestration substrate.

Do not create a second durable execution primitive for teams/messages. Teams should eventually become views over jobs. Messages can remain lightweight coordination unless explicitly promoted later.

## Development Order

Use this order:

1. Explicit per-run tool concurrency and trace metadata.
2. Background subagent batch helper over `AgentJob`.
3. Job progress summary API.
4. Team-to-job integration.
5. Provider `unsupported_capability` taxonomy after design approval.
6. Rich memory trace.
7. Event/result schema versioning.
8. Public docs/examples.

Do not jump to broad autonomous workflows before slices 1-4 are complete.

## Slice 1: Explicit Tool Concurrency

Status: next implementation slice.

Goal:

Move tool concurrency from environment-only behavior to explicit per-run configuration while preserving current defaults and mutation safety.

Current baseline:

- `AGENT_SDK_MAX_TOOL_CONCURRENCY` exists.
- Invalid env values fall back safely.
- Read-only concurrency-safe tools can run in concurrent batches.
- Mutating tools run serially.
- Trace records `concurrency_batches`.

Deliverables:

- Add `maxToolConcurrency?: number` or similarly named option to `AgentOptions` and `QueryEngineConfig`.
- Preserve `AGENT_SDK_MAX_TOOL_CONCURRENCY` as fallback when the option is absent.
- Validate invalid option values and fall back safely.
- Add trace metadata:
  - configured max tool concurrency
  - source: option, env, or default
  - observed batch sizes
- Preserve existing `concurrency_batches` for compatibility.
- Update `runBenchmarks()` metadata if useful, without making benchmarks flaky.

Preferred files:

- `src/types.ts`
- `src/agent.ts`
- `src/engine.ts`
- `src/benchmark.ts`
- `tests/permissions.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Default behavior remains compatible.
- Env fallback still works.
- Explicit option overrides env.
- Invalid option values fall back safely.
- Read-only concurrency-safe tools never exceed the configured limit.
- Mutating tools remain serial even with high concurrency.
- `AgentRunTrace` exposes configured limit and source.
- Existing `concurrency_batches` tests still pass.
- `npm run build`
- `npx tsx --test tests/permissions.test.ts tests/benchmark.test.ts`
- `npm test`

Stop conditions:

- Stop if mutating tools can reorder.
- Stop if this requires provider changes.
- Stop if trace fields would be breaking instead of additive.

## Slice 2: Background Subagent Batch Helper

Goal:

Launch multiple background subagents as durable `AgentJob`s with inherited policy and a shared batch/correlation ID.

Deliverables:

- Add a helper for creating multiple background subagent jobs.
- Each task creates exactly one `AgentJob`.
- Add `batch_id` or correlation metadata to each job.
- Parent model, API type, cwd, runtime namespace, tool policy, allowed tools, disallowed tools, max turns, budget, and abort behavior should be inherited unless explicitly narrowed.
- Return a structured summary with job IDs and counts.
- Do not add a separate durable batch database unless a later design explicitly approves it.

Preferred files:

- `src/agent-jobs.ts`
- `src/tools/agent-tool.ts`
- `src/tools/agent-job-tools.ts`
- `src/types.ts`
- `src/index.ts`
- New `tests/agent-job-batch.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- Batch helper creates one durable job per task.
- Jobs include shared batch/correlation metadata.
- Jobs inherit runtime namespace and parent policy.
- Jobs can be listed, read, stopped, and marked stale through existing job APIs.
- Cancellation remains per job.
- Package typings export public helper/types if public.
- `npm run build`
- Focused batch/job tests.
- `npm test`

Stop conditions:

- Stop if this introduces a second durable batch store.
- Stop if child jobs can escape parent policy.
- Stop if write-scope conflict handling is ignored for multi-agent editing.

## Slice 3: Job Progress Summary

Goal:

Expose job progress in a structured form suitable for UI, CI, and doctor checks.

Deliverables:

- Add `summarizeAgentJobs()` or equivalent helper.
- Summary should include:
  - total jobs
  - counts by status
  - stale count
  - replayable count where available
  - failed count
  - cancelled count
  - latest heartbeat
  - latest update timestamp
  - evidence count
  - quality gate count
  - error summaries
- Support filtering by runtime namespace and batch/correlation ID if available.
- Add doctor check integration for stale/replayable jobs.

Preferred files:

- `src/agent-jobs.ts`
- `src/tools/agent-job-tools.ts`
- `src/doctor.ts`
- `src/types.ts`
- `src/index.ts`
- `tests/doctor.test.ts`
- New focused job summary tests
- `tests/package-payload.test.ts`

Acceptance gates:

- Summary is deterministic in temp-dir fixtures.
- Failed, cancelled, stale, and completed jobs are represented correctly.
- Evidence and gate counts are included.
- Doctor surfaces stale/replayable job warnings.
- Summary does not parse assistant prose as status.
- `npm run build`
- Focused job/doctor tests.
- `npm test`

Stop conditions:

- Stop if summary requires live process introspection.
- Stop if summary duplicates job state instead of aggregating it.

## Slice 4: Team-To-Job Integration

Goal:

Make teams a coordination view over durable jobs.

Deliverables:

- Team-created long-running work should create or reference `AgentJob`s.
- Team status should aggregate referenced job status.
- Team cancellation should cancel referenced jobs where authorized.
- Team output should point to job evidence, traces, gates, and outputs.
- Messages can remain lightweight/in-memory.

Preferred files:

- `src/tools/team-tools.ts`
- `src/tools/send-message.ts`
- `src/agent-jobs.ts`
- `src/types.ts`
- `tests/permissions.test.ts`
- New focused team/job tests if needed

Acceptance gates:

- Existing team tools remain compatible.
- Team-created work is inspectable through job APIs.
- Team status does not diverge from job status.
- Namespace isolation is preserved.
- `npm run build`
- Focused team/job tests.
- `npm test`

Stop conditions:

- Stop if durable team storage becomes necessary before job integration.
- Stop if messages become a second source of truth for execution status.

## Slice 5: Provider Unsupported Capability Contract

Status: design approval required before implementation.

Goal:

Normalize unsupported capability errors and fallback decisions.

Do not merge isolated RED tests until this slice is explicitly approved.

Deliverables after approval:

- Add `unsupported_capability` to provider error taxonomy if not already present.
- Ensure capability helpers can explain unsupported/unknown capability decisions.
- Fallback should only happen for unsupported capability when the fallback model is known to support the requested capability.
- Cancellation and auth failures must not fallback.
- Prompt-too-long fallback requires explicit policy and known larger context.

Preferred files:

- `src/providers/types.ts`
- `src/providers/capabilities.ts`
- `src/providers/index.ts`
- `src/providers/openai.ts`
- `src/providers/anthropic.ts`
- `src/engine.ts`
- `tests/openai-provider.test.ts`
- `tests/model-fallback.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- Unknown models remain conservative.
- Unsupported capability errors normalize to `unsupported_capability`.
- Unsupported capability fallback is blocked unless fallback supports the capability.
- Existing provider tests remain green.
- `npm run build`
- Provider-focused tests.
- `npm test`

Stop conditions:

- Stop if provider API names are not approved.
- Stop if isolated RED tests require broad provider rewrites.

## Slice 6: Rich Memory Trace

Goal:

Make memory auditable enough for production decisions.

Deliverables:

- Add retrieval ID.
- Add retrieval duration.
- Add candidate count and selected count.
- Add filters and strategy.
- Add reason codes for selected memories.
- Add score breakdown or at least score components.
- Add stale marker and validation state.
- Add redaction status.
- Keep `brainFirst` retrieval before first provider call.

Preferred files:

- `src/memory.ts`
- `src/memory-policy.ts`
- `src/engine.ts`
- `src/types.ts`
- `tests/memory.test.ts`
- `tests/memory-integration.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Memory trace explains why memories were selected.
- Distractor fixture ranks expected memory first.
- Stale/unvalidated memories are visible as risk.
- Secrets remain redacted.
- `npm run build`
- Focused memory tests.
- `npm test`

Stop conditions:

- Stop if memory becomes trusted without validation metadata.
- Stop if retrieval quality cannot be deterministically tested.

## Slice 7: Event And Result Schema Versioning

Goal:

Make `query()` streaming events and final run results safe for UI consumers.

Deliverables:

- Add additive schema version metadata or exported schema constants.
- Include event and result schema information in controlled execution contract if appropriate.
- Add golden event/result shape tests using stub providers.
- Do not rename existing event fields.

Preferred files:

- `src/types.ts`
- `src/engine.ts`
- `src/runtime-profiles.ts`
- `tests/permissions.test.ts`
- New `tests/event-contract.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- Init, assistant, tool result, final result, status, task, compaction, and rate-limit events are covered.
- Existing consumers remain compatible.
- `npm run build`
- Focused event tests.
- `npm test`

Stop conditions:

- Stop if field stability promises are not clear.
- Stop if this becomes a breaking event schema change.

## Slice 8: Public Docs And Examples

Goal:

Make the stable V1 APIs usable by real developers.

Start only after Slices 1-3 are green.

Deliverables:

- README sections for:
  - workflow modes
  - controlled execution contract
  - evaluation loop contract
  - skill validation/loading
  - tool concurrency
  - job summary
  - doctor and benchmarks
- Examples for:
  - `workflowMode: 'review'`
  - `qualityGatePolicy`
  - `createEvaluationLoopContract()`
  - `loadSkillsFromDir()`
  - explicit `maxToolConcurrency`
  - job progress summary

Acceptance gates:

- Examples compile or run under `npx tsx`.
- Docs only claim tested behavior.
- `npm run build`
- `npm test`

Stop conditions:

- Stop if docs need to describe APIs not yet implemented.

## Clavue Work Rules

For every slice:

- Read this document first.
- Work only on the active slice.
- Do not edit provider files unless provider slice is approved.
- Do not merge isolated RED tests unless provider slice is approved.
- Do not publish, tag, commit, push, or bump version.
- Do not edit generated `dist/`.
- Preserve dirty-tree changes.
- Run focused tests first.
- Run full `npm test` only after focused tests pass.

## Required Clavue Final Report

Each implementation report must include:

- Verdict: `Keep`, `Revise`, or `Blocked`.
- Changed files.
- Public API names added or changed.
- Tests run and exact pass/fail counts.
- Residual risks.
- Next recommended slice.

## First Packet To Give Clavue

Use this packet for the next upgrade:

```text
Controller packet for /Users/lu/openagent/open-agent-sdk-typescript.

Mission: implement Slice 1 from docs/clavue-current-upgrade-execution-plan.md: Explicit Tool Concurrency.

Current verified baseline from Codex:
- npm run build passed.
- npx tsx --test tests/skills.test.ts tests/skills-loader.test.ts tests/package-payload.test.ts tests/permissions.test.ts tests/benchmark.test.ts passed 73/73.
- npm test passed 194/194.

You are not alone in the codebase. Do not revert unrelated edits. Do not edit provider files. Do not merge isolated RED tests. Do not edit docs. Do not publish, tag, commit, push, bump version, or edit dist.

Read docs/clavue-current-upgrade-execution-plan.md first. Follow Slice 1 scope, preferred files, acceptance gates, and stop conditions exactly.

Required gates:
- npm run build
- npx tsx --test tests/permissions.test.ts tests/benchmark.test.ts
- npm test if focused gates pass

Final response must include Verdict, changed files, public API names, tests with pass/fail counts, residual risks, and next recommended slice.
```
