# Production-Grade AI Agent SDK Capability Analysis

Last updated: 2026-04-28

This document analyzes what a mature production tool and AI-native agent SDK should provide, using the current `clavue-agent-sdk` project as the baseline.

## 1. Current project baseline

`clavue-agent-sdk` is already positioned as an in-process agent runtime rather than a thin CLI wrapper. The current codebase includes many important production primitives:

- In-process agent APIs: `run()`, `query()`, and reusable `createAgent()`.
- Provider abstraction for Anthropic Messages and OpenAI-compatible APIs.
- A broad built-in tool registry: file I/O, shell, web, notebook edits, planning, tasks, subagents, worktrees, MCP resources, scheduling, LSP, config, and skills.
- Named toolsets such as `repo-readonly`, `repo-edit`, `research`, `planning`, `tasks`, `automation`, `agents`, `mcp`, and `skills`.
- Streaming events and structured final run artifacts.
- Session persistence, structured memory, self-improvement memory, and retro/eval pipeline.
- MCP integration for stdio, SSE, HTTP, and in-process SDK MCP servers.
- Hook system with lifecycle events.
- Subagents and durable background `AgentJob` records.
- Execution trace metadata, evidence, quality gates, usage, cost, retries, and context compaction.

The current maturity gap is not a lack of primitives. The main challenge is turning these primitives into enforceable, observable, safe, and ergonomic workflow contracts that application developers can trust in production.

## 2. What a mature production AI agent SDK must be

A mature agent SDK should be more than a model wrapper. It should be an application runtime for goal-directed work:

1. **Composable**: tools, skills, agents, memory, hooks, and providers can be assembled predictably.
2. **Controllable**: hosts can constrain tools, cost, turns, filesystem/network scope, and approval policy.
3. **Observable**: every run produces inspectable traces, evidence, errors, costs, and quality-gate outcomes.
4. **Recoverable**: sessions, background jobs, and long workflows can survive interruption or fail with clear recovery state.
5. **Evaluable**: behavior can be tested, benchmarked, replayed, and compared without relying only on subjective assistant text.
6. **Safe by default**: destructive or externally visible actions require explicit policy, not prompt compliance alone.
7. **Ergonomic**: simple cases remain one call, while advanced hosts can plug in deeper control surfaces.

## 3. Core capability domains

### 3.1 Public API and developer ergonomics

A production SDK needs clean layers for different integration needs:

- **One-shot blocking API** for backend jobs and CI automation.
- **Streaming API** for UIs, dashboards, logs, and live execution views.
- **Reusable agent object** for long-lived sessions, MCP connections, memory, and repeated prompts.
- **Low-level engine/provider interfaces** for framework authors and advanced embedding.
- **Strong TypeScript types** for messages, tools, run results, traces, memory, skills, sessions, and policies.
- **Stable extension points** for custom tools, custom providers, skills, hooks, memory stores, and permission policies.
- **Versioned result schemas** so production consumers can safely parse artifacts over time.

Current status: the project already has strong public surface coverage in `src/index.ts` and README examples. The next maturity step is ensuring every public abstraction has deterministic tests, clear versioning expectations, and compatibility guarantees.

### 3.2 Tool runtime and capability governance

A mature agent SDK must treat tools as governed capabilities, not just function calls.

Required abilities:

- Tool metadata: read/write/network/shell/destructive/external-state/concurrency-safe.
- Tool allowlists and denylists.
- Named capability profiles for common workloads.
- Runtime permission checks with input rewriting or denial.
- Host-controlled approval flows.
- Sandbox-aware execution for shell and filesystem access.
- Tool result size limits and structured error contracts.
- Tool provenance: which tool ran, with what input class, duration, result status, and evidence.
- Deterministic ordering: mutating tools run serially, safe read-only tools can run concurrently.

Current status: the SDK already supports toolsets, allow/deny filters, `canUseTool`, hooks, sandbox settings, and read-only concurrency. The gap is first-class semantic safety annotations and built-in policy enforcement for modes like read-only, plan, accept-edits, and trusted automation.

### 3.3 Provider and model abstraction

A production SDK should isolate application code from provider differences.

Required abilities:

- Multiple provider protocols behind one normalized message/tool schema.
- Model capability metadata: context window, tool support, thinking/reasoning support, image support, streaming support, JSON/schema support, cost model.
- Fallback model policy.
- Retry and backoff for transient errors.
- Rate-limit events that hosts can surface to users.
- Token and cost accounting by model.
- Provider-specific edge-case mapping into stable SDK errors.
- Cancellation and timeout handling.

Current status: provider normalization, retry, OpenAI-compatible behavior, model usage, and cost tracking already exist. The maturity gap is richer model capability discovery, explicit fallback semantics, and stronger provider conformance tests.

### 3.4 Agent loop and workflow control

A production SDK should provide predictable lifecycle control around the model-tool loop.

Required abilities:

- Bounded turns, budget, output tokens, and wall-clock/runtime limits.
- Goal-oriented loop with clear terminal states: success, max turns, budget exceeded, cancelled, failed, blocked by policy, failed quality gate.
- Tool-use protocol enforcement.
- Context compaction with traceable boundaries.
- Partial output recovery for max-token interruptions.
- Workflow gates: define, plan, execute, verify, review, ship.
- Machine-readable run results, not only natural-language summaries.

Current status: the engine already supports max turns, budget, retries, auto/micro compaction, traces, evidence, and final result events. The gap is making workflow gates terminally meaningful: a run should be able to fail because required verification or review gates failed, not merely include gate metadata.

### 3.5 Skills as executable workflows

Skills in a mature agent SDK should be executable workflows, not just reusable prompt snippets.

Required abilities:

- Typed skill manifests: name, description, when-to-use, arguments, allowed tools, model override, context mode, preconditions, required evidence, and output schema.
- Inline and forked execution modes.
- Skill-specific tool constraints.
- Skill-specific verification gates.
- Skill activation traceability.
- Skill lifecycle hooks.
- Skill registry introspection for UIs.
- Tests proving skill activation actually constrains model/tool behavior.

Current status: the project has bundled and custom skills, inline/forked activation, durable forked jobs, model override, and allowed-tool handling. The next step is typed preconditions, required evidence, and enforcement of skill-level success/failure semantics.

### 3.6 Memory and learning

A production agent SDK needs memory, but memory must be governed carefully.

Required abilities:

- Typed memory categories: user, project, feedback, reference, decision, improvement.
- Scoped memory: global, repository, workspace, tenant, session.
- Retrieval policy: off, manual, auto-inject, brain-first.
- Evidence/source tracking for memories.
- Staleness and validation metadata.
- Redaction and secret handling.
- Memory search quality benchmarks.
- Explicit host control over what is saved.
- Requirement to verify repo-state memories before acting on them.

Current status: structured memory, query, auto-injection, and self-improvement memory exist. The maturity gap is retrieval quality measurement, stronger source/evidence modeling, and a brain-first mode that records memory lookup as part of the run trace.

### 3.7 Sessions, background jobs, and resumability

A mature SDK should support long-running work reliably.

Required abilities:

- Persisted sessions with resume, continue, fork, tags, and metadata.
- Durable background jobs with status, output, trace, errors, evidence, heartbeat, and cancellation.
- Process-restart recovery for queued or stale jobs.
- Job dependency graphs for multi-agent workflows.
- Timeouts and resource budgets per job.
- Storage isolation for multi-tenant hosts.
- Clear cleanup and retention policies.

Current status: sessions and durable `AgentJob` records are present. The main gap is true process-restart continuation or safe replay for in-flight jobs.

### 3.8 Multi-agent coordination

Production-grade multi-agent support should be explicit and inspectable.

Required abilities:

- Registered subagent definitions with tool/model/prompt boundaries.
- Parent-to-child policy inheritance.
- Background and foreground execution.
- Inter-agent messaging with traceability.
- Team orchestration and lifecycle management.
- Conflict handling when multiple agents propose or edit overlapping state.
- Aggregation of findings, evidence, and quality gates.

Current status: subagents, teams, messages, and background agent jobs exist. The gap is higher-level orchestration policy: dependencies, conflict resolution, shared artifact contracts, and supervisor review gates.

### 3.9 Observability, evidence, and auditability

Production users need to know what happened, why, and whether it was safe.

Required abilities:

- Structured run trace: turns, tools, timings, retries, compactions, permission denials.
- Token and cost usage by model.
- Evidence artifacts from tools, hooks, skills, evals, and external systems.
- Quality gate records with pass/fail/skipped status.
- Error taxonomy and root-cause categories.
- Optional redacted transcript export.
- Run replay fixtures for deterministic debugging.
- OpenTelemetry or host-pluggable telemetry adapters.

Current status: trace, evidence, quality gates, usage, cost, and errors are already part of the result model. The next step is standardizing these artifacts enough for dashboards, CI checks, replay, and long-term trend analysis.

### 3.10 Security and safety

A production agent SDK must assume tool access can create real-world impact.

Required abilities:

- Least-privilege defaults.
- Read-only mode and plan/freeze mode with actual enforcement.
- Explicit handling for destructive, external-state, network, credential, and shell actions.
- Filesystem and network sandbox policy.
- Secret redaction in logs, traces, memory, and errors.
- Prompt-injection-aware tool guidance for web/MCP/external content.
- Multi-tenant isolation: runtime namespace, session dir, memory dir, job dir, tool state.
- Audit trail for all blocked and allowed high-impact actions.

Current status: the SDK has permission modes, `canUseTool`, hooks, sandbox settings, session ID validation, and namespace isolation. The main gap is moving more safety behavior from prompts/host callbacks into built-in policy semantics.

### 3.11 Performance and scalability

For a production SDK, performance must be measured, not assumed.

Important performance dimensions:

- Provider latency per turn.
- Tool execution latency by tool type.
- Safe tool fan-out concurrency.
- Context build time.
- Context size growth per turn.
- Compaction frequency and quality.
- Memory retrieval latency and precision.
- MCP connection startup and tool-call overhead.
- Subagent startup latency.
- Background job throughput.
- Cost per successful task.

Recommended baseline metrics:

| Area | Recommended metric | Target direction |
| --- | --- | --- |
| Agent loop | p50/p95 turn duration | Lower is better |
| Tool runtime | p50/p95 tool duration by tool | Lower is better |
| Concurrency | read-only fan-out speedup | Higher is better |
| Context | tokens per turn and compaction count | Stable and bounded |
| Memory | retrieval latency and top-k relevance | Lower latency, higher relevance |
| Provider | retry rate and rate-limit frequency | Lower is better |
| Cost | USD per completed run | Lower at equal quality |
| Quality | gate pass rate and regression count | Higher pass rate, fewer regressions |

Current status: the SDK has concurrency, compaction, retries, token/cost tracking, and traces. The gap is a deterministic benchmark harness and CI-friendly performance regression reporting.

### 3.12 Interaction logic and UX

A mature AI agent SDK should support natural interaction without hiding control from the host application.

Required interaction logic:

- Clear user intent classification: answer, inspect, plan, edit, verify, commit, review, debug, automate.
- Progressive disclosure: start with minimal tools and expand only when needed.
- Confirmation policy based on risk, not constant interruption.
- Plan mode for ambiguous or high-impact work.
- Fast path for simple tasks.
- Structured questions when user input is genuinely required.
- Live streaming of assistant text, tool starts/results, status updates, and final result.
- UI-friendly event contracts for pending tools, approvals, background jobs, rate limits, and task notifications.
- Recovery prompts for partial completions, failed tools, or blocked actions.
- Human-readable summaries backed by machine-readable evidence.

Current status: the SDK supports streaming events, user questions, plan tools, task notifications, permissions, and hooks. The maturity gap is a standardized interaction state machine that hosts can rely on instead of reimplementing intent/risk/progress logic.

## 4. Production readiness matrix

| Domain | Current strength | Main gap | Priority |
| --- | --- | --- | --- |
| Public APIs | Strong `run/query/createAgent` surface | Versioned schema guarantees | P1 |
| Tools | Broad tool set and toolsets | Semantic safety annotations | P0 |
| Providers | Anthropic + OpenAI-compatible | Capability discovery/fallback policy | P1 |
| Agent loop | Bounded loop, retry, compaction | Gate-driven terminal semantics | P0 |
| Skills | Custom/bundled, inline/forked | Preconditions and evidence enforcement | P0 |
| Memory | Structured and queryable | Brain-first trace and retrieval benchmarks | P1 |
| Sessions/jobs | Sessions and durable jobs | Process-restart resumability | P1 |
| Multi-agent | Subagents, teams, messaging | Dependency/conflict orchestration | P2 |
| Observability | Traces/evidence/costs | Dashboard/replay/telemetry adapters | P1 |
| Security | Policies/hooks/sandbox settings | Built-in policy enforcement | P0 |
| Performance | Traces and concurrency primitives | Benchmark harness and budgets | P1 |
| Interaction UX | Streaming, questions, plan tools | Standard interaction state machine | P1 |

## 5. Recommended capability roadmap

### P0: Make safety and workflow contracts enforceable

1. Add semantic tool safety annotations.
2. Enforce built-in permission modes, especially read-only and plan/freeze behavior.
3. Promote quality gates from metadata to optional terminal success/failure criteria.
4. Add lifecycle workflow skills: define, plan, build, verify, review, ship.
5. Add required evidence metadata for skills and workflow gates.

### P1: Make production behavior measurable and operable

1. Add a benchmark harness for tool fan-out, context compaction, memory retrieval, subagent startup, and provider conversion overhead.
2. Add `doctor()` style health checks for provider config, MCP connectivity, sessions, memory, job storage, skill registry, and package exports.
3. Add richer model capability metadata and fallback policy.
4. Add memory lookup trace and retrieval quality fixtures.
5. Add OpenTelemetry or pluggable telemetry export.

### P2: Make long-running autonomy robust

1. Add process-restart recovery or explicit safe replay for background jobs.
2. Add job dependency graphs and supervisor policies.
3. Add conflict detection for multi-agent edits.
4. Add replayable run fixtures for difficult failures.
5. Add retention and cleanup policies for sessions, jobs, memory, and traces.

## 6. Suggested product-level north star

The SDK should aim to become an **agent operating layer** for TypeScript applications:

- Applications provide goals, tools, policies, and UI surfaces.
- The SDK provides controlled reasoning loops, tool execution, state, memory, workflow gates, observability, and safety.
- Developers can start with one call, then gradually adopt deeper capabilities without changing mental models.
- Every autonomous action remains bounded, auditable, and recoverable.

The strongest positioning is not “call an LLM with tools.” It is: **embed a production-grade AI worker runtime inside any Node.js application.**

## 7. Success criteria for maturity

A mature release should be able to prove the following:

1. A host can run a read-only review with no possibility of writes or shell mutation.
2. A host can run an edit workflow that cannot claim success until tests or configured gates pass.
3. A host can stream progress into a UI and reconstruct the full run from structured events.
4. A host can inspect every tool call, denial, retry, compaction, cost, and evidence artifact.
5. A host can resume or safely recover interrupted sessions and background jobs.
6. A host can use memory without leaking secrets or blindly trusting stale facts.
7. A host can benchmark latency, cost, and quality regressions in CI.
8. A host can compose custom tools, MCP servers, skills, agents, hooks, and policies without forking the runtime.

## 8. Immediate next document-backed actions

The current project already has a roadmap in `docs/agent-runtime-roadmap.md`. This analysis supports the same direction and suggests tightening the implementation focus around three themes:

1. **Enforcement**: permission modes, workflow gates, skill preconditions, and required evidence.
2. **Measurement**: benchmark harness, telemetry, replay, and health checks.
3. **Recoverability**: durable job resume/replay, storage health, and explicit cleanup/retention policy.

If these three themes are executed well, the SDK can move from “feature-rich agent runtime” to “production-grade agent operating layer.”
