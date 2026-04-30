# Agent Runtime Roadmap

Last updated: 2026-04-28

This roadmap captures the current state of `clavue-agent-sdk`, the main gaps found by Codex and Clavue, and the implementation order for improving functionality, efficiency, quality, and agent best-practice alignment.

For the broader product and architecture upgrade program, use `docs/agent-sdk-capability-upgrade-program.md` as the controlling document. That program expands the SDK beyond coding automation into collection, organization, planning, problem solving, memory intelligence, skill creation, self-learning, and workflow templates.

## Baseline

- `npm run build` passes.
- `npm test` passes: 151 tests.
- Focused gate passes: `npx tsx --test tests/permissions.test.ts tests/memory-integration.test.ts tests/doctor.test.ts tests/package-payload.test.ts`.
- Current strengths: in-process agent loop, provider abstraction, tool registry and named toolsets, MCP integration, hooks, sessions, structured memory, bundled skills, lifecycle workflow skills, subagents, durable background AgentJobs, retro/eval, runtime namespace isolation, doctor checks, benchmark API, and package/CLI regression coverage.
- Current risk: the code has advanced faster than public docs and examples. Stabilization now matters more than adding more primitives.
- Audit note: `src/benchmark.ts` needed one TypeScript initialization fix during this review; after that `npm run build`, package payload tests, focused gates, and full `npm test` all passed.

## External Practice Baseline

- `addyosmani/agent-skills`: skills should be lifecycle workflows, not prose. Each skill needs process steps, anti-rationalization guidance, and verification evidence.
- `garrytan/gbrain`: keep the harness thin and move operational intelligence into skills, but make memory and jobs durable, searchable, auditable, and health-checked.
- `garrytan/gstack`: product-quality agent work needs explicit think-plan-build-review-test-ship loops, specialist review gates, safety modes, browser/runtime verification where relevant, and second-opinion review.

## Priority Findings

### P0. Skill Execution Is Advisory, Not Enforced

Status: mostly completed for activation constraints; not complete for automatic precondition/gate enforcement.

Completed:

- Inline skill activations now inject the skill prompt, model override, and allowed tool set into the active engine run.
- Forked skill activations now create durable background AgentJobs through the shared subagent runner.
- Forked skill jobs preserve trace, evidence, and quality gate artifacts.

Remaining evidence:

- Skill-level hooks and typed manifest preconditions are not yet enforced.
- Quality gates can be terminal through `qualityGatePolicy`, but skills do not yet automatically require their own gates without caller policy.

Impact:

- Skills are now executable enough to constrain prompt, tools, model, and forked job behavior.
- The remaining gap is turning skill preconditions and required evidence into automatic blockers rather than metadata and caller-enforced policies.

Implementation slices:

1. Add a typed `SkillActivation` result from `SkillTool`.
2. Teach `QueryEngine` to recognize skill activation results.
3. For inline activation, inject the skill prompt and temporarily constrain tool/model/hook state.
4. For forked activation, route through a shared subagent helper.
5. Add stub-provider tests proving skill `allowedTools`, `model`, and `context` are honored.

Acceptance gates:

- Focused tests for `SkillTool` activation.
- `npm test`.
- `npm run build`.

### P0. Skill And Tool Prompt Surfacing Is Weak

Status: completed in the current working tree.

Evidence:

- The default system prompt includes bounded enabled tool prompt fragments.
- The `Skill` tool prompt uses the registry formatter with triggers, argument hints, artifacts, gates, and enabled-skill filtering.
- Tests cover disabled tool/skill omission and oversized prompt truncation.

Impact:

- Skill and tool routing is now materially more visible to the model.
- Remaining work is documentation and prompt-budget monitoring, not core functionality.

Implementation slices:

1. Add a tool prompt collection step in `buildSystemPrompt()`.
2. Use `formatSkillsForPrompt()` as the single skill listing implementation.
3. Include `whenToUse` and `argumentHint` within a strict prompt budget.
4. Add tests that inspect provider `system` text with a stub provider.

Acceptance gates:

- Stub-provider test verifying skill triggers and tool prompt fragments are present.
- Tests verifying disabled tools/skills are omitted.
- `npm test`.
- `npm run build`.

### P0. Delivery Workflow Gates Are Not First-Class

Status: mostly completed for run-level gate semantics; partially completed for full workflow automation.

Evidence:

- Bundled lifecycle skills now cover define, plan, build, verify, workflow-review, ship, and repair.
- Skill manifests expose artifacts and quality gates.
- `qualityGatePolicy` can make failed or missing required gates produce `error_quality_gate_failed`.

Impact:

- Hosts can now make configured gates terminal.
- The SDK still needs docs and examples showing how hosts should wire required workflow gates for production runs.

Implementation slices:

1. Add bundled lifecycle skills: `plan`, `verify`, `ship`, and `workflow`.
2. Encode each lifecycle skill as process steps plus required evidence.
3. Add a small `VerificationGate` or `SkillChecklist` metadata type.
4. Expose optional run-level gate artifacts in `AgentRunResult`.

Acceptance gates:

- Tests for bundled lifecycle skill registration and prompts.
- A stub workflow test proving verification requirements are returned in structured metadata.
- `npm test`.
- `npm run build`.

### P1. Safety Modes Need Built-In Semantics

Status: completed for built-in tool policy defaults in the current working tree.

Evidence:

- Tool safety annotations are present on built-in tools.
- Built-in policy now denies unsafe tools before host `canUseTool` can override the denial.
- `default`, `plan`, and `acceptEdits` modes have focused tests.
- Subagent permission inheritance remains covered.

Impact:

- Hosts no longer need to rebuild the common read-only, plan-freeze, and accept-edits policy baseline.
- Remaining safety work is finer policy tracing, MCP live classification, and doc clarity.

Implementation slices:

1. Add built-in default policy semantics for `plan`, `acceptEdits`, and `trustedAutomation`.
2. Add tool safety annotations: read, write, shell, network, external state, destructive.
3. Make `plan` deny mutating tools except explicit plan-exit/user-question tools.
4. Add tests for each permission mode.

Acceptance gates:

- Focused permission tests.
- Tests confirming subagents inherit the same policy.
- `npm test`.
- `npm run build`.

### P1. Memory Is Useful But Not Brain-First

Status: completed for policy modes and basic trace; partial for rich provenance and retrieval quality.

Evidence:

- `memory.policy.mode` supports `off`, `autoInject`, and `brainFirst`.
- Brain-first retrieval happens before the first provider call.
- Final run trace records policy, query, repo path, selected IDs, injected count, and pre-model-call status.

Impact:

- Memory use is now auditable at a basic level.
- It is still not brain-grade until scores, source/scope/confidence, validation state, staleness, and retrieval benchmarks are richer.

Implementation slices:

1. Add `memoryPolicy`: `off`, `autoInject`, `brainFirst`.
2. In `brainFirst`, perform memory retrieval before the first provider call and record trace metadata.
3. Add structured memory evidence fields for source, validation state, and optional references.
4. Add a small deterministic memory retrieval benchmark fixture.

Acceptance gates:

- Test proving retrieval happens before first provider call.
- Test proving memory trace appears in result metadata.
- Memory benchmark fixture with expected top result.
- `npm test`.
- `npm run build`.

### P1. Background AgentJobs Are Durable, But Not Fully Resumable

Evidence:

- `AgentTool` supports `run_in_background` and persists job records with output, trace, evidence, quality gates, cancellation state, runner heartbeat, and stale detection.
- `AgentJobList`, `AgentJobGet`, and `AgentJobStop` expose status inspection and cancellation.
- Public APIs include `createAgentJob()`, `getAgentJob()`, `listAgentJobs()`, `stopAgentJob()`, and `clearAgentJobs()`.
- In-process jobs cannot yet resume active provider/tool execution after process death; stale jobs are marked stale instead.

Impact:

- Complex multi-agent runs are now inspectable and auditable.
- True process-restart continuation still requires a resumable execution runner.

Implementation slices:

1. Add process-restart resume semantics for queued/stale jobs.
2. Persist enough input/provider/tool context for safe replay.
3. Add optional timeout policy per job.
4. Add CLI or doctor support for listing stale jobs and storage health.

Acceptance gates:

- Tests proving queued job resume or explicit stale recovery.
- Runtime namespace isolation tests for concurrent background runs.
- `npm test`.
- `npm run build`.

### P2. Efficiency Is Not Measured

Status: initial benchmark API completed; coverage still needs expansion.

Evidence:

- `runBenchmarks()` exists and emits machine-readable metrics without network/API calls.
- Tests cover read-only fan-out, serial mutation ordering, context build, memory query, and agent job storage metrics.

Impact:

- The SDK has a first measurement foothold.
- Next measurement work should add provider conversion, compaction, subagent startup, and stable CLI/script output before setting budgets.

Implementation slices:

1. Add a lightweight benchmark script under `tests` or `examples`.
2. Measure read-only tool fan-out, serial mutation ordering, context compaction, memory query latency, and subagent startup.
3. Emit machine-readable JSON for CI comparison.
4. Keep budgets advisory at first; enforce only after baseline stabilization.

Acceptance gates:

- `npm run build`.
- `npm test`.
- Benchmark script produces JSON without network/API calls.

### P2. Operator Health Checks Are Missing

Status: initial API completed.

Evidence:

- `doctor()` is exported and returns structured checks for provider config, tools, skills, MCP config, storage, jobs, and package entrypoints.
- Focused tests cover ready checks and actionable warning/error cases without network calls.

Impact:

- Hosts can now validate baseline runtime readiness.
- Remaining operator work is stale-job recovery reporting, live MCP connection health, CLI command UX, and docs.

Implementation slices:

1. Add exported `doctor()` API returning structured checks.
2. Check provider credentials presence, toolset names, enabled skills, MCP configs, session dir, memory dir, and package entrypoints.
3. Add CLI command later after API stabilizes.

Acceptance gates:

- Unit tests for passing and failing doctor checks.
- Package payload test if exported API changes.
- `npm test`.
- `npm run build`.

## Recommended TODO Order

1. Finish the currently assigned model capability registry and provider fallback/error policy slice.
2. Add reusable runtime profiles and startup/context-build benchmark coverage.
3. Extract a budgeted, traceable `ContextPack` / `ContextPipeline`.
4. Deepen memory trace provenance, retrieval quality, and `brainFirst` semantics.
5. Add exported skill validation and optional skill gate/precondition enforcement.
6. Add skill authoring/scaffolding APIs and bundled authoring skills.
7. Make self-improvement skill-aware and able to propose skill/checklist promotion.
8. Add reusable agents, workflow templates, and public event/artifact contracts.

## Development Rules For This Roadmap

- Implement one vertical slice at a time.
- Each slice must include tests before moving to the next slice.
- Keep public API changes explicit in `src/index.ts`, README examples, and package payload tests.
- Prefer deterministic tests with stub providers over live model calls.
- Do not claim efficiency improvements without a measurement script.
- Do not expand skill count without adding routing and activation tests.
- Do not start another large runtime slice until README/API docs cover the current feature batch.

## Coordination Protocol

- Codex and Clavue should independently review each slice before implementation when the slice affects public API or agent safety.
- One agent should own implementation for a slice; the other should review, test, and challenge assumptions.
- If both agents edit concurrently, use disjoint write scopes.
- All shared findings should be converted into tests or roadmap TODOs, not left as chat-only knowledge.
