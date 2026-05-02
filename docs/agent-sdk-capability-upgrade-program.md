# Agent SDK Capability Upgrade Program

Last updated: 2026-04-28

## Executive Goal

Upgrade `clavue-agent-sdk` from a capable coding-agent SDK into a general agent operating layer for software development, research, collection, organization, planning, verification, decision support, and operational problem solving.

The product direction is not “more tools.” The direction is higher-leverage agent work:

- Agents are faster to create and cheaper to start.
- Context is packed, traced, and budgeted before model calls.
- Memory becomes a workspace knowledge layer with provenance, validation, and retrieval evidence.
- Skills are easy to create, validate, enforce, and improve.
- Self-learning converts repeated failures and successful workflows into reusable memories, checklists, and skills.
- Interaction logic supports collection, organization, planning, solving, verification, review, and shipping, not only code editing.

## Operating Principle

Every new capability must satisfy four gates:

- **Runtime gate**: deterministic API behavior with tests.
- **Trace gate**: host apps can inspect what happened and why.
- **Workflow gate**: the capability maps to a user-facing workflow or artifact.
- **Learning gate**: successful or failed runs can produce reusable evidence, memory, or skill improvements when enabled.

## Symphony-Derived SDK Principles

The useful lesson from OpenAI Symphony is not to copy a specific daemon or tracker integration first. The durable lesson is a higher-level execution contract:

- **Repository-owned workflow contract**: agent behavior should be versioned with the codebase through a `WORKFLOW.md`-style prompt and config contract.
- **Strict prompt rendering**: unknown variables or filters should fail explicitly instead of producing silent, low-quality runs.
- **Typed config resolution**: defaults, `$ENV` indirection, workspace paths, concurrency, timeouts, and tracker settings should be resolved before dispatch.
- **Per-work isolation**: every issue or task should map to a deterministic workspace key and path before execution starts.
- **Observable lifecycle**: runs should expose explicit phases, status, evidence, quality gates, retries, and errors rather than relying on prose summaries.
- **Supervisor before feature sprawl**: add orchestration only when the lower-level contract is testable and reusable by SDK hosts.

Current SDK action: keep external trackers, daemons, PR automation, and dashboards out of the core until the contract layer is stable. The first core addition is the exported workflow contract utility:

- `parseWorkflowDefinition()`
- `loadWorkflowDefinition()`
- `renderWorkflowPrompt()`
- `resolveWorkflowServiceConfig()`
- `validateWorkflowDispatchConfig()`
- `normalizeWorkspaceKey()`
- `getWorkflowWorkspacePath()`

The second core addition is a host-neutral proof-of-work artifact:

- `createProofOfWork()`
- `PROOF_OF_WORK_SCHEMA_VERSION`
- `ProofOfWorkArtifact`
- `ProofOfWorkReference`
- `ProofOfWorkStatus`

This is the SDK-safe version of Symphony's PR/CI handoff lesson. The SDK should not directly own GitHub, Linear, Jira, PR, or CI integrations by default. Instead, it should standardize the artifact shape so hosts can attach external issue, PR, CI, commit, review, dashboard, or log references when they have those systems available.

The third core addition is a host-neutral orchestration policy layer:

- `selectDispatchCandidates()`
- `calculateRetryDelayMs()`
- `shouldReleaseIssueForState()`
- `OrchestrationIssue`
- `DispatchSelection`

This is the SDK-safe version of Symphony's scheduler lesson. The SDK should not own the poll loop, external tracker client, worker process, or dashboard by default. Instead, it should standardize the deterministic policy decisions that every host orchestrator needs: active/terminal state checks, claimed/running exclusion, blocker handling, priority sorting, global and per-state concurrency slots, release decisions, and capped retry backoff.

Together, workflow contracts, proof-of-work artifacts, and orchestration policy let host applications and future issue workflows adopt Symphony-grade discipline without forcing a specific task board, CI vendor, repository host, worker process model, or long-running service.

## Product Workflow Modes

The SDK should expose or document first-class workflow modes. These can start as presets over existing options before becoming deeper runtime APIs.

| Mode | Purpose | Typical tools | Memory policy | Required artifacts |
| --- | --- | --- | --- | --- |
| `collect` | Gather source material, MCP resources, web pages, files, or user inputs | `research`, `mcp`, `repo-readonly` | `brainFirst` when previous context matters | sources, citations, collection summary |
| `organize` | Turn raw material into tagged notes, summaries, todos, and decisions | `repo-readonly`, `tasks`, `skills` | `autoInject` plus durable saves | organized notes, tags, open questions |
| `plan` | Define scope, assumptions, sequence, risks, and gates | `planning`, `repo-readonly` | `brainFirst` for repo/project work | plan, acceptance criteria, risks |
| `solve` | Diagnose ambiguous problems through hypotheses and checks | `repo-readonly`, `research`, `skills`, selected shell | `brainFirst` | hypotheses, evidence, verification path |
| `build` | Execute a scoped implementation or content change | `repo-edit`, selected shell | `autoInject` or `brainFirst` | patch, changed files, rationale |
| `verify` | Prove behavior with tests, checks, review, or manual evidence | selected shell, `repo-readonly` | `off` or `autoInject` | test output, gate results |
| `review` | Find defects, risks, missing evidence, and weak assumptions | `repo-readonly` | `brainFirst` | findings, file references, residual risk |
| `ship` | Prepare handoff, release notes, package checks, or final report | `repo-readonly`, package tools | `autoInject` | release/handoff summary |

Initial implementation can be a typed `workflowMode` preset that expands into `toolsets`, `permissionMode`, lifecycle skills, `memory.policy`, and `qualityGatePolicy`.

## Program Waves

### Wave 1: Runtime Profiles And Model Capability

Goal: make agents faster and safer to create.

Deliverables:

- Model capability registry with conservative defaults.
- Provider fallback and normalized error categories.
- Reusable runtime profiles for common workflows.
- Benchmark coverage for startup and context-build cost.

Likely files:

- `src/providers/types.ts`
- `src/providers/index.ts`
- `src/providers/openai.ts`
- `src/providers/anthropic.ts`
- `src/agent.ts`
- `src/engine.ts`
- `src/tools/index.ts`
- `src/types.ts`
- `tests/openai-provider.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Hosts can call a deterministic model capability API before running an agent.
- Unknown models return safe, conservative capabilities.
- Existing provider behavior stays compatible.
- Startup/context-build benchmark metrics exist.
- `npx tsx --test tests/openai-provider.test.ts`
- `npm run build`
- `npm test`

### Wave 2: Context Pipeline

Goal: replace monolithic prompt assembly with budgeted, inspectable context packing.

Deliverables:

- `ContextPack` or `ContextPipeline` planner.
- Section budgets for system instructions, tools, skills, project docs, git context, memories, and user-provided context.
- Trace fields for included, dropped, and truncated context sections.
- Token estimates before provider calls.
- Compaction trace with trigger, token estimates, summary size, message counts, dropped volume, and failure reason.

Likely files:

- `src/engine.ts`
- `src/utils/context.ts`
- `src/utils/compact.ts`
- `src/utils/tokens.ts`
- `src/types.ts`
- `tests/context.test.ts`
- New `tests/compact.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Context packing is deterministic in tests.
- Host apps can inspect why a context section was included, dropped, or truncated.
- Compaction emits structured trace, not only a count.
- Existing prompt behavior remains compatible unless explicitly changed.
- `npm test`
- `npm run build`

### Wave 3: Memory As Workspace Knowledge

Goal: make memory useful, trustworthy, and debuggable.

Deliverables:

- Retrieval trace as a first-class artifact: retrieval ID, duration, store, candidate count, selected count, strategy, filters, score breakdown, redaction status.
- Rich retrieval results with matched fields, score components, scope precedence, recency/staleness, validation state, and reason codes.
- `brainFirst` semantics that are meaningfully stricter than `autoInject`: mandatory retrieval planning, explicit fallback/block behavior when configured, and visible trace.
- Rolling session intelligence: goals, decisions, files/resources touched, unresolved risks, verification status, preferences, and open todos.
- Project memory keyed by repo path and git identity, with drift detection and validation timestamp.

Likely files:

- `src/memory.ts`
- `src/memory-policy.ts`
- `src/engine.ts`
- `src/agent.ts`
- `src/session.ts`
- `src/utils/context.ts`
- `src/types.ts`
- `tests/memory.test.ts`
- `tests/memory-integration.test.ts`
- `tests/context.test.ts`
- `tests/benchmark.test.ts`

Acceptance gates:

- Memory trace explains why selected memories were selected.
- Stale or unvalidated repo memories are visible as risk, not silently trusted.
- Global and repo memories can be queried together when configured.
- Session summaries cover more than the last exchange.
- Retrieval quality fixtures include distractors and stale entries.
- `npm test`
- `npm run build`

### Wave 4: Skill Creation And Enforcement

Goal: make skills easy to author and hard to misuse.

Deliverables:

- Public `validateSkillDefinition()` or `validateSkillManifest()` API.
- Validation for alias collisions, duplicate names, unknown tools, permissions drift, forked agent existence, `outputSchema`, compatibility, and quality-gate command consistency.
- Optional runtime enforcement for skill preconditions, required artifacts, and required gates.
- Skill authoring APIs: `createSkill()`, `skillFromManifest()`, and `loadSkillsFromDir()`.
- Filesystem skill format based on a manifest plus `SKILL.md` prompt body.
- Bundled authoring workflow skills: `create-skill`, `validate-skill`, `create-tool`, `validate-tool`.

Likely files:

- `src/skills/types.ts`
- `src/skills/registry.ts`
- `src/skills/index.ts`
- `src/tools/skill-tool.ts`
- `src/engine.ts`
- `src/types.ts`
- New `src/skills/authoring.ts`
- New `src/skills/loader.ts`
- New `src/skills/bundled/authoring.ts`
- `tests/skills.test.ts`
- `tests/skills-loader.test.ts`
- `tests/package-payload.test.ts`

Acceptance gates:

- Invalid skills fail before registration.
- Required skill gates can fail a run when enforcement is enabled.
- Filesystem skills load deterministically from temp fixtures.
- Skill authoring APIs are exported and package payload tests cover them.
- `npm test`
- `npm run build`

### Wave 5: Self-Learning And Skill Promotion

Goal: convert repeated work and failures into durable capability improvements.

Deliverables:

- Skill-aware self-improvement extraction: active skill name, args, failed preconditions, missing artifacts, failed gates, tools used, and repair outcome.
- Memory validation lifecycle: `observed`, `reused`, `confirmed`, `stale`, `rejected`.
- Duplicate clustering and confidence decay for improvement memories.
- “Promote repeated lesson to skill/checklist” planning output.
- Skill-specific retro evaluators: manifest quality, prompt process, evidence gates, minimal tool surface, examples/tests, and risk docs.

Likely files:

- `src/improvement.ts`
- `src/memory.ts`
- `src/memory-policy.ts`
- `src/engine.ts`
- `src/retro/evaluators.ts`
- New `src/retro/skill-evaluators.ts`
- `tests/improvement.test.ts`
- `tests/memory.test.ts`
- `tests/retro-skills.test.ts`

Acceptance gates:

- Improvement memories contain skill/gate/artifact tags when available.
- Reused memories can be confirmed or rejected by later evidence.
- Repeated lessons can produce a structured skill/checklist proposal.
- Skill retro evaluators are deterministic.
- `npm test`
- `npm run build`

### Wave 6: Reusable Agents And Workflow Templates

Goal: make the SDK useful for deep participation in work beyond coding.

Deliverables:

- Built-in subagents beyond `Explore` and `Plan`: `Research`, `Reviewer`, `Verifier`, `Debugger`, `Operator`, `Writer`, `DataAnalyst`, `IncidentCommander`, and `DecisionFacilitator`.
- Typed workflow templates such as:
  - `research -> organize -> decide -> plan`
  - `define -> solve -> verify -> repair`
  - `collect -> outline -> draft -> fact-check -> ship`
  - `incident -> mitigate -> root-cause -> prevent`
- Artifact contracts for sources, organized collections, decisions, plans, assumptions, open questions, verification evidence, risks, and next actions.
- Public event contract docs for UI builders.

Likely files:

- `src/tools/agent-tool.ts`
- `src/types.ts`
- New `src/workflows/`
- `src/skills/bundled/workflow.ts`
- `tests/workflows.test.ts`
- README/examples after runtime behavior lands.

Acceptance gates:

- Workflow templates are typed and testable.
- Built-in agents declare tools, max turns, evidence expectations, and output shape.
- Host apps can render workflow progress from structured events.
- `npm test`
- `npm run build`

## Clavue Execution Order

Clavue should continue the currently assigned provider/model capability slice first, then move to context and memory work.

1. Finish model capability registry and provider fallback/error tests.
2. Add runtime profile/startup benchmark planning if capability work stays green.
3. Implement `ContextPack` planning and trace.
4. Deepen memory retrieval trace and `brainFirst` semantics.
5. Implement exported skill validation and enforced skill gates.
6. Add skill authoring/scaffolding APIs.
7. Add self-learning promotion and skill retro evaluators.
8. Add reusable agents and workflow templates.

Do not jump to reusable agents or workflow templates before context, memory, and skill enforcement are stable.

## Codex Ownership

Codex owns:

- Public docs and roadmap consistency.
- Workflow-mode product framing.
- Final docs verification.
- Review of public API names and examples.
- Cross-slice quality control.

Codex should avoid editing `src/providers/*` while Clavue owns the model capability slice.

## Required Verification

Every slice must run:

```bash
npm run build
npm test
```

Add focused tests per slice:

```bash
npx tsx --test tests/openai-provider.test.ts
npx tsx --test tests/context.test.ts
npx tsx --test tests/memory.test.ts tests/memory-integration.test.ts
npx tsx --test tests/skills.test.ts
npx tsx --test tests/improvement.test.ts
npx tsx --test tests/benchmark.test.ts
```

No slice is complete unless tests, exports, package payload, docs handoff, and limitations are explicit.
