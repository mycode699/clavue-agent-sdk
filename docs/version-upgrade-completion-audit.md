# Version Upgrade Completion Audit

Last updated: 2026-04-30

## Verdict

The current codebase is not development-complete for a mature production release.

It is build- and test-green, and many foundations are already implemented. The remaining work is mostly product maturity: stable schemas, interaction UX, durable job orchestration, context budgeting, safety hardening, memory trust, and public documentation.

## Verified Baseline

Verified locally on 2026-04-30:

- `npm run build` passed.
- `npm test` passed: 210/210 tests.

Working tree status during this audit:

- Modified provider/test files exist:
  - `src/providers/openai.ts`
  - `src/providers/types.ts`
  - `tests/openai-provider.test.ts`
  - `tests/package-payload.test.ts`
- New planning docs exist:
  - `docs/version-upgrade-plan.md`
  - `docs/version-upgrade-todolist.md`
- Untracked `.clavue/` exists and was not inspected or modified.

## Completed Or Mostly Completed

These areas are strong enough to treat as existing baseline, not future work:

- In-process APIs: `run()`, `query()`, `createAgent()`, and reusable `Agent`.
- Anthropic and OpenAI-compatible provider abstraction.
- OpenAI Responses routing for GPT-5-style models with gateway fallback to Chat Completions.
- Model capability registry with conservative unknown-model behavior.
- OpenAI provider capability preflight for unsupported `thinking` and `images` on known unsupported models.
- OpenAI provider normalized categories for `unsupported_capability`, `content_filter`, `context_overflow`, `tool_protocol_error`, and `provider_conversion_error`.
- Tool registry, named toolsets, permission modes, safety annotations, and read-only concurrency.
- Explicit `maxToolConcurrency` option and trace metadata for concurrency limit/source.
- Workflow profiles for collect/organize/plan/solve/build/verify/review/ship.
- Quality gate policy that can make missing or failed gates terminal.
- Skill registry, skill validation, filesystem skill loading, inline activation, forked skill jobs, and lifecycle workflow skills.
- Basic memory injection and trace, including `brainFirst` retrieval before first provider call.
- Session persistence and runtime namespace isolation.
- Durable `AgentJob` records with heartbeat, stale detection, cancellation, replay helper, and job tools.
- `doctor()` and `runBenchmarks()`.
- Package payload and CLI entrypoint regression tests.

## Not Complete Yet

### P0 Open Work

- Public event/result/trace/job/memory schema versions are not carried in all public artifacts.
- Golden event trace fixtures do not yet protect streaming compatibility.
- Run phase events are not implemented as a stable UI state model.
- Policy decision trace records denials but not all allow/deny decisions with source, timestamp, risk, and input summary.
- `summarizeAgentJobs()` or equivalent public job summary API is missing.
- Background subagent batch helper with shared correlation metadata is missing.

### P1 Open Work

- `AskUserQuestion` does not yet emit a structured pending-input event for UI hosts.
- CLI lacks workflow mode, budget, fallback model, permission mode, doctor, benchmark, and job subcommands.
- Context assembly is still not a full budgeted context pack with included/dropped/truncated section trace.
- Docs and examples are not yet organized into a production cookbook.
- `system:init` does not yet report real MCP connection status.

### P2 Open Work

- Central workspace containment policy is missing across file, shell, MCP, and job paths.
- Shell command classification and destructive-command preflight are incomplete.
- MCP tool safety classification overrides and collision policy are missing.
- Web tools lack domain allow/deny policy and external-content prompt-injection isolation.
- Memory trace lacks retrieval ID, duration, store identity, filters, score components, stale/conflict markers, and redaction status.
- Memory validation lifecycle is not explicit enough for high-trust reuse.
- Skill preconditions and required artifacts are not fully enforced as automatic blockers.
- Provider capability preflight is only partial:
  - OpenAI has initial unsupported capability checks.
  - Anthropic does not yet have matching semantic taxonomy/preflight coverage.
  - JSON schema/tool protocol/context preflight remains incomplete.

### P3 Open Work

- No public compatibility/migration guide for `0.6.x -> 1.0`.
- No stable schema docs for events, results, traces, jobs, and memory traces.
- No telemetry sink or OpenTelemetry adapter.
- No shared redacted structured log helper.
- Production examples are not complete enough for a `1.0` release.

## Completion Matrix

| Area | Current Status | Release Readiness |
| --- | --- | --- |
| Build/test baseline | Green | Ready |
| Provider taxonomy | Partial | Needs Anthropic/preflight completion |
| Tool permission modes | Strong baseline | Needs workspace containment and MCP/network policy overrides |
| Workflow profiles | Present | Needs UI state and docs |
| Skills | Strong baseline | Needs precondition/artifact enforcement |
| Memory | Basic trace complete | Needs trust/provenance lifecycle |
| Agent jobs | Durable records complete | Needs summary, batch, worker/recovery |
| Event schemas | Useful but unversioned | Not ready for 1.0 |
| CLI | Basic one-shot CLI | Needs production subcommands |
| Docs | Many planning docs | Needs cookbook and stale-doc cleanup |

## Recommended Next Slice

Continue Version 0.7 contract stabilization from `docs/version-upgrade-todolist.md`. Autonomy mode, CLI selection, and policy-decision trace are now implemented; the next highest-value safety slice is workspace containment across file, shell, MCP, and job paths.

Recommended exact first implementation slice:

1. Add public schema version constants and additive schema metadata.
2. Add golden event trace tests.
3. Add run phase/status events.
4. Add job summary API.

Why this order:

- It improves host integration without risky runtime rewrites.
- It gives UI and CI consumers stable surfaces before more behavior is added.
- It reduces documentation drift by making the public contract explicit.

## Release Decision

Current state is suitable for continued `0.x` iteration.

It is not ready to declare development complete or cut a production `1.0` because public schemas, interaction state, durable orchestration UX, safety containment, and docs are still immature.
