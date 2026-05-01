# Clavue Version Upgrade Plan

Last updated: 2026-04-30

Baseline package version: `0.6.1`

## Purpose

This document records the next version upgrade plan for `clavue-agent-sdk` after a full repository pass over the runtime, tools, providers, memory, jobs, CLI, docs, and tests.

The SDK already has many strong primitives. The next upgrade should not focus on adding more isolated tools. It should make the current runtime feel mature, predictable, recoverable, and easy to embed in real applications.

## Current Baseline

The current codebase already includes:

- In-process APIs: `run()`, `query()`, `createAgent()`, and `Agent`.
- Provider abstraction for Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses-style models.
- Built-in tool registry, named toolsets, tool safety annotations, permission modes, and read-only tool concurrency.
- Runtime profiles for `collect`, `organize`, `plan`, `solve`, `build`, `verify`, `review`, and `ship`.
- Structured `AgentRunResult` with usage, cost, events, trace, evidence, quality gates, and errors.
- Durable `AgentJob` records with heartbeat, stale detection, cancellation, replay helper, and job tools.
- Skills, bundled workflow skills, filesystem skill loading, validation, and forked skill jobs.
- Memory store, memory injection, basic memory trace, session persistence, self-improvement, and retro/eval modules.
- `doctor()` and `runBenchmarks()` APIs with deterministic tests.
- CLI entrypoint and package payload regression tests.

The 2026-04-29 plan in `docs/clavue-current-upgrade-execution-plan.md` is partially stale: explicit per-run tool concurrency and trace metadata are already implemented in the current codebase.

## Main Maturity Gaps

### 1. Interaction Is Still Primitive-Oriented

The SDK exposes tools, profiles, skills, and events, but the user-facing work loop is not yet a first-class interaction state machine.

Current gaps:

- No stable run phase model such as `intake`, `inspect`, `plan`, `act`, `verify`, `review`, `handoff`.
- `AskUserQuestion` returns a non-interactive fallback string instead of emitting a structured pending-input event that a UI can own.
- CLI output is mostly assistant text plus `[tool]` logs; it does not expose progress, phases, gates, job state, or policy decisions in a human-friendly way.
- Workflow profiles add prompts and options, but do not yet create a consistent visible interaction pattern for all hosts.
- Recovery after blocked tools, failed gates, stale jobs, or missing user input is not standardized.

Target behavior:

- Hosts can render the run as an explicit state machine without parsing prose.
- The agent asks fewer, better questions and only when the runtime classifies ambiguity or risk.
- Every run can end with a typed reason, required next action, and evidence-backed handoff.

### 2. Safety Is Better, But Not Complete

Permission modes and tool safety annotations now exist, but policy trace and enforcement still need more depth.

Current gaps:

- Permission trace only records denials, not every decision with source, behavior, risk, timestamp, and input summary.
- Built-in file tools resolve paths against `cwd`, but there is no central workspace containment policy enforced across all file, shell, MCP, and job paths.
- `Bash` is intentionally high-risk and approval-required, but destructive command detection, command classification, output redaction, and shell sandbox wiring are still shallow.
- MCP tools default to unsafe, non-read-only wrappers because the SDK cannot classify MCP tool safety yet.
- Network tools do not have domain allow/deny policy, citation/provenance requirements, or prompt-injection isolation.

Target behavior:

- Tool safety is decided by runtime policy, not only by prompt wording.
- All high-impact actions have explicit audit records.
- SDK users can choose local-dev, CI, SaaS, or serverless safety profiles with predictable behavior.

### 3. Jobs Are Durable Records, Not Yet Durable Execution

`AgentJob` is the correct durable substrate, but background execution is still in-process.

Current gaps:

- A process crash marks queued/running jobs stale; it does not resume execution.
- Job replay exists, but replay does not yet persist enough normalized execution context for safe process-restart recovery.
- There is no first-class batch helper for launching multiple correlated background subagents.
- There is no public job summary API for dashboards, doctor checks, or CI.
- Teams and messages are process-local coordination primitives, not durable job-backed workflows.

Target behavior:

- Long-running work can be listed, summarized, cancelled, replayed, and eventually resumed by a worker.
- Batch and team concepts are views over `AgentJob`, not separate orchestration stores.

### 4. Event And Result Schemas Need Stability

The SDK has useful events and result artifacts, but external UI and CI consumers need explicit compatibility.

Current gaps:

- `CONTROLLED_EXECUTION_CONTRACT_VERSION` exists, but individual event/result/trace payloads do not carry schema version metadata.
- Public docs do not fully specify event ordering, terminal states, error subtypes, or compatibility promises.
- No golden event trace fixtures protect the public streaming contract.
- `system:init` does not yet report real MCP connection status because engine config receives tools but not MCP connection details.

Target behavior:

- UI builders can depend on stable event schemas.
- Breaking event changes require a version bump or compatibility shim.
- Golden traces catch accidental API drift.

### 5. Memory Is Auditable, But Not Yet Trustworthy Enough

Memory retrieval is now visible, but not mature enough for high-trust production workflows.

Current gaps:

- Scoring is simple lexical matching with limited relevance explanation.
- Trace lacks retrieval IDs, duration, store identity, filters, stale markers, score components, conflict markers, and redaction status.
- `brainFirst` means pre-model retrieval, but not a stricter reasoning contract with fallback behavior when memory is missing or stale.
- Memory validation lifecycle is limited to `lastValidatedAt`; there is no explicit `observed`, `reused`, `confirmed`, `stale`, or `rejected` state.
- Session summary memory is still too close to last-exchange capture and not a structured rolling session intelligence artifact.

Target behavior:

- Memory is treated as evidence with provenance and freshness, not as silently trusted prompt text.
- Hosts can debug why a memory was selected and whether it is safe to reuse.

### 6. Skills Need Enforcement, Not Just Metadata

Skill authoring and loading are present, but skill execution still needs stronger runtime guarantees.

Current gaps:

- Skill preconditions are validated as metadata but are not automatically blocking.
- Required artifacts and quality gates are not universally enforced unless the caller wires `qualityGatePolicy`.
- Skill activation trace is not a first-class final artifact with inputs, selected skill, enforcement status, and outputs.
- Skill hooks and compatibility constraints are not fully integrated into the engine lifecycle.
- There are no golden examples showing how hosts should create, validate, load, run, and gate a production skill.

Target behavior:

- A skill can declare what must be true before it runs and what evidence must exist before it succeeds.
- Skill failure is machine-readable and recoverable.

### 7. Provider Layer Is Functional, But Still Too Coarse

Provider normalization works, but production hosts need more precise model and error behavior.

Current gaps:

- Error taxonomy lacks `unsupported_capability`, `content_filter`, `context_overflow`, `tool_protocol_error`, and `provider_conversion_error`.
- There is no preflight check that blocks unsupported model/tool/thinking/image/json-schema combinations before a provider request.
- Provider-level streaming is not implemented; event streaming only starts after each full provider response.
- Retry, fallback, and circuit-breaker policy are not configurable enough for production hosts.
- Capability/pricing data is manually inferred and should be documented as conservative, not authoritative.

Target behavior:

- Unsupported capability errors are detected early and normalized.
- Hosts can route by capability, cost, latency, and fallback policy.

### 8. Context Packing Needs Budgeted Trace

Context utilities exist, but default prompt assembly in `QueryEngine` is still mostly concatenation.

Current gaps:

- No central context section budget for system instructions, tool guidance, project docs, git, memory, and user context.
- Context trace does not explain included, dropped, or truncated sections.
- Project context can include large instruction files without enough section-level budget reporting.
- Tool prompt fragments are bounded globally, but not part of a full context budget planner.

Target behavior:

- Every provider call has an inspectable context plan.
- Hosts can see what context was included, truncated, dropped, and why.

### 9. Observability Needs Production Integrations

Trace, evidence, and gates exist, but operational integration is still early.

Current gaps:

- No OpenTelemetry or host telemetry sink abstraction.
- Tool trace lacks input/output size summaries, timeout status, policy source, and artifact references.
- Hook timing and queue time are not separated from provider and tool timing.
- Large outputs are truncated inline instead of becoming artifact references with metadata.
- No redacted structured log helper is exported for production hosts.

Target behavior:

- Runs can be visualized in dashboards and compared across versions without parsing assistant text.

### 10. Docs And Examples Lag The Runtime

The code has advanced faster than the public onboarding path.

Current gaps:

- README mentions many capabilities but does not provide complete production recipes for workflow modes, quality gates, doctor, benchmarks, jobs, memory trace, or skill loading.
- CLI help does not expose workflow mode, memory options, max concurrency, budget, fallback model, doctor, benchmark, or job operations.
- Examples are numerous, but not organized as a cookbook for production host patterns.
- Existing roadmap docs overlap and some are stale.

Target behavior:

- A new user can choose one of three paths: simple run, streaming UI, or production worker.
- Roadmaps separate current baseline, next executable todo, and long-term vision.

## Version Upgrade Strategy

The recommended upgrade path is `0.7 -> 0.8 -> 0.9 -> 1.0`.

Do not jump to a `1.0` release until interaction state, policy traces, event schemas, and job operability are stable enough for external hosts.

## Autonomous Development Layer

Modern frontier models can make routine implementation decisions better than a constant confirmation loop. The SDK should therefore provide an explicit autonomy control:

- `supervised`: ask before broad or branching choices, but still proceed on obvious safe steps.
- `proactive`: default for most workflows; inspect, decide, execute, verify, and ask only for real ambiguity or risk.
- `autonomous`: development-fast mode for trusted coding work; execute todo/P0-P3 slices proactively inside the configured permission and tool boundaries.

This is not a permission bypass. `autonomyMode` controls initiative and confirmation behavior; `permissionMode`, `allowedTools`, `disallowedTools`, hooks, and host policy still decide what can actually run.

Hosts should expose `autonomyMode` separately from `permissionMode`:

- Use `autonomyMode: autonomous` plus `permissionMode: trustedAutomation` for trusted development sessions where the user has already delegated implementation and verification.
- Use `autonomyMode: autonomous` plus `permissionMode: acceptEdits` for lower-risk local edit automation without shell or network access.
- Use `autonomyMode: proactive` for normal assistants that should continue work but ask on real ambiguity.
- Use `autonomyMode: supervised` for planning, review, shipping, and broad product decisions.

Every tool permission decision should be auditable through `AgentRunTrace.policy_decisions`, including allowed and denied calls, source, permission mode, autonomy mode, safety summary, and a redacted input summary. The older `permission_denials` field remains for compatibility.

## Autonomous Issue Workflow Layer

The `smallnest/autoresearch` repository validates a useful product direction: issue-driven autonomous development should be a first-class workflow, not just a prompt convention. Its shell-first implementation is not a direct fit for this SDK, but the loop is valuable:

- issue intake
- implementation agent
- rotating review/fix agents
- deterministic gates
- evaluator score
- bounded resume/retry
- optional PR handoff

For this SDK, the better implementation is a typed, provider-agnostic workflow over existing primitives:

- normalize local/GitHub/inline issues into an `IssueWorkflowInput`
- create builder, reviewer, fixer, and verifier `AgentJob` records under one correlation ID
- reuse `autonomyMode`, `permissionMode`, runtime profiles, quality gates, and `policy_decisions`
- store a small issue workflow run record that references job IDs instead of duplicating execution state
- expose a programmatic API first, then CLI subcommands

The full design is tracked in `docs/autonomous-issue-workflow-upgrade-plan.md`.

This layer should not ship before policy trace, job summary, job batch, and basic CLI operability are stable. It should not make push, PR creation, merge, issue close, release, or deploy automatic. Those are separate external-state steps requiring explicit tools and host policy.

Calibration rule:

- Proceed when the task is clear, the action is reversible/local, and the available tools authorize the work.
- Choose the best technical path from code context, tests, risk, compatibility, and verification evidence.
- Stop only for destructive data loss, publishing/deployment/tagging, credential exposure, legal/compliance ambiguity, real spending, or mutually exclusive product decisions that cannot be inferred from local context.

## Version 0.7: Stabilize Runtime Contracts

Theme: make the existing runtime easier to trust without broad rewrites.

Primary deliverables:

- Add explicit schema version constants for SDK events, final results, traces, memory trace, and job records.
- Add run phase/status events that can drive UIs: `intake`, `context`, `model`, `tool`, `verify`, `finalize`.
- Add richer policy decision trace for both allow and deny decisions.
- Add job summary API over `AgentJob` records.
- Add first-class background subagent batch helper with shared correlation metadata.
- Update docs to mark completed foundations and remove stale "next slice" assumptions.

Acceptance gates:

- Public exports and package payload tests cover new schema constants and job summary APIs.
- Golden event trace tests protect event shape and ordering.
- Existing `npm test` and `npm run build` pass.

## Version 0.8: Improve Interaction And Operability

Theme: make the SDK feel like a product runtime, not only a primitive library.

Primary deliverables:

- Add a structured interaction state machine and typed pending-input event.
- Expand CLI with `--workflow-mode`, `--max-tool-concurrency`, `--max-budget-usd`, `--fallback-model`, `doctor`, `benchmark`, and job list/get/stop commands.
- Add job batch dashboard/cookbook example.
- Add stale-job recovery guidance in `doctor()`.
- Add context-pack trace: included/dropped/truncated sections and estimated tokens.
- Add production recipes for `run()`, `query()`, `createAgent()`, workflow modes, quality gates, and memory trace.

Acceptance gates:

- CLI parser tests cover all new flags and subcommands.
- UI-oriented event tests cover pending input, phase transitions, tool start/result, job notifications, and final result.
- Docs include copy-pasteable production recipes.

## Version 0.9: Harden Safety, Memory, And Skills

Theme: close the highest-risk production gaps before API freeze.

Primary deliverables:

- Add workspace containment policy for file tools and shell cwd behavior.
- Add shell command classification and destructive-command warnings before execution.
- Add MCP tool safety classification overrides and collision policy.
- Add network/domain allowlist and prompt-injection guidance for web tools.
- Add rich memory trace with retrieval ID, duration, store, filters, stale/conflict markers, score components, and redaction status.
- Add memory validation lifecycle.
- Enforce skill preconditions, required artifacts, and required gates as runtime blockers.
- Add unsupported capability preflight and provider error taxonomy expansion.

Acceptance gates:

- Safety tests prove disallowed writes, shell, MCP, and network operations cannot bypass policy through subagents, skills, or jobs.
- Memory retrieval fixtures include stale, conflicting, and distractor memories.
- Skill tests prove missing preconditions and required artifacts fail deterministically.

## Version 1.0: Public API Freeze And Production Release

Theme: formalize compatibility and production support.

Primary deliverables:

- Publish stable event/result/trace/job/memory schema docs.
- Add migration guide from `0.6.x` and `0.7-0.9`.
- Add compatibility tests for public APIs and golden traces.
- Add production cookbook examples for CI, streaming UI, background worker, skill pack, MCP integration, and memory-backed assistant.
- Add telemetry sink interface and redacted structured log helper.
- Define deprecation policy and semver rules.

Acceptance gates:

- No unversioned public event/result shape changes.
- README and examples cover all primary integration modes.
- Full test suite, build, package dry run, and focused cookbook smoke tests pass.

## Non-Goals For The Next Two Minor Releases

- Do not add a second durable orchestration primitive beside `AgentJob`.
- Do not publish a `1.0` label just because the feature count is high.
- Do not add many more built-in tools before policy, schema, jobs, and docs are stable.
- Do not rely on live model calls for core regression tests.
- Do not make performance claims without deterministic benchmark evidence.

## Recommended Control Documents

Use this document as the version-level plan.

Use `docs/version-upgrade-todolist.md` as the executable task list.

Keep `docs/agent-sdk-capability-upgrade-program.md` as the long-term product direction, but update stale execution docs after the next implementation slice lands.
