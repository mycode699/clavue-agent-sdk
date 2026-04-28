# Agent Runtime Optimization Roadmap

Date: 2026-04-28
Status: active planning
Scope: Clavue Agent SDK TypeScript runtime, tool orchestration, skills, memory, sessions, and quality gates.

## Goal

Raise the SDK from a capable in-process agent loop to a more production-grade agent runtime: measurable, composable, durable, safe, and easy to extend.

The current program already has strong primitives: provider abstraction, MCP, tools, subagents, skills, hooks, permissions, sessions, memory, and retro/eval. The remaining gap is mostly coordination quality: durable workflow contracts, measurable runtime efficiency, richer skill/plugin lifecycle, and stronger observability.

## External practice synthesis

### addyosmani/agent-skills

Reusable lessons:

- Treat skills as executable workflows, not prose.
- Skills should encode lifecycle stages, acceptance criteria, red flags, and verification evidence.
- Keep skills small and composable, with progressive loading for deeper references.
- Completion should require concrete evidence: tests, build logs, traces, or review artifacts.

### garrytan/gbrain

Reusable lessons:

- Memory should compound across runs with provenance and citations.
- Separate lightweight note storage from brain-grade retrieval.
- Durable long-running work needs job/task state, resumability, and observability.
- Convert repeated failures into tested skills/checklists.

### garrytan/gstack

Reusable lessons:

- Use stage-based workflows: think, plan, build, review, test, ship, reflect.
- Coordinate specialist agents in isolated contexts and merge through review gates.
- Add policy middleware for risky operations and scoped edit boundaries.
- Track metrics: latency, pass rates, escaped defects, coverage, and retros.

## Current assessment

### Strengths

- `src/engine.ts` already has a real loop with retries, compaction, hooks, usage/cost tracking, and ordered tool execution.
- Tool execution preserves mutation order while allowing read-only concurrency.
- `src/providers/` isolates Anthropic and OpenAI-compatible transports.
- `src/skills/` and `SkillTool` provide a starting plugin surface.
- `src/retro/` gives deterministic evaluation and policy primitives.
- Current test baseline is green: `npm test` passed 136/136 tests after AgentJob and session-hardening work on 2026-04-28.

### Gaps

1. **Efficiency is not measured enough**
   - No benchmark harness for tool throughput, provider latency, prompt/context size, memory retrieval quality, or subagent overhead.
   - `AGENT_SDK_MAX_TOOL_CONCURRENCY` exists, but there is no regression gate proving concurrency behavior remains efficient under load.

2. **Background orchestration is durable but not fully resumable**
   - `AgentTool` now honors `run_in_background` and returns a `clavue.agent.job` envelope with a durable job ID.
   - `AgentJobList`, `AgentJobGet`, and `AgentJobStop` expose list/read/cancel operations.
   - Job records persist output, errors, trace, evidence, quality gates, heartbeat, and stale status.
   - Long-running specialist work still cannot resume active provider/tool execution after process death; stale jobs are detected instead.

3. **Skill/plugin contract is under-specified**
   - Skills are callable, but the runtime does not yet enforce typed preconditions, artifacts, quality gates, evidence, or compatibility metadata.
   - There is no plugin manifest validation or lifecycle hook set for install/enable/disable/health.

4. **Memory is useful but not brain-grade**
   - Current structured memory is lightweight tagged persistence.
   - Missing entity graph, citations, evidence scoring, staleness checks, hybrid retrieval, and retrieval benchmarks.

5. **Quality gates are not first-class runtime artifacts**
   - Retro/eval exists, but ordinary skills and agent runs do not have a shared `Evidence`/`QualityGate` contract.
   - Final success is mostly event/result based instead of gate based.

6. **Observability needs a stable contract**
   - Events expose useful data, but there is no consolidated run trace with tool timings, retries, denials, hook outputs, compaction events, and gate evidence.

## Architecture direction

### Runtime layers

1. **Core loop**
   - Keep `QueryEngine` small and deterministic.
   - Continue provider-agnostic normalized messages and tools.

2. **Policy middleware**
   - Centralize permissions, risky action classification, scoped write boundaries, and confirmation behavior.
   - Ensure subagents inherit policy unless explicitly narrowed.

3. **Workflow state**
   - Introduce typed stages and quality gates for skills and automated runs.
   - Persist artifacts and evidence as structured objects.

4. **Durable jobs**
   - Extend AgentJob records from durable status/artifact records into resumable records.
   - Add replay context, timeout/retention policy, parent session linkage, and stale-job repair UX.

5. **Plugin/skill registry**
   - Add manifest metadata: version, triggers, preconditions, tools, artifacts, gates, permissions, compatibility.
   - Validate manifests before registration.

6. **Memory retrieval**
   - Keep lightweight memory stable.
   - Add optional enhanced retrieval later: citations, entities, graph edges, and retrieval metrics.

## Prioritized TODO

### P0: Protect existing in-progress runtime isolation work

- [x] Coordinate with Codex through ICC and divide audit/review work.
- [x] Read repository instructions and current core files.
- [x] Run current test baseline.
- [x] Run `npm run build` after final edits.
- [x] Ask Codex to cross-review the roadmap and any implementation patch before final handoff.

Acceptance:

- Existing user changes are not overwritten.
- `npm test` and `npm run build` pass.

### P1: Add runtime performance and trace instrumentation

Implementation slice:

- Add a structured run trace type containing:
  - per-turn API time,
  - per-tool duration,
  - concurrency batch size,
  - retry count,
  - compaction count,
  - permission denials,
  - hook outputs summary.
- Expose trace on `AgentRunResult` and final `SDKResultMessage` without breaking existing fields.
- Add focused tests around tool timing and trace shape.

Why first:

- Without measurement, efficiency claims are subjective.
- Trace data also supports later durable jobs and quality gates.

### P2: Extend durable background subagent jobs to resumable jobs

Implementation slice:

- Keep the current `AgentTool` `run_in_background` contract and `clavue.agent.job` response envelope.
- Persist enough launch context for explicit replay/resume after process restart.
- Add timeout and retention policies.
- Add doctor/reporting support for stale jobs.
- Preserve final output, errors, timing, trace, evidence, and quality gates.

Acceptance:

- Background job can be launched, listed/read, cancelled, completed, marked stale, and resumed or explicitly replayed without blocking the parent loop.
- Tests cover success, failure, cancellation, stale recovery, replay, and namespace isolation.

### P3: Formalize skill/plugin manifests and quality gates

Implementation slice:

- Extend skill metadata with optional:
  - `version`,
  - `preconditions`,
  - `artifactsProduced`,
  - `qualityGates`,
  - `permissions`,
  - `compatibility`.
- Validate registration and expose invalid-manifest errors clearly.
- Add prompt text that teaches models to satisfy skill gates before completion.

Acceptance:

- Existing skills remain compatible.
- Invalid manifests fail fast in tests.
- `SkillTool.prompt` advertises gates and required artifacts when present.

### P4: Add evidence-based run completion

Implementation slice:

- Introduce `Evidence` and `QualityGateResult` types.
- Let tools, skills, hooks, and retro/eval attach evidence.
- Surface evidence in final result and JSON CLI output.

Acceptance:

- CLI `--json` includes evidence when present.
- Tests verify evidence survives `query()`, `run()`, and `Agent.run()`.

### P5: Improve memory retrieval quality

Implementation slice:

- Add citations/provenance fields to retrieved memory output.
- Add staleness metadata and prompt guidance to verify file/function claims before acting.
- Add retrieval scoring tests and small benchmark fixtures.

Acceptance:

- Retrieval order is deterministic and tested.
- Memory entries can show why they were selected.

### P6: Document production integration patterns

Implementation slice:

- Update README after behavior changes.
- Add examples for:
  - trace-aware automation,
  - background subagents,
  - manifest-based skills,
  - evidence-gated completion.

Acceptance:

- Examples run or have focused tests.
- README avoids overpromising brain-grade memory until implemented.

## Collaboration protocol with Codex

- Clavue owns local implementation and test verification in this session.
- Codex independently audits architecture, researches best practices, and reviews proposed patches.
- Before changing shared core runtime files, compare findings and avoid overlapping edits.
- After each implementation slice, ask Codex for a second-opinion review focused on correctness, safety, and scope creep.

## Verification plan

Minimum gates for each code slice:

```bash
npm test
npm run build
```

Targeted gates by area:

```bash
npx tsx --test tests/tools.test.ts
npx tsx --test tests/permissions.test.ts
npx tsx --test tests/runtime-isolation.test.ts
npx tsx --test tests/retro-run.test.ts
npm pack --dry-run --json
```

## Immediate next implementation slice

Start with P1 trace instrumentation because it gives the team measurable evidence about efficiency and quality, while staying additive and compatible with existing public APIs.
