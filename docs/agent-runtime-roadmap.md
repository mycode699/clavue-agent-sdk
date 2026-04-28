# Agent Runtime Roadmap

Last updated: 2026-04-28

This roadmap captures the current state of `clavue-agent-sdk`, the main gaps found by Codex and Clavue, and the implementation order for improving functionality, efficiency, quality, and agent best-practice alignment.

## Baseline

- `npm run build` passes.
- `npm test` passes: 136 tests.
- Current strengths: in-process agent loop, provider abstraction, tool registry and named toolsets, MCP integration, hooks, sessions, structured memory, bundled skills, subagents, durable background AgentJobs, retro/eval, and runtime namespace isolation.
- Current risk: many high-level capabilities are present as primitives or metadata, but not all are enforced as durable workflow contracts.

## External Practice Baseline

- `addyosmani/agent-skills`: skills should be lifecycle workflows, not prose. Each skill needs process steps, anti-rationalization guidance, and verification evidence.
- `garrytan/gbrain`: keep the harness thin and move operational intelligence into skills, but make memory and jobs durable, searchable, auditable, and health-checked.
- `garrytan/gstack`: product-quality agent work needs explicit think-plan-build-review-test-ship loops, specialist review gates, safety modes, browser/runtime verification where relevant, and second-opinion review.

## Priority Findings

### P0. Skill Execution Is Advisory, Not Enforced

Status: partially completed.

Completed:

- Inline skill activations now inject the skill prompt, model override, and allowed tool set into the active engine run.
- Forked skill activations now create durable background AgentJobs through the shared subagent runner.
- Forked skill jobs preserve trace, evidence, and quality gate artifacts.

Remaining evidence:

- Skill-level hooks and typed manifest preconditions are not yet enforced.
- Quality gates are observable artifacts, not terminal success/failure semantics yet.

Impact:

- Skills act as prompt snippets, not executable workflow units.
- The SDK cannot yet guarantee that a review/test/ship skill actually runs with the intended tools, model, and gates.

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

Evidence:

- `formatSkillsForPrompt()` exists, but the engine does not use it in the default system prompt.
- Several tools define `prompt()` methods, but `buildSystemPrompt()` only lists tool names and descriptions.

Impact:

- Skill routing depends too much on the model discovering a generic `Skill` tool.
- Tool-specific operating rules are not consistently visible.
- Progressive disclosure is weaker than the agent-skills pattern.

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

Evidence:

- Bundled skills cover review/debug/test/commit/simplify, but there is no first-class Define -> Plan -> Build -> Verify -> Review -> Ship loop.
- Retro/eval exists, but regular agent runs do not naturally produce proof-gate artifacts unless the caller wires it.

Impact:

- The agent can skip verification if the model fails to follow instructions.
- Quality depends on prompt discipline rather than SDK-level workflow structure.

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

Evidence:

- Permission modes are mostly metadata plus prompt text.
- Enforcement is delegated to host-provided `canUseTool`.
- `plan` mode is not an edit freeze by default.

Impact:

- Hosts must rebuild common safety behavior.
- SDK defaults are less safe than gstack-style `careful`, `freeze`, and `guard` modes.

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

Evidence:

- Memory injection is optional and based on simple JSON file scans and text matching.
- There is no mandatory lookup trace, typed linking, citation/evidence model, or retrieval benchmark.

Impact:

- The SDK has memory, but not brain-grade retrieval.
- Agents can act without checking durable context.

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

Evidence:

- Read-only concurrency and micro-compaction exist.
- There is no benchmark harness for tool throughput, context size, subagent latency, memory retrieval quality, or provider conversion overhead.

Impact:

- The current code is plausibly efficient for unit-scale use, but “fast enough” cannot be proven.
- Regressions can land without visibility.

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

Evidence:

- There is no SDK-level `doctor()` equivalent.
- CLI is currently one-shot prompt oriented.

Impact:

- Users cannot easily validate provider config, MCP connectivity, skill registry state, memory/session paths, or package health.

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

1. Integrate skill/tool prompt surfacing.
2. Enforce skill activation semantics.
3. Add lifecycle workflow skills and proof-gate metadata.
4. Enforce built-in safety policy modes.
5. Add brain-first memory policy and trace metadata.
6. Add process-restart resume semantics for durable AgentJobs.
7. Add benchmark harness.
8. Add `doctor()` health checks.

## Development Rules For This Roadmap

- Implement one vertical slice at a time.
- Each slice must include tests before moving to the next slice.
- Keep public API changes explicit in `src/index.ts`, README examples, and package payload tests.
- Prefer deterministic tests with stub providers over live model calls.
- Do not claim efficiency improvements without a measurement script.
- Do not expand skill count without adding routing and activation tests.

## Coordination Protocol

- Codex and Clavue should independently review each slice before implementation when the slice affects public API or agent safety.
- One agent should own implementation for a slice; the other should review, test, and challenge assumptions.
- If both agents edit concurrently, use disjoint write scopes.
- All shared findings should be converted into tests or roadmap TODOs, not left as chat-only knowledge.
