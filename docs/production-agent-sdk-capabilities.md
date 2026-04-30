# Production Agent SDK Capability Analysis

Last updated: 2026-04-28

## Purpose

This document analyzes what a mature production-grade AI agent SDK should provide, using the current `clavue-agent-sdk` codebase as the baseline. The target is not a demo wrapper around an LLM. The target is an embeddable agent runtime that can safely plan, call tools, coordinate work, recover from failures, expose auditable state, and operate predictably in real applications.

## Current Project Baseline

The current SDK already has a strong runtime foundation:

- In-process agent loop through `createAgent()`, `query()`, and `run()`.
- Provider abstraction for Anthropic Messages and OpenAI-compatible APIs.
- Built-in tool registry with file I/O, shell, search, web, MCP resources, planning, tasks, subagents, background jobs, scheduling, LSP, config, todo, and skills.
- Named toolsets such as `repo-readonly`, `repo-edit`, `research`, `planning`, `tasks`, `automation`, `agents`, `mcp`, and `skills`.
- Streaming event model with assistant, tool result, system, result, task notification, rate-limit, and compaction boundary events.
- Session persistence, memory persistence, optional memory injection, and self-improvement memory capture.
- MCP client support plus in-process SDK MCP server support.
- Hook lifecycle for session, prompt, tool, compaction, task, config, file, and notification events.
- Subagents and durable background `AgentJob` records with trace, evidence, quality gates, heartbeat, cancellation, and stale detection.
- Auto-compaction, micro-compaction, retry with exponential backoff, cost estimation, token usage, model usage, run traces, permission denials, evidence, and quality-gate fields.
- Retro/eval modules for structured evaluation, scoring, verification gates, comparison, policy decisions, and retry loops.

The main maturity gap is that many capabilities exist as primitives or metadata, but not all are enforced as durable production contracts. A production SDK should make the safest and most reliable workflow the default, rather than relying on each caller to rebuild policy, workflow gates, observability, and recovery.

## Product Definition

A production agent SDK should be five things at the same time:

- A runtime that manages model calls, context, tools, retries, cancellation, and state.
- A safety layer that enforces permission boundaries, sandbox rules, human approval, and audit trails.
- A workflow engine that can plan, execute, verify, review, and ship with explicit gates.
- A coordination layer that supports skills, subagents, background jobs, memory, sessions, and external systems.
- An observability surface that lets host applications debug cost, latency, tool behavior, model behavior, quality, and failure modes.

If the SDK only sends prompts and exposes tool calls, it is a model adapter. If it enforces safe execution, durable state, repeatable workflows, and measurable quality, it becomes a production agent SDK.

## Required Functional Capabilities

### 1. Stable Integration API

Production users need multiple integration levels:

- One-shot execution for backend jobs: `run()`.
- Streaming execution for UIs, dashboards, logs, and live terminals: `query()`.
- Reusable multi-turn agents with durable session state: `createAgent()`.
- CLI entrypoint for CI, one-off automation, and debugging.
- Structured result objects that include status, subtype, text, events, messages, usage, cost, timing, trace, evidence, quality gates, permission denials, and errors.
- Strict compatibility promises for exported types, package entrypoints, and event schemas.
- Clear cancellation semantics through `AbortSignal` and agent-level `interrupt()`.
- Machine-readable output for CI and service integrations.

Current status: mostly present. The next step is to document event schema stability and define compatibility guarantees for public result fields.

### 2. Provider And Model Layer

A mature SDK must isolate host applications from provider-specific API differences:

- Unified provider interface for message creation, tool calling, multimodal input, usage, stop reasons, and errors.
- OpenAI Chat Completions, OpenAI Responses, Anthropic Messages, and OpenAI-compatible gateway support.
- Model capability registry for tool calling, reasoning mode, max context, image input, image output, JSON schema, streaming, caching, and cost.
- Automatic provider selection only when safe, with explicit override support.
- Fallback model policy for outage, rate limit, or unsupported capability.
- Model routing by task type, latency target, cost budget, tool capability, and quality tier.
- Normalized error taxonomy for auth, rate limit, overload, timeout, prompt-too-long, content filter, model unsupported, and provider conversion failure.
- Optional request and response streaming at provider level, not only event streaming after a full response.

Current status: provider normalization exists, OpenAI Responses fallback exists for GPT-5-style models, retry exists, and cost tracking exists. Missing maturity pieces are a first-class model capability registry, fallback policy enforcement, provider-level streaming, and richer normalized error types.

### 3. Tool Runtime

Tools are the main source of agent power and production risk. A mature SDK needs:

- Strong tool schemas with validation before execution.
- Tool annotations for read, write, shell, network, external state, destructive, idempotent, concurrency safe, and approval required.
- Built-in permission semantics instead of only host-supplied `canUseTool`.
- Sandboxed execution for shell and filesystem operations when enabled.
- Path containment, workspace boundaries, and additional-directory policies.
- Tool result size limits, truncation metadata, artifact references, and binary handling.
- Deterministic ordering for mutating tools and concurrent execution for safe read-only tools.
- Per-tool timeout, retry, cancellation, and resource budgets.
- Tool-specific prompt guidance surfaced in the system prompt under a bounded budget.
- Tool discovery without exposing unnecessary tools to the model.
- Full trace for tool name, input summary, duration, status, evidence, and quality gates.

Current status: schemas, tool registry, named toolsets, prompt fragments, concurrency-safe read-only batches, permission hooks, traces, and truncation are present. Missing maturity pieces include typed safety annotations, default enforcement for permission modes, schema validation hardening, sandbox integration, artifact references, and per-tool budgets.

### 4. Permission And Safety System

Production safety must be enforced by the runtime, not only by prompt wording:

- Safe defaults with least-privilege toolsets.
- Permission modes with concrete behavior: read-only, plan-only, accept-edits, trusted automation, bypass, and deny-by-default.
- Plan mode that blocks mutating tools until explicitly exited.
- Human approval workflows for risky writes, shell, network, destructive operations, and shared external state.
- Deny rules that are inherited by subagents, skills, background jobs, and MCP tools.
- Policy decision trace with tool name, input summary, decision, reason, source, and timestamp.
- Secret redaction in prompts, tool results, logs, memory, and traces.
- Destructive command detection for shell tools.
- Host-configurable safety profiles for local dev, CI, server, serverless, and SaaS.

Current status: permission metadata, `canUseTool`, allow/deny filters, toolsets, and permission denials exist. Missing maturity pieces are built-in mode semantics, safety annotations, sandbox enforcement, inherited policy tests across all nested execution paths, and redaction coverage across all persisted artifacts.

### 5. Workflow And Interaction Logic

A mature agent should not improvise the process every time. The SDK should provide default interaction logic:

- Understand the request and inspect relevant context before acting.
- If the task is ambiguous, ask one concise question; otherwise proceed.
- For substantial work, create an internal plan before edits.
- Keep edits scoped and aligned with existing project patterns.
- Verify changes with the smallest relevant checks.
- Review the result before final output.
- Report only concrete outcomes, tests, risks, and next steps.
- Never claim completion without evidence when verification is possible.
- In read-only review mode, prioritize findings with file and line references.
- In automation mode, avoid unnecessary user prompts but still block destructive ambiguity.

The SDK should encode this as reusable workflow skills or run modes:

- `analyze`: inspect and summarize without modification.
- `plan`: produce a bounded implementation plan and freeze mutating tools.
- `build`: implement scoped changes.
- `verify`: run configured gates and collect evidence.
- `review`: inspect diff or target artifacts for bugs and regressions.
- `ship`: prepare release notes, package checks, or final handoff.
- `repair`: respond to failed gates with a bounded retry loop.

Current status: planning tools, bundled skills, hooks, retro/eval, evidence, and quality gates exist. Missing maturity pieces are first-class lifecycle workflows, enforced verification gates, and terminal success semantics tied to quality-gate results.

### 6. Skills As Executable Workflows

Skills should be more than prompt snippets:

- Skill manifest with name, description, when-to-use, argument hints, allowed tools, denied tools, model, context mode, hooks, preconditions, and required gates.
- Inline skills for focused behavior inside the current run.
- Forked skills for durable background work through `AgentJob`.
- Skill-level tool restrictions that are enforced by the engine.
- Skill-level model override with model usage tracked separately.
- Skill activation trace and result metadata.
- Required evidence or checklist outputs for workflow skills.
- User-invocable and model-invocable visibility controls.
- Skill registry isolation through runtime namespaces.

Current status: registry, bundled skills, prompt formatting, skill activation parsing, inline tool/model constraints, and forked skill jobs are present. Missing maturity pieces are typed manifest preconditions, skill hooks, required-gate enforcement, and stronger tests around skill routing and terminal semantics.

### 7. Memory And Context

Production memory must be useful, auditable, and safe:

- Session memory for conversation continuity.
- Repo or project memory for durable operational lessons.
- User memory for preferences and stable profile facts.
- Reference memory for reusable documentation and decisions.
- Feedback memory for corrections and quality signals.
- Improvement memory for failed tools, failed runs, and reusable repair patterns.
- Retrieval before the first provider call when memory is enabled.
- Memory trace that records query, selected memories, score, source, validation state, and injection status.
- Citation or evidence fields for important memories.
- Expiration, revalidation, and conflict handling.
- Secret redaction and PII controls before persistence.
- Retrieval benchmarks to prove memory quality.

Current status: JSON memory store, query scoring, auto-injection, session summary save, self-improvement capture, and redaction for common captured secrets are present. Missing maturity pieces are brain-first retrieval policy, memory trace in run output, richer memory provenance, conflict handling, and retrieval quality benchmarks.

### 8. Sessions, Jobs, And Durability

A production agent often outlives one request:

- Durable session save, load, list, fork, rename, tag, and delete.
- Background jobs for long-running or delegated work.
- Job records with status, prompt, model, allowed tools, output, error, trace, evidence, gates, heartbeat, and timestamps.
- Cancellation that propagates to model calls and tools.
- Stale detection after process death.
- Resume or replay policy for queued and stale jobs.
- Job health checks and cleanup tools.
- Runtime namespace isolation for multi-tenant or multi-agent hosts.
- Storage driver abstraction for local filesystem, database, object storage, or host-managed persistence.

Current status: sessions and background jobs are durable on local filesystem, namespace isolation exists, heartbeat and stale detection exist, and job inspection/stop tools exist. Missing maturity pieces are process-restart resume, pluggable storage, queued job workers, and operational health APIs.

### 9. Multi-Agent Coordination

Multi-agent support should be deliberate, not just recursive prompting:

- Named subagent definitions with clear prompts, tool scopes, model choices, and max turns.
- Parallel delegation for independent tasks.
- Shared policy inheritance from parent to subagent.
- Disjoint write-scope guidance to reduce conflicts.
- Background mode for long-running subagents.
- Parent-visible job progress, evidence, and quality gates.
- Team primitives only when they add coordination value.
- Recursion guards and budget inheritance.
- Merge and arbitration patterns for conflicting agent outputs.

Current status: subagent tool, custom agent definitions, built-in Explore and Plan agents, background jobs, task tools, teams, and policy inheritance are present. Missing maturity pieces are coordination contracts, recursion/budget hardening, write-scope conflict prevention, and richer parent-child trace linking.

### 10. MCP And Extension Ecosystem

External tool ecosystems need controlled integration:

- MCP stdio, HTTP, SSE, and in-process SDK server support.
- MCP tool schema normalization and conflict handling.
- MCP resource listing and reading.
- Connection lifecycle management and cleanup.
- Health checks for server availability and tool registration.
- Strict config validation mode.
- Tool namespace collision policy.
- Permission classification for MCP tools.
- Plugin or extension manifest support with install-time and run-time safety controls.

Current status: MCP connections and in-process SDK MCP servers exist, and MCP resource tools exist. Missing maturity pieces are doctor checks, strict validation coverage, namespace collision policy, MCP safety annotations, and plugin lifecycle enforcement.

### 11. Observability And Auditability

Production hosts need to understand every run:

- Structured run trace for turns, model usage, tool durations, concurrency batches, retries, compactions, and denials.
- Latency split between wall time, provider time, tool time, hook time, and queue time.
- Cost and usage grouped by model.
- Evidence artifacts attached to tool results and final result.
- Quality gates attached to final result with pass, fail, skipped, or pending status.
- Redacted logs suitable for production retention.
- Event stream that can drive UIs and logs without parsing assistant text.
- Correlation IDs for session, run, turn, tool call, job, and subagent.
- Export hooks for OpenTelemetry or host logging.
- Debug mode that is safe to enable without leaking secrets.

Current status: trace, usage, cost, evidence, quality gates, events, and hook system exist. Missing maturity pieces are OpenTelemetry integration, richer timing breakdown, artifact store references, redacted structured logs, and stable event schema docs.

### 12. Quality, Evaluation, And Self-Improvement

Agent quality must be measured:

- Deterministic evaluators for package, import, build, test, onboarding, safety, and workflow readiness.
- Verification gates that can run commands and attach evidence.
- Comparison between current and previous runs.
- Policy decision for accept, reject, or retry.
- Bounded retry loop with nested self-improvement disabled.
- Memory capture for reusable failures and successful patterns when configured.
- Regression suites with stub providers and deterministic tools.
- Golden event traces for public API compatibility.
- Benchmarks for latency, throughput, context size, memory retrieval, and job startup.

Current status: retro/eval core, verification, comparison, policy, loop, and self-improvement capture exist. Missing maturity pieces are deeper integration into normal agent runs, enforced gate outcomes, benchmark harness, and long-running regression scenarios.

## Performance Capabilities

Production performance should be defined by measurable budgets, not impressions.

### Runtime Efficiency

The SDK should support:

- Concurrent execution for read-only concurrency-safe tools.
- Strict serial execution for mutating tools.
- Configurable max tool concurrency.
- Minimal provider conversion overhead.
- Efficient file reads and search behavior for large repositories.
- Bounded tool result size and artifact fallback for very large outputs.
- Incremental event delivery for UI responsiveness.
- Low startup overhead for reusable agents.

Current status: read-only tool concurrency and result truncation exist. Missing maturity pieces are benchmarks and target budgets.

Recommended initial targets:

- Agent startup without MCP: under 50 ms on a warm Node process.
- Tool dispatch overhead: under 5 ms excluding tool work.
- Read-only batch fan-out: near max concurrency for independent `Read`, `Glob`, and `Grep` calls.
- Context micro-compaction: under 10 ms for normal transcripts.
- Memory query over 1,000 local JSON entries: under 100 ms.
- Background job creation: under 20 ms excluding runner start.

These targets should be validated with deterministic local benchmarks before being used as hard CI gates.

### Provider Latency And Reliability

The SDK should support:

- Retry with exponential backoff and `Retry-After` handling.
- Rate-limit events in the stream.
- Timeout controls for model calls and tools.
- Fallback model policy when provider or model fails.
- Circuit breaker behavior for repeated provider failures.
- Budget controls for turns, tokens, cost, and elapsed time.
- Recovery for prompt-too-long and max-output-token responses.

Current status: retry, prompt-too-long compaction, max-output continuation, max turns, max tokens, and max budget exist. Missing maturity pieces are fallback model enforcement, elapsed-time budget, circuit breaker, and provider-level streaming.

### Context Performance

The SDK should support:

- Context window estimation by model.
- Auto-compaction before hard provider failure.
- Micro-compaction for large tool results.
- Tool result references for large artifacts.
- Memory selection under an injection budget.
- Cache-aware prompt construction for providers that expose cache metrics.

Current status: token estimation, auto-compaction, micro-compaction, and cache token accounting exist. Missing maturity pieces are artifact references, memory budget optimization, and model-specific context registry.

## Interaction Logic For Production Hosts

A production host should expose predictable interaction behavior:

1. Initialize the run with explicit `cwd`, model, toolset, max turns, budget, and permission mode.
2. Emit a `system:init` event with session, tools, model, cwd, MCP status, and permission mode.
3. Inject project context, tool guidance, skills, memory, and environment context within strict budgets.
4. Ask the model for the next step with only the allowed tools for the current mode or active skill.
5. Validate tool calls against schema, policy, hooks, sandbox, and active skill restrictions.
6. Execute safe read-only batches concurrently and mutating tools serially.
7. Stream assistant output, tool results, status updates, denials, rate-limit events, and final results.
8. Record trace, usage, cost, evidence, quality gates, retries, compactions, and permission decisions.
9. If gates fail and retry is enabled, run a bounded repair loop with fresh evidence.
10. Persist session, memory, job state, and final artifacts according to host configuration.
11. Return a typed result that lets the host decide success without parsing prose.

The key principle is that the host application should never need to infer whether the agent succeeded from natural language alone.

## Production API Surface To Add Or Harden

Recommended additions:

- `doctor(options)`: validate provider credentials, model capability, toolsets, MCP servers, skills, session store, memory store, jobs store, package entrypoints, and permissions.
- `benchmark(options)`: run deterministic local performance checks without live model calls.
- `createPolicy(profile)`: produce enforced built-in permission policies for common modes.
- `createWorkflow(name, config)`: register lifecycle workflows with required gates.
- `runWorkflow(name, input, options)`: execute an enforced plan-build-verify-review loop.
- `getModelCapabilities(model)`: return normalized model features and limits.
- `createStorageAdapter(...)`: support host-managed session, memory, and job persistence.
- `createTelemetrySink(...)`: export run, turn, tool, provider, hook, and job spans.
- `validateToolCall(tool, input)`: expose schema validation for host-side testing.
- `redact(value, policy)`: expose shared redaction used by traces, logs, memory, and jobs.

Recommended hardening of existing APIs:

- Make event schemas explicitly versioned.
- Add run-level elapsed-time budget.
- Add per-tool timeout and max-output configuration.
- Make `permissionMode` enforce behavior by default.
- Make quality-gate failure optionally change final run status.
- Attach memory retrieval trace to `AgentRunResult`.
- Include MCP connection status in real `system:init` events.
- Add provider error subtype taxonomy.

## Priority Roadmap

### P0: Production Safety And Workflow Contracts

- Enforce built-in permission mode semantics.
- Add tool safety annotations and policy inheritance tests.
- Make plan mode block mutating tools by default.
- Add lifecycle workflow skills for plan, build, verify, review, and ship.
- Make quality gates optionally affect final run success.
- Version and document public event schemas.

### P1: Durability And Operability

- Add `doctor()` API.
- Add process-restart recovery or explicit replay policy for queued and stale jobs.
- Add pluggable storage abstraction for sessions, memory, and jobs.
- Add memory retrieval trace and brain-first memory mode.
- Add redacted structured logs and telemetry sink.
- Add MCP health checks and collision policy.

### P2: Performance And Quality Measurement

- Add deterministic benchmark harness.
- Add model capability registry and fallback policy.
- Add provider-level streaming.
- Add retrieval benchmark fixtures.
- Add golden trace tests for streaming events.
- Add elapsed-time budget and circuit breaker support.

### P3: Ecosystem And Advanced Coordination

- Add plugin lifecycle and manifest validation.
- Add stronger multi-agent coordination contracts.
- Add artifact store abstraction.
- Add advanced workflow templates for coding, research, data extraction, release, and incident response.
- Add UI-ready status taxonomy for long-running workflows.

## Recommended Acceptance Gates

For every production maturity slice, require:

- `npm run build`
- `npm test`
- Deterministic stub-provider tests for runtime behavior
- Permission inheritance tests for direct tools, skills, subagents, and background jobs
- Event schema tests when public messages change
- Package payload tests when exports change
- Benchmark output when claiming performance improvements
- Documentation update for new public APIs or behavior

## Summary

The current SDK is already more than a simple LLM wrapper. It has the core pieces of an embeddable production agent runtime: tools, sessions, memory, MCP, hooks, skills, subagents, background jobs, traces, cost tracking, and retro/eval. The next maturity step is to turn these pieces into enforced contracts.

The highest-value direction is to make production behavior explicit: policy modes must enforce safety, workflow gates must determine success, memory retrieval must be traceable, jobs must be recoverable, events must be stable, and performance must be measured. Once those contracts are in place, the SDK can credibly position itself as a production-grade intelligent agent runtime rather than a flexible agent toolkit.
