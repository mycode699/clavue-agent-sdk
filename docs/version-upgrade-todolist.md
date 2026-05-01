# Version Upgrade TODO List

Last updated: 2026-04-30

This TODO list executes `docs/version-upgrade-plan.md`. It is intentionally concrete and test-oriented.

## Ground Rules

- Keep changes additive unless a breaking change is explicitly scheduled for `1.0`.
- Add or update deterministic tests for every runtime behavior change.
- Prefer stub providers and temp directories over live model or network calls.
- Do not create another durable orchestration store; use `AgentJob`.
- Do not update `dist/` by hand.
- Do not publish, tag, commit, or bump package version unless explicitly requested.

## P0: Version 0.7 Contract Stabilization

### 0.7.1 Event And Schema Versioning

- [ ] Add exported constants for public schema versions:
  - [ ] `SDK_EVENT_SCHEMA_VERSION`
  - [ ] `AGENT_RUN_RESULT_SCHEMA_VERSION`
  - [ ] `AGENT_RUN_TRACE_SCHEMA_VERSION`
  - [ ] `AGENT_JOB_RECORD_SCHEMA_VERSION`
  - [ ] `MEMORY_TRACE_SCHEMA_VERSION`
- [ ] Add additive `schema_version` or equivalent metadata to final `result` events and `AgentRunResult`.
- [ ] Add additive schema metadata to job records without breaking existing stored jobs.
- [ ] Update `getControlledExecutionContract()` to include schema version constants.
- [ ] Add package payload assertions for exported constants and types.
- [ ] Add golden event fixture tests for a simple text-only run and a one-tool run.

Preferred files:

- `src/types.ts`
- `src/runtime-profiles.ts`
- `src/engine.ts`
- `src/agent.ts`
- `src/agent-jobs.ts`
- `src/index.ts`
- `tests/permissions.test.ts`
- `tests/package-payload.test.ts`
- New `tests/event-schema.test.ts`

Acceptance gates:

- [ ] Existing consumers can ignore the new fields.
- [ ] Golden event tests are deterministic.
- [ ] `npm run build`
- [ ] `npm test`

### 0.7.2 Run Phase Events

- [ ] Add typed phase/status values for the run lifecycle:
  - [ ] `intake`
  - [ ] `context`
  - [ ] `model_request`
  - [ ] `model_response`
  - [ ] `tool_execution`
  - [ ] `verification`
  - [ ] `finalize`
- [ ] Emit phase/status events without flooding the stream.
- [ ] Include `run_id`, `session_id`, `turn`, and optional `tool_use_id` where applicable.
- [ ] Preserve current event stream behavior for existing users.
- [ ] Add tests for phase order around a one-tool run.

Preferred files:

- `src/types.ts`
- `src/engine.ts`
- `src/agent.ts`
- `tests/event-schema.test.ts`

Acceptance gates:

- [ ] UIs can show progress without parsing assistant text.
- [ ] Phase events remain additive and optional.
- [ ] `npm test`

### 0.7.2a Autonomous Development Calibration

- [x] Add explicit `autonomyMode`: `supervised`, `proactive`, and `autonomous`.
- [x] Wire autonomy mode into runtime profiles.
- [x] Inject calibrated autonomy instructions into the engine system prompt.
- [x] Expose `CLAVUE_AGENT_AUTONOMY` and `--autonomy`.
- [x] Report autonomy mode in `system:init`.
- [x] Add public README examples for low-confirmation development workflows.
- [x] Add policy-decision trace so autonomy choices can be audited alongside tool permission decisions.

Acceptance gates:

- [x] Autonomy mode does not bypass `permissionMode`, `allowedTools`, `disallowedTools`, or host `canUseTool`.
- [x] Autonomous mode tells the agent to execute todo/P0-P3 safe slices proactively.
- [x] Prompt calibration includes explicit stop conditions for destructive or externally visible actions.
- [x] Full docs explain when to use each autonomy level.

### 0.7.3 Policy Decision Trace

- [x] Add structured policy decision trace entries for allowed and denied tools.
- [x] Include tool name, behavior, reason, source, timestamp, permission/autonomy mode, safety summary, and safe input summary.
- [x] Keep `permission_denials` for backward compatibility.
- [x] Ensure host `canUseTool` cannot override built-in denials.
- [x] Add subagent and skill inheritance tests for policy trace.

Preferred files:

- `src/types.ts`
- `src/engine.ts`
- `src/agent.ts`
- `src/tools/agent-tool.ts`
- `tests/permissions.test.ts`
- `tests/runtime-isolation.test.ts`

Acceptance gates:

- [x] Denials are still visible in old `permission_denials`.
- [x] Full decision trace is available in `AgentRunTrace`.
- [x] No sensitive raw tool input is persisted by default.
- [x] `npm test`

### 0.7.4 AgentJob Summary API

- [ ] Add `summarizeAgentJobs()` over existing job records.
- [ ] Include total jobs, counts by status, stale count, replayable count, failed count, cancelled count, latest heartbeat, latest update, evidence count, quality gate count, and error summaries.
- [ ] Support filtering by runtime namespace and future batch/correlation ID.
- [ ] Expose a corresponding `AgentJobSummary` type.
- [ ] Add `AgentJobSummaryTool` only if it provides clear value beyond API use.
- [ ] Integrate stale/replayable summary into `doctor()`.

Preferred files:

- `src/agent-jobs.ts`
- `src/tools/agent-job-tools.ts`
- `src/doctor.ts`
- `src/types.ts`
- `src/index.ts`
- New `tests/agent-jobs.test.ts`
- `tests/doctor.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- [ ] Summary uses records as source of truth and does not duplicate state.
- [ ] Summary is deterministic in temp-dir fixtures.
- [ ] Doctor reports actionable stale/replayable counts.
- [ ] `npm run build`
- [ ] `npm test`

### 0.7.5 Background Subagent Batch Helper

- [ ] Add a public helper for launching multiple background subagents as `AgentJob` records.
- [ ] Add `batch_id` or `correlation_id` metadata to each created job.
- [ ] Each task must create exactly one `AgentJob`.
- [ ] Inherit parent cwd, model, provider/API type, runtime namespace, tool policy, allowed tools, disallowed tools, max turns, and budget unless explicitly narrowed.
- [ ] Return structured batch summary with job IDs and counts.
- [ ] Document write-scope conflict risk for multi-agent editing.

Preferred files:

- `src/agent-jobs.ts`
- `src/tools/agent-tool.ts`
- `src/tools/agent-job-tools.ts`
- `src/types.ts`
- `src/index.ts`
- New `tests/agent-job-batch.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- [ ] Child jobs cannot escape parent policy.
- [ ] Batch IDs appear in list/get/summary APIs.
- [ ] Cancellation remains per job.
- [ ] No second batch database is introduced.
- [ ] `npm test`

## P1: Version 0.8 Interaction And Operability

### 0.8.0 Autonomous Issue Workflow Design

- [x] Analyze `smallnest/autoresearch` and extract transferable workflow ideas.
- [x] Create a typed SDK-native upgrade plan in `docs/autonomous-issue-workflow-upgrade-plan.md`.
- [ ] Decide whether issue workflow run records default to project `.clavue/issue-runs` or user `~/.clavue-agent-sdk/issue-runs`.
- [ ] Decide whether GitHub support is core, optional tool package, or host adapter documentation.
- [ ] Decide whether scoring reuses `retro` evaluators or a smaller issue-specific evaluator.

Acceptance gates:

- [x] Plan keeps `AgentJob` as the durable orchestration substrate.
- [x] Plan separates autonomy from permission bypass.
- [x] Plan keeps PR/merge/close/deploy as explicit external-state steps.

### 0.8.1 Structured Pending User Input

- [ ] Replace or supplement the `AskUserQuestion` fallback with a typed pending-input event.
- [ ] Add host handler support that can answer, decline, or time out.
- [ ] Include question ID, prompt, options, multiselect flag, default behavior, and timeout metadata.
- [ ] Keep non-interactive mode safe and explicit.
- [ ] Add CLI behavior for non-interactive and interactive terminals.

Preferred files:

- `src/tools/ask-user.ts`
- `src/types.ts`
- `src/engine.ts`
- `src/agent.ts`
- `src/cli.ts`
- `tests/permissions.test.ts`
- New `tests/interaction.test.ts`

Acceptance gates:

- [ ] UI hosts can render a pending question without parsing tool text.
- [ ] Non-interactive runs do not hang.
- [ ] `npm test`

### 0.8.2 CLI Upgrade

- [ ] Add `--workflow-mode`.
- [ ] Add `--max-tool-concurrency`.
- [ ] Add `--max-budget-usd`.
- [ ] Add `--fallback-model`.
- [x] Add `--permission-mode`.
- [ ] Add `doctor` subcommand.
- [ ] Add `benchmark` subcommand.
- [ ] Add `jobs list|get|stop|summary` subcommands.
- [ ] Improve normal CLI progress output using phase/status events.
- [ ] Keep `--json` machine-readable and backward compatible.

Preferred files:

- `src/cli.ts`
- `tests/package-payload.test.ts`
- New `tests/cli.test.ts`
- README

Acceptance gates:

- [ ] CLI parser tests cover new flags and subcommands.
- [ ] `node dist/cli.js --help` documents the new surface.
- [ ] `npm run build`
- [ ] `npm test`

### 0.8.3 Context Pack Trace

- [ ] Add a context planning trace with sections, source, estimated tokens, included/dropped/truncated status, and reason.
- [ ] Apply budgets across system instructions, tools, skills, project context, git context, memory, and user context.
- [ ] Replace ad hoc prompt concatenation in `buildSystemPrompt()` with a budgeted packer while preserving current content by default.
- [ ] Add tests for deterministic inclusion, truncation, and dropped-section reporting.

Preferred files:

- `src/engine.ts`
- `src/utils/context.ts`
- `src/utils/tokens.ts`
- `src/types.ts`
- `tests/context.test.ts`
- New `tests/context-pack-trace.test.ts`

Acceptance gates:

- [ ] Provider calls include equivalent or safer context than before.
- [ ] Trace explains why each context section was included or dropped.
- [ ] `npm test`

### 0.8.4 Docs And Cookbook Reorganization

- [ ] Update README with a concise "choose your integration mode" section.
- [ ] Add production recipes for:
  - [ ] One-shot `run()`
  - [ ] Streaming `query()` UI
  - [ ] Reusable `createAgent()`
  - [ ] Workflow modes
  - [ ] Quality gates
  - [ ] Memory trace
  - [ ] Background jobs
  - [ ] Skills loading
  - [ ] Doctor and benchmarks
- [ ] Add a docs index that distinguishes current docs, long-term roadmaps, and historical handoffs.
- [ ] Mark stale roadmap sections as superseded rather than deleting useful context.

Preferred files:

- `README.md`
- New `docs/cookbook/`
- Existing roadmap docs

Acceptance gates:

- [ ] New users can find the recommended path without reading every roadmap.
- [ ] Public docs no longer say explicit tool concurrency is future work.

### 0.8.5 Local Issue Workflow Normalizer

- [ ] Add `IssueWorkflowSource`, `IssueWorkflowInput`, `IssueWorkflowOptions`, `IssueWorkflowResult`, and related public types.
- [ ] Add `normalizeIssueWorkflowInput()` for inline objects and local Markdown files.
- [ ] Support optional Markdown frontmatter: `id`, `title`, `labels`, `writeScope`, `requiredGates`, and `acceptanceCriteria`.
- [ ] Validate missing file, invalid frontmatter, missing title/body, and path traversal errors.
- [ ] Export the API from `src/index.ts`.

Preferred files:

- `src/issue-workflow.ts`
- `src/index.ts`
- New `tests/issue-workflow.test.ts`
- README

Acceptance gates:

- [ ] Temp-dir tests cover valid local issue files.
- [ ] Invalid issue inputs produce typed errors.
- [ ] `npm run build`
- [ ] `npm test`

### 0.8.6 Issue Workflow Run Record

- [ ] Add small issue workflow run records that reference `AgentJob` IDs.
- [ ] Store role, iteration, status, issue metadata, required gates, passing score, final score, and errors.
- [ ] Add create/load/list helpers.
- [ ] Ensure run records cannot escape their configured store.
- [ ] Do not duplicate job output, trace, evidence, or quality gates.

Preferred files:

- `src/issue-workflow.ts`
- `src/types.ts`
- `tests/issue-workflow.test.ts`

Acceptance gates:

- [ ] Run records are deterministic JSON artifacts.
- [ ] `AgentJob` remains the source of truth for execution.
- [ ] `npm test`

### 0.8.7 Builder Reviewer Fixer Verifier Loop

- [ ] Add `runIssueWorkflow()` for a bounded local/inline issue workflow.
- [ ] Create builder, reviewer, fixer, and verifier jobs under one correlation ID.
- [ ] Enforce `maxIterations`.
- [ ] Collect job traces, evidence, quality gates, and policy decision summaries.
- [ ] Return `completed`, `failed_gate`, `failed_review`, `blocked_by_policy`, `max_iterations`, `cancelled`, or `error`.

Preferred files:

- `src/issue-workflow.ts`
- `tests/issue-workflow.test.ts`

Acceptance gates:

- [ ] Stub provider proves role order.
- [ ] Max iteration stop is deterministic.
- [ ] Policy denial returns `blocked_by_policy`.
- [ ] `npm test`

### 0.8.8 Issue Workflow Scoring And Gates

- [ ] Add `IssueWorkflowScore` and issue-specific gate summary.
- [ ] Combine deterministic quality gates with model/evaluator scoring.
- [ ] Fail missing required gates.
- [ ] Fail score below `passingScore`.
- [ ] Reuse `qualityGatePolicy`, `retro`, or `evaluation-loop` where practical without coupling the APIs too tightly.

Preferred files:

- `src/issue-workflow.ts`
- `src/evaluation-loop.ts`
- `src/retro/`
- `tests/issue-workflow.test.ts`

Acceptance gates:

- [ ] Missing required gate fails.
- [ ] Low score fails.
- [ ] Passing score and gates complete the run.
- [ ] `npm test`

### 0.8.9 Issue CLI Subcommands

- [ ] Add `clavue-agent-sdk issue run <path-or-url>`.
- [ ] Add `issue get <run-id>`.
- [ ] Add `issue list`.
- [ ] Add `issue replay <run-id>`.
- [ ] Add `issue stop <run-id>`.
- [ ] Support `--max-iterations`, `--passing-score`, `--require-gate`, `--workflow`, and `--json`.

Preferred files:

- `src/cli.ts`
- New `tests/cli.test.ts`
- README

Acceptance gates:

- [ ] Existing one-shot CLI remains backward compatible.
- [ ] JSON output is stable enough for CI.
- [ ] `npm test`

## P2: Version 0.9 Safety, Memory, Skills, Providers

### 0.9.1 Workspace Containment And Shell Classification

- [ ] Add central workspace path policy.
- [ ] Apply it to `Read`, `Write`, `Edit`, `NotebookEdit`, worktree tools, and relevant shell cwd behavior.
- [ ] Add optional `additionalDirectories` support to the actual policy.
- [ ] Add shell command classifier for destructive, network, install, publish, git, and filesystem mutation patterns.
- [ ] Add warnings or denials based on permission mode and host policy.
- [ ] Add output redaction before trace/job/memory persistence.

Preferred files:

- `src/types.ts`
- `src/tools/read.ts`
- `src/tools/write.ts`
- `src/tools/edit.ts`
- `src/tools/bash.ts`
- New `src/utils/workspace-policy.ts`
- New `src/utils/redact.ts`
- `tests/permissions.test.ts`
- New `tests/workspace-policy.test.ts`

Acceptance gates:

- [ ] Path traversal and out-of-root writes are blocked unless explicitly allowed.
- [ ] Subagents, skills, and jobs inherit containment.
- [ ] Destructive shell patterns are classified before execution.
- [ ] `npm test`

### 0.9.2 MCP And Network Safety

- [ ] Add MCP tool safety override config.
- [ ] Add MCP tool namespace collision policy.
- [ ] Include real MCP connection statuses in `system:init`.
- [ ] Add network/domain allowlist and denylist options for `WebFetch` and `WebSearch`.
- [ ] Add external-content prompt-injection warning to web/MCP tool guidance.
- [ ] Add doctor checks for MCP collision and unclassified MCP tools.

Preferred files:

- `src/mcp/client.ts`
- `src/agent.ts`
- `src/engine.ts`
- `src/tools/web-fetch.ts`
- `src/tools/web-search.ts`
- `src/doctor.ts`
- `src/types.ts`
- New `tests/mcp-safety.test.ts`
- New `tests/web-tools.test.ts`

Acceptance gates:

- [ ] Hosts can mark selected MCP tools as read-only or unsafe.
- [ ] Name collisions fail or are namespaced deterministically.
- [ ] Web tools obey configured domain policy.
- [ ] `npm test`

### 0.9.3 Rich Memory Trace And Validation Lifecycle

- [ ] Add memory validation states: `observed`, `reused`, `confirmed`, `stale`, `rejected`.
- [ ] Add retrieval ID, duration, store ID/path, filters, candidate count, selected count, score components, stale markers, conflict markers, and redaction status.
- [ ] Add deterministic retrieval fixtures with distractors, stale entries, and conflicting memories.
- [ ] Add brain-first behavior options for missing/stale memory: continue, warn, or block.
- [ ] Add rolling session intelligence summary for goals, decisions, files/resources touched, open risks, verification, and todos.

Preferred files:

- `src/memory.ts`
- `src/memory-policy.ts`
- `src/engine.ts`
- `src/agent.ts`
- `src/session.ts`
- `src/types.ts`
- `tests/memory.test.ts`
- `tests/memory-integration.test.ts`
- New `tests/memory-retrieval-quality.test.ts`

Acceptance gates:

- [ ] Memory trace explains selection and trust state.
- [ ] Stale/conflicting memory is visible as risk.
- [ ] Retrieval quality tests are deterministic.
- [ ] `npm test`

### 0.9.4 Skill Preconditions And Artifact Enforcement

- [ ] Enforce skill preconditions before inline or forked activation.
- [ ] Require declared artifacts before skill success when enforcement is enabled.
- [ ] Automatically merge required skill gates into active `qualityGatePolicy`.
- [ ] Add skill activation trace with selected skill, mode, allowed tools, model, precondition status, artifact status, gate status, and job ID when forked.
- [ ] Add production skill authoring examples.

Preferred files:

- `src/skills/types.ts`
- `src/skills/registry.ts`
- `src/tools/skill-tool.ts`
- `src/engine.ts`
- `src/types.ts`
- `tests/skills.test.ts`
- `tests/skills-loader.test.ts`
- New `tests/skill-enforcement.test.ts`

Acceptance gates:

- [ ] Missing required preconditions fail before model/tool work.
- [ ] Missing required artifacts can fail terminal success.
- [ ] Existing skills remain compatible unless enforcement is explicitly enabled.
- [ ] `npm test`

### 0.9.5 Provider Capability Preflight

- [x] Add provider error categories:
  - [x] `unsupported_capability`
  - [x] `content_filter`
  - [x] `context_overflow`
  - [x] `tool_protocol_error`
  - [x] `provider_conversion_error`
- [x] Add initial OpenAI request preflight for unsupported thinking and image requests.
- [ ] Add request preflight for tools, JSON schema, transport support, and Anthropic parity.
- [ ] Add fallback rules that distinguish unsupported capability from retryable provider failure.
- [x] Add OpenAI provider normalization tests with stubbed fetch behavior.
- [ ] Add Anthropic provider semantic taxonomy tests with stubbed client behavior.

Preferred files:

- `src/providers/types.ts`
- `src/providers/capabilities.ts`
- `src/providers/openai.ts`
- `src/providers/anthropic.ts`
- `src/engine.ts`
- `tests/openai-provider.test.ts`
- `tests/anthropic-provider.test.ts`
- `tests/model-fallback.test.ts`

Acceptance gates:

- [x] Unsupported OpenAI thinking/image capabilities fail before unsafe provider calls when detectable.
- [ ] Unsupported capabilities fail before unsafe provider calls across all providers when detectable.
- [ ] Retryable outages can still use fallback model.
- [ ] Prompt-too-long recovery remains separate from fallback.
- [ ] `npm test`

## P3: Version 1.0 Release Readiness

### 1.0.1 Compatibility And Migration

- [ ] Write public schema docs for events, result, trace, job records, memory trace, and quality gates.
- [ ] Write migration guide from `0.6.x` through `0.9.x`.
- [ ] Define semver and deprecation policy.
- [ ] Add public API compatibility tests.
- [ ] Add golden trace fixtures for representative workflows.

### 1.0.2 Production Integration Examples

- [ ] Add CI review example.
- [ ] Add streaming web UI example with phase, tool, question, and final result rendering.
- [ ] Add background worker/job dashboard example.
- [ ] Add MCP integration example with safety overrides.
- [ ] Add skill pack loading example.
- [ ] Add memory-backed assistant example with memory trace display.

### 1.0.3 Telemetry And Redacted Logs

- [ ] Add telemetry sink interface for run, turn, provider, tool, hook, job, and memory events.
- [ ] Add OpenTelemetry adapter or documented integration bridge.
- [ ] Add shared redaction helper for logs, traces, memory, and jobs.
- [ ] Add tests proving obvious API keys and tokens are redacted.

## Verification Commands

Run these before handing off a completed slice:

```bash
npm run build
npm test
```

Run focused tests when relevant:

```bash
npx tsx --test tests/permissions.test.ts tests/doctor.test.ts tests/package-payload.test.ts
```

Run package dry-run checks before release-related changes:

```bash
npm pack --dry-run --json
```
