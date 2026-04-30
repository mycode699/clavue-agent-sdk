# Clavue Cursor-Cookbook Infrastructure Upgrade Plan

Last updated: 2026-04-30

## Purpose

This document is the next Clavue-facing development handoff for upgrading `clavue-agent-sdk` into a world-class embeddable agent infrastructure product.

It combines:

- The accepted `karpathy/autoresearch` lesson: controlled repeatability, fixed evaluation loops, constrained actions, and explicit human control.
- The current worker findings: durable orchestration must center on `AgentJob`; teams/messages are adapters until backed by jobs.
- The Cursor Cookbook lesson: a serious agent SDK is proven through runnable infrastructure examples, not only API references.

Status: implementation handoff after design alignment. Clavue should implement slices in order and stop after each gate. Do not broaden scope without Codex/controller approval.

## Current Verified Baseline

Verified locally by Codex on 2026-04-30:

- `npm run build` passed.
- `npm test` passed 195/195.

Current repo state:

- The worktree is heavily modified with release-candidate changes.
- Do not revert unrelated edits.
- Do not treat untracked source, tests, or docs as disposable.
- Do not publish, tag, commit, push, or bump versions unless explicitly instructed.

Completed or mostly completed:

- Controlled execution contract and runtime profiles.
- Fixed evaluation-loop contract.
- Skill validation, authoring, and filesystem loading.
- Lifecycle workflow skills.
- Provider capability baseline and fallback tests.
- Doctor and benchmark surfaces.
- Durable `AgentJob` baseline with create/list/get/stop, heartbeat, stale detection, replay, and background subagent usage.

Still incomplete:

- Explicit per-run tool concurrency option and trace metadata.
- First-class background subagent batch helper over `AgentJob`.
- Job progress summary API suitable for UI, CI, and doctor.
- Team-to-job integration.
- Provider `unsupported_capability` taxonomy and normalized behavior.
- Rich memory trace and retrieval quality scoring.
- Event/result schema versioning for long-term UI compatibility.
- Cookbook-grade examples that prove SDK-as-infrastructure.

## Product North Star

The SDK should become:

> The embeddable autonomous-work runtime where every agent action is constrained, inspectable, reproducible, measurable, recoverable, and easy to adopt through production-grade examples.

The product must work at three levels:

- Simple: one prompt into `run()`, one typed result out.
- Interactive: `query()` streams stable events for terminal, web, and dashboards.
- Infrastructure: `createAgent()` composes tools, memory, skills, MCP, sessions, jobs, workflows, gates, diagnostics, and examples under explicit policy.

## Cursor Cookbook Lessons To Adopt

Cursor Cookbook is valuable because it presents an agent SDK as infrastructure through runnable recipes and apps. It does not only document methods. It shows how the SDK becomes a real product surface.

Adopt these lessons:

- Ship a fast quickstart that proves value in minutes.
- Provide runnable apps, not only isolated scripts.
- Demonstrate background/cloud-style agents with task state, cancellation, and progress.
- Treat event streaming and conversation state as first-class UI contracts.
- Show infrastructure patterns through examples: CLI, dashboard, kanban/task board, app builder, and workflow templates.
- Keep examples opinionated and complete enough that teams can copy them into real products.
- Make every example testable or smoke-testable so examples do not rot.

Do not copy Cursor’s product shape blindly. Our differentiator is controlled autonomous work: constrained tools, fixed KPIs, durable jobs, skills, gates, memory trace, and reproducible evaluation.

## Non-Negotiable Architecture Decisions

- `AgentJob` is the durable orchestration substrate.
- Teams are coordination views over jobs, not a second durable runtime.
- Messages can stay lightweight unless later explicitly promoted.
- Long-running or background work must be represented as `AgentJob`.
- Provider capability/error taxonomy is separate from orchestration work.
- Runtime safety must be enforced by code, not prompt text.
- Public API changes must be additive unless a breaking-change plan is approved.
- Every public surface needs tests and package export coverage.
- Examples must follow stable public APIs; examples should not depend on private internals.

## Development Order

Implement in this order:

1. Runtime control plane completion.
2. Durable orchestration completion.
3. Provider reliability contract.
4. Memory and trace observability.
5. Schema/versioning contract.
6. Cursor-style cookbook infrastructure examples.
7. Documentation and adoption polish.

Do not start broad autonomous V2 workflows until slices 1-4 below pass.

## Slice 1: Explicit Tool Concurrency

Status: first implementation slice.

Goal:

Move tool concurrency from environment-only behavior to explicit per-run configuration while preserving current defaults and mutation safety.

Deliverables:

- Add `maxToolConcurrency?: number` or equivalent to `AgentOptions` and `QueryEngineConfig`.
- Preserve `AGENT_SDK_MAX_TOOL_CONCURRENCY` as fallback when the option is absent.
- Validate invalid values and fall back safely.
- Add additive trace metadata:
  - configured max tool concurrency
  - configuration source: option, env, or default
  - observed batch sizes
- Preserve existing `concurrency_batches` for compatibility.
- Keep mutating tools serial even when concurrency is high.

Likely files:

- `src/types.ts`
- `src/agent.ts`
- `src/engine.ts`
- `src/benchmark.ts`
- `tests/permissions.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Default behavior remains compatible.
- Explicit option overrides env.
- Env fallback still works.
- Invalid option values fall back safely.
- Read-only concurrency-safe tools never exceed configured limit.
- Mutating tools remain serial.
- `AgentRunTrace` exposes configured limit and source.
- Existing `concurrency_batches` tests still pass.
- `npm run build`
- `npx tsx --test tests/permissions.test.ts tests/benchmark.test.ts`
- `npm test`

Stop conditions:

- Stop if mutating tools can reorder.
- Stop if provider code must change.
- Stop if trace changes become breaking instead of additive.

## Slice 2: Background Subagent Batch Helper

Goal:

Launch multiple background subagents as durable `AgentJob`s with inherited policy and shared correlation metadata.

Deliverables:

- Add `runAgentJobBatch()`, `createAgentJobBatch()`, or similarly named public helper.
- Each task creates exactly one durable `AgentJob`.
- Jobs include `batch_id` or equivalent correlation metadata.
- Parent policy is inherited unless explicitly narrowed:
  - model
  - API type
  - cwd
  - runtime namespace
  - allowed/disallowed tools
  - permission mode
  - max turns
  - budget/abort behavior where applicable
- Return a structured summary with batch ID, job IDs, counts, and rejected task reasons.
- Do not create a second durable batch database; batch state must be reconstructable from job metadata.

Likely files:

- `src/agent-jobs.ts`
- `src/tools/agent-tool.ts`
- `src/tools/agent-job-tools.ts`
- `src/types.ts`
- `src/index.ts`
- `tests/agent-job-batch.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- Batch helper creates one job per accepted task.
- Jobs share batch/correlation metadata.
- Jobs inherit runtime namespace and parent policy.
- Jobs can be listed, read, stopped, marked stale, and replayed through existing job APIs.
- Cancellation remains per job.
- Package typings export public helper/types if public.
- `npm run build`
- Focused batch/job tests.
- `npm test`

Stop conditions:

- Stop if implementation introduces a second durable batch store.
- Stop if child jobs can escape parent policy.
- Stop if write-scope conflict handling is ignored for multi-agent editing.

## Slice 3: Job Progress Summary

Goal:

Expose durable job progress in a structured form suitable for UI, CI, doctor checks, and cookbook dashboards.

Deliverables:

- Add `summarizeAgentJobs()` or equivalent helper.
- Summary includes:
  - total jobs
  - counts by status
  - queued/running/completed/failed/cancelled/stale counts
  - replayable count
  - latest heartbeat
  - latest update timestamp
  - evidence count
  - quality gate count
  - compact error summaries
- Support filtering by runtime namespace and batch/correlation ID.
- Add doctor integration for stale, failed, and replayable jobs.
- Do not parse assistant prose as authoritative status.

Likely files:

- `src/agent-jobs.ts`
- `src/tools/agent-job-tools.ts`
- `src/doctor.ts`
- `src/types.ts`
- `src/index.ts`
- `tests/doctor.test.ts`
- `tests/agent-job-summary.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- Summary is deterministic in temp-dir fixtures.
- Failed, cancelled, stale, running, queued, and completed jobs are represented correctly.
- Evidence and gate counts are included.
- Filtering by namespace and batch works.
- Doctor surfaces actionable stale/replayable warnings.
- `npm run build`
- Focused job/doctor tests.
- `npm test`

Stop conditions:

- Stop if summary requires live process introspection.
- Stop if summary duplicates state instead of aggregating job records.
- Stop if summary depends on natural-language output.

## Slice 4: Team-To-Job Integration

Goal:

Make teams a coordination layer over durable jobs.

Deliverables:

- Team task execution should create or reference `AgentJob`s.
- Team status should aggregate referenced job summaries.
- Team cancellation should cancel referenced jobs where authorized.
- Team output should point to job evidence, traces, gates, and outputs.
- Keep lightweight messages in-memory unless persistence is explicitly approved.

Likely files:

- `src/tools/team-tools.ts`
- `src/tools/agent-job-tools.ts`
- `src/agent-jobs.ts`
- `src/types.ts`
- `tests/team-tools.test.ts` or focused additions
- `tests/package-payload.test.ts`

Acceptance gates:

- Team-created work has durable job records.
- Team status does not claim completion before referenced jobs complete.
- Team cancellation updates referenced jobs.
- Runtime namespace isolation remains intact.
- Existing team/message tests still pass.
- `npm run build`
- Focused team/job tests.
- `npm test`

Stop conditions:

- Stop if team state becomes a competing durable execution store.
- Stop if job authorization boundaries are unclear.

## Slice 5: Provider Reliability Contract

Status: design-gated until controller approval.

Goal:

Make provider behavior predictable across model families and gateway compatibility failures.

Deliverables after approval:

- Define normalized provider error categories including `unsupported_capability`.
- Define which categories are retryable, fallback-eligible, or terminal.
- Ensure OpenAI-compatible and Anthropic-compatible providers expose stable metadata.
- Merge or recreate the isolated RED tests only after approval.
- Keep cancellation and prompt-too-long protected from unsafe fallback.

Likely files:

- `src/providers/types.ts`
- `src/providers/capabilities.ts`
- `src/providers/openai.ts`
- `src/providers/anthropic.ts`
- `src/providers/index.ts`
- `tests/openai-provider.test.ts`
- `tests/anthropic-provider.test.ts`
- `tests/model-fallback.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- `unsupported_capability` is represented consistently.
- Unknown models remain conservative.
- Gateway transport fallback remains narrow and explicit.
- Cancellation never triggers fallback.
- Prompt-too-long recovery remains distinct from model fallback.
- `npm run build`
- Focused provider/fallback tests.
- `npm test`

Stop conditions:

- Stop if the design requires breaking public provider APIs.
- Stop if fallback behavior becomes broader than the approved taxonomy.

## Slice 6: Rich Memory Trace

Goal:

Make memory retrieval inspectable, safe, and benchmarkable.

Deliverables:

- Extend memory trace with retrieval ID, duration, store, strategy, filters, candidate count, selected count, score breakdown, source, scope, confidence, validation state, stale marker, redaction status, and reason codes.
- Keep `brainFirst` retrieval before the first provider call.
- Add deterministic retrieval fixtures with distractors and stale entries.
- Add guidance that stale repo memories must be verified against current files before acting.

Likely files:

- `src/memory.ts`
- `src/memory-policy.ts`
- `src/engine.ts`
- `src/types.ts`
- `tests/memory.test.ts`
- `tests/memory-integration.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Trace records candidate and selected counts.
- Selected memories include score/source/scope/confidence/stale/reason metadata.
- Distractor fixture ranks expected memory first.
- Secrets remain redacted in self-improvement paths.
- `npm run build`
- Focused memory tests.
- `npm test`

Stop conditions:

- Stop if memory traces leak secrets.
- Stop if ranking becomes non-deterministic in tests.

## Slice 7: Event And Result Schema Versioning

Goal:

Make streamed events and run results stable enough for third-party UI and dashboard consumers.

Deliverables:

- Add explicit schema version fields for stable public event/result/trace surfaces.
- Document additive compatibility rules.
- Add fixtures for key event sequences:
  - init
  - tool call
  - permission denial
  - quality gate failure
  - background job creation
  - final result
- Ensure dashboards can rely on structured fields rather than prose.

Likely files:

- `src/types.ts`
- `src/engine.ts`
- `src/runtime-profiles.ts`
- `tests/permissions.test.ts`
- `tests/package-payload.test.ts`
- New event fixture tests if needed

Acceptance gates:

- Schema version appears in public structured outputs.
- Existing consumers remain compatible.
- Fixture tests prove stable field presence.
- `npm run build`
- Focused event/result tests.
- `npm test`

Stop conditions:

- Stop if versioning requires a breaking result shape without migration.

## Slice 8: Cursor-Style Cookbook Examples

Goal:

Prove the SDK is infrastructure by shipping runnable, opinionated examples that users can copy into real products.

This slice starts only after slices 1-4 are green. Provider and memory examples can wait until their slices are green.

Example set:

- `examples/cookbook/quickstart`: minimal `run()` and `query()` usage with typed result and streamed events.
- `examples/cookbook/job-dashboard`: local web dashboard showing `AgentJob` list, summary, stale/replayable jobs, stop/replay actions, and batch IDs.
- `examples/cookbook/agent-kanban`: task board where each card maps to a durable job or batch task.
- `examples/cookbook/coding-agent-cli`: CLI wrapper around `createAgent()` with constrained toolsets, workflow mode, max concurrency, and job summary.
- `examples/cookbook/skills-workflow`: filesystem skill loading plus lifecycle workflow skills.
- `examples/cookbook/eval-loop`: fixed KPI/evaluation loop with keep/discard decision.
- `examples/cookbook/doctor-benchmark`: readiness and benchmark report for CI.

Required standards:

- Each example has a `README.md`.
- Each example has a minimal command to run.
- Each example uses public APIs only.
- Examples should be smoke-testable through `npm run test:all` or a dedicated example smoke script.
- Examples must not require real provider keys unless clearly marked optional.
- Offline examples should use deterministic fake providers where possible.

Acceptance gates:

- Existing top-level examples still run.
- New cookbook examples compile.
- Smoke tests cover at least quickstart, job-dashboard server boot, coding-agent-cli help, skills-workflow, eval-loop, and doctor-benchmark.
- README links point to working files.
- `npm run build`
- Example smoke tests.
- `npm test`

Stop conditions:

- Stop if examples depend on private internals.
- Stop if examples require paid/network provider access for basic smoke tests.
- Stop if docs claim capabilities not backed by implemented APIs.

## Slice 9: Public Adoption Polish

Goal:

Make the product easy to evaluate and adopt.

Deliverables:

- Update root README with product positioning:
  - controlled runtime
  - durable jobs
  - skills/workflows
  - evaluation loops
  - cookbook examples
  - doctor/benchmark
- Add an “Which API should I use?” section:
  - `run()` for simple task execution
  - `query()` for streaming UI
  - `createAgent()` for production orchestration
  - `AgentJob` APIs for background work
  - skills for reusable prompt-as-program workflows
- Add compatibility matrix:
  - Node version
  - ESM/TypeScript support
  - provider support
  - browser/server boundaries
  - offline/test mode
- Add reliability guarantees and non-guarantees:
  - what is durable
  - what is replayable
  - what cannot resume after process death
  - how cancellation works
- Add migration notes for existing users.

Acceptance gates:

- README does not overclaim.
- Docs match tested public APIs.
- Package payload includes referenced example/docs files where expected.
- `npm run build`
- `npm test`

## Clavue Execution Rules

Clavue should follow this operating contract:

- Work one slice at a time.
- Start with tests where practical.
- Keep changes additive and narrow.
- Do not implement provider taxonomy until Slice 5 approval.
- Do not start cookbook examples until slices 1-4 pass.
- Run required gates after each slice.
- Report changed files, test commands, and any skipped gate.
- Stop immediately if a stop condition is hit.

## Codex Review Checklist After Each Slice

Codex should review:

- Does the implementation preserve compatibility?
- Are public types exported and package payload tests updated?
- Are safety constraints enforced in code?
- Are tests deterministic and meaningful?
- Does the slice avoid hidden scope creep?
- Are docs/examples truthful about what is implemented?
- Are Cursor-style examples proving infrastructure, not just showing syntax?

## Immediate Instruction Packet For Clavue

Start with Slice 1 only.

Task:

Implement explicit per-run tool concurrency and additive trace metadata.

Hard constraints:

- Do not edit provider code.
- Do not implement job batch, job summary, team integration, or cookbook examples yet.
- Preserve current `AGENT_SDK_MAX_TOOL_CONCURRENCY` behavior.
- Keep mutating tools serial.
- Preserve existing `concurrency_batches`.

Required gates:

- `npm run build`
- `npx tsx --test tests/permissions.test.ts tests/benchmark.test.ts`
- `npm test`

Report back with:

- Files changed.
- Public API names added.
- Trace fields added.
- Test results.
- Any risk or unresolved design question.
