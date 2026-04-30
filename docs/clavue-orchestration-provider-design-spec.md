# Clavue Orchestration And Provider Design Spec

Last updated: 2026-04-29

## Purpose

This document converts the latest worker findings into a Clavue-facing development plan.

Status: design/spec handoff only. Do not implement until the user explicitly approves development from this spec.

## Worker Findings To Preserve

Scope worker findings:

- The true durable orchestration primitive is background `AgentJob`.
- Current teams and messages are shallow and mostly in-memory.
- Safe next implementation order is:
  - Configurable tool concurrency.
  - Background subagent batch helper.
  - Job progress summary.
  - Team-to-job integration.

Test worker findings:

- RED tests exist in an isolated worktree for provider capability exports and normalized `unsupported_capability` errors.
- Do not merge those tests yet.
- Treat them as acceptance fixtures after design approval.

Code worker findings:

- Provider work should remain design-only for now.
- No provider edits until capability/fallback/error taxonomy is approved.

## Design Gate

This gate is active.

Do not:

- Merge isolated RED tests.
- Edit provider implementation.
- Change public provider API.
- Change engine fallback behavior.
- Rework teams/messages into durable primitives.
- Start broad v2 autonomous orchestration.

Allowed before approval:

- Read code.
- Draft specs.
- Produce task packets.
- Identify acceptance tests.
- Propose API names.

Allowed after approval:

- Implement the approved slice only.
- Add focused tests for that slice.
- Run required gates.
- Stop on failing focused gates.

## Core Architecture Decision

`AgentJob` is the durable orchestration substrate.

Teams and messages should be treated as coordination adapters, not durable execution state.

This means:

- Long-running work must become an `AgentJob`.
- Background subagents must be represented as `AgentJob` records.
- Progress summaries should aggregate `AgentJob` records.
- Team views should reference jobs rather than own durable execution state.
- Cancellation, stale detection, replay, evidence, gates, and trace should live on jobs.

Do not build a second durable orchestration model for teams/messages.

## Product Principle

The `karpathy/autoresearch` lesson is controlled repeatability:

- One constrained action surface.
- One measurable loop.
- One durable record of attempts.
- One clear keep/discard decision.
- Human-controlled budgets and approval points.

For `clavue-agent-sdk`, the durable record is `AgentJob`.

## Target V1 Orchestration Contract

V1 orchestration should provide:

- Bounded foreground tool execution.
- Configurable read-only tool fan-out.
- Serial mutation execution.
- Background subagent batches represented as durable jobs.
- Job progress summary suitable for UI and CI.
- Team views backed by jobs.
- Parent-to-child inheritance for policy, tools, model, budget, cwd, runtime namespace, and trace IDs.
- No claim that in-flight model/tool execution can resume after process death unless it truly can.

## Target Provider Contract

Provider design remains separate from orchestration.

Provider V1 should provide:

- Deterministic model capability lookup.
- Conservative unknown-model behavior.
- Stable normalized provider error categories.
- Explicit `unsupported_capability` behavior.
- Fallback eligibility rules.
- Tests proving OpenAI-compatible and Anthropic-compatible behavior where possible.

Do not edit provider code until the provider contract below is approved.

## Slice A: Configurable Tool Concurrency

Status: first safe implementation slice after spec approval.

Goal:

Make tool execution concurrency explicit, bounded, and traceable without changing existing safe defaults.

Required design:

- Add per-run option for max tool concurrency if not already sufficient.
- Preserve read-only concurrency.
- Preserve serial execution for mutating tools.
- Preserve environment variable behavior if already present.
- Add trace metadata showing configured limit and actual batch sizes.
- Ensure workflow profiles can later set concurrency without redesign.

Likely files:

- `src/types.ts`
- `src/engine.ts`
- `src/agent.ts`
- `tests/permissions.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Default behavior remains compatible.
- Invalid concurrency values fall back safely.
- Read-only tools never exceed configured limit.
- Mutating tools still run serially.
- Trace exposes configured and observed concurrency.
- `npm run build`
- `npx tsx --test tests/permissions.test.ts tests/benchmark.test.ts`
- `npm test`

Stop conditions:

- Stop if this requires provider changes.
- Stop if concurrency can reorder mutating tools.
- Stop if trace semantics become ambiguous.

## Slice B: Background Subagent Batch Helper

Goal:

Create a helper/API for launching multiple background subagents as durable `AgentJob`s.

Required design:

- Input is a list of subagent task specs.
- Each task creates one `AgentJob`.
- Parent policy, model, API type, allowed/disallowed tools, cwd, runtime namespace, and budgets are inherited unless explicitly narrowed.
- The helper returns job IDs and a summary object.
- No separate durable batch store unless necessary; batch can be reconstructed from job metadata.
- Include a correlation ID or batch ID in job metadata.

Likely files:

- `src/agent-jobs.ts`
- `src/tools/agent-tool.ts`
- `src/tools/agent-job-tools.ts`
- `src/types.ts`
- `src/index.ts`
- New `tests/agent-job-batch.test.ts` or focused additions to `tests/permissions.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- Batch helper creates one durable job per subagent task.
- Jobs inherit parent policy and runtime namespace.
- Jobs include batch/correlation metadata.
- Cancellation still works per job.
- Stale detection still works per job.
- Package exports include public helper/types if public.
- `npm run build`
- Focused job tests.
- `npm test`

Stop conditions:

- Stop if implementation starts creating a second durable batch database.
- Stop if jobs can escape parent policy.
- Stop if write-scope conflicts are not represented or documented.

## Slice C: Job Progress Summary

Goal:

Expose a durable, UI-friendly summary of job progress.

Required design:

- Summary aggregates job status counts.
- Summary includes active, queued, completed, failed, cancelled, stale, and replayable counts where available.
- Summary includes latest heartbeat, latest update timestamp, evidence count, quality gate count, and error summaries.
- Summary can filter by runtime namespace, parent run, batch ID, or team ID if available.
- Summary must not parse assistant prose as authoritative status.

Likely files:

- `src/agent-jobs.ts`
- `src/tools/agent-job-tools.ts`
- `src/types.ts`
- `src/doctor.ts`
- `src/index.ts`
- `tests/doctor.test.ts`
- Focused job summary tests
- `tests/package-payload.test.ts`

Acceptance gates:

- Summary is deterministic in temp-dir fixtures.
- Stale jobs are represented clearly.
- Failed jobs include error summaries.
- Evidence and gate counts are exposed.
- Doctor can surface stale job summary warnings.
- `npm run build`
- Focused job and doctor tests.
- `npm test`

Stop conditions:

- Stop if summary requires reading live process internals.
- Stop if summary relies on natural-language output.

## Slice D: Team-To-Job Integration

Goal:

Make teams a view/coordinator over durable jobs rather than a separate durable execution primitive.

Required design:

- Team task execution should create or reference `AgentJob`s.
- Team messages can remain lightweight/in-memory unless explicitly persisted later.
- Team status should aggregate referenced jobs.
- Team cancellation should cancel referenced jobs where authorized.
- Team output should point to job evidence, traces, gates, and outputs.

Likely files:

- `src/tools/team-tools.ts`
- `src/tools/send-message.ts`
- `src/agent-jobs.ts`
- `src/types.ts`
- `tests/permissions.test.ts`
- New focused team/job tests if needed

Acceptance gates:

- Existing team tools remain compatible.
- Team-created work is inspectable through job APIs.
- Team cancellation maps to job cancellation.
- Team status does not diverge from job status.
- Namespace isolation is preserved.
- `npm run build`
- Focused team/job tests.
- `npm test`

Stop conditions:

- Stop if this requires durable team storage before job integration.
- Stop if messages become a second source of truth for execution status.

## Provider Capability And Fallback Design

Status: design only until approved.

### Required Public Concepts

Provider/model capability contract should represent:

- Model ID.
- Normalized model ID.
- API type.
- Transport.
- Known/unknown status.
- Tool support.
- Image support.
- Thinking/reasoning support.
- JSON/schema support.
- Streaming support.
- Context window when known.
- Pricing when known.
- Fallback eligibility.

### Required Error Taxonomy

Provider errors should normalize to stable categories.

Required categories include:

- `authentication`
- `authorization`
- `rate_limit`
- `timeout`
- `aborted`
- `unsupported`
- `unsupported_capability`
- `provider_error`
- `invalid_request`
- `unknown`

`unsupported_capability` should mean:

- The requested capability is not supported by the selected model/provider/transport.
- The error is not a transient retry target.
- Fallback may be allowed only if a configured fallback model is known to support the capability.

### Fallback Rules

Fallback should be explicit and conservative:

- Use fallback for transient provider failures when retry policy allows it.
- Do not fallback after cancellation.
- Do not fallback for auth/authorization errors.
- Do not fallback for prompt-too-long unless a specific fallback has a larger known context window and policy allows it.
- Do not fallback for unsupported capability unless fallback is capability-compatible.
- Record fallback attempt in trace.

### RED Test Handling

The isolated RED tests from test-worker should be treated as design acceptance fixtures.

Do not merge them until:

- Provider contract is approved.
- API names are accepted.
- Error category names are accepted.
- Fallback rules are accepted.

After approval:

- Move RED tests into the main test suite intentionally.
- Make them pass with minimal provider changes.
- Run provider-focused gates and full `npm test`.

Likely files after approval:

- `src/providers/types.ts`
- `src/providers/capabilities.ts`
- `src/providers/index.ts`
- `src/providers/openai.ts`
- `src/providers/anthropic.ts`
- `src/types.ts`
- `src/engine.ts`
- `tests/openai-provider.test.ts`
- `tests/model-fallback.test.ts`
- `tests/package-payload.test.ts`

Provider acceptance gates after approval:

- Capability helpers are exported.
- Unknown models return conservative capabilities.
- Unsupported capabilities produce normalized `unsupported_capability`.
- Fallback is blocked for unsupported capability unless fallback supports capability.
- Cancellation never triggers fallback.
- Existing provider behavior remains compatible.
- `npm run build`
- `npx tsx --test tests/openai-provider.test.ts tests/model-fallback.test.ts tests/package-payload.test.ts`
- `npm test`

## Review Checklist For Clavue

Before starting any implementation:

- Confirm the active slice.
- Confirm write scope.
- Confirm focused test command.
- Confirm no design gate blocks the slice.
- Confirm no RED tests are being merged prematurely.

Before final response:

- Run `npm run build`.
- Run focused tests.
- Run `npm test` if focused tests pass.
- Report exact pass/fail counts.
- Report changed files.
- Report public API names.
- Report residual risks.

## First Packet After Approval

Use this only after the user approves implementation from this spec:

```text
Controller packet for /Users/lu/openagent/open-agent-sdk-typescript.

Mission: implement Slice A from docs/clavue-orchestration-provider-design-spec.md: Configurable Tool Concurrency.

Do not edit provider files. Do not merge isolated RED tests. Do not touch docs. Do not publish, tag, commit, or push.

Read docs/clavue-orchestration-provider-design-spec.md first. Follow Slice A scope, acceptance gates, and stop conditions exactly.

Required gates:
- npm run build
- npx tsx --test tests/permissions.test.ts tests/benchmark.test.ts
- npm test if focused gates pass

Final response must include Verdict, changed files, public API names, test results with pass/fail counts, residual risks, and next recommended slice.
```
