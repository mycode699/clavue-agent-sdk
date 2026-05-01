# Autonomous Issue Workflow Upgrade Plan

Last updated: 2026-05-01

This plan adapts the useful workflow ideas from `smallnest/autoresearch` into the current `clavue-agent-sdk` architecture. The goal is not to copy a shell runner. The goal is to turn issue-driven autonomous development into a typed, auditable, permission-bounded SDK capability.

## Why This Matters

The current SDK already has the right primitives:

- `AgentJob` records with status, heartbeat, stale detection, cancellation, replay, trace, evidence, and quality gates.
- Background subagent batch creation and job summaries.
- Runtime profiles for collect, plan, build, verify, review, ship, and repair.
- `autonomyMode` for low-confirmation development.
- `permissionMode`, tool safety annotations, `canUseTool`, hooks, and `policy_decisions` trace.
- Skills, forked skill jobs, memory, provider fallback, self-improvement, and retro/eval loops.

The missing layer is a first-class issue workflow that composes those primitives into a product-grade development loop:

1. Read an issue from GitHub, local files, or a host-provided source.
2. Classify intent, risk, required gates, and write scope.
3. Create a durable workflow record over `AgentJob`.
4. Run builder, reviewer, fixer, and verifier agents in a bounded loop.
5. Require deterministic gates and optional model/evaluator score before completion.
6. Produce an auditable final artifact that a human can accept, reject, ship, or replay.

## Design Principles

- Keep `AgentJob` as the only durable orchestration substrate.
- Make every tool action auditable through `policy_decisions`.
- Never make GitHub push, PR creation, merge, close, or deploy default behavior.
- Treat autonomous issue work as a workflow profile, not a permission bypass.
- Support local issue files so teams can use the workflow without GitHub credentials.
- Prefer typed APIs first, CLI second, docs/examples third.
- Every behavior must have deterministic tests with stub providers and temp directories.

## Target User Experience

### Programmatic API

```ts
import { runIssueWorkflow } from 'clavue-agent-sdk'

const result = await runIssueWorkflow({
  source: {
    type: 'local',
    issuePath: '.clavue/issues/42.md',
  },
  options: {
    cwd: process.cwd(),
    model: 'gpt-5.5',
    autonomyMode: 'autonomous',
    permissionMode: 'trustedAutomation',
    toolsets: ['repo-edit'],
    allowedTools: ['Bash'],
    maxIterations: 6,
    passingScore: 85,
    requiredGates: ['build', 'tests', 'review-complete'],
  },
})

if (result.status !== 'completed') {
  throw new Error(result.errors?.join('\n') || result.status)
}
```

### CLI

```bash
npx clavue-agent-sdk issue run .clavue/issues/42.md \
  --autonomy autonomous \
  --permission-mode trustedAutomation \
  --toolset repo-edit \
  --allow Bash \
  --max-iterations 6 \
  --passing-score 85 \
  --require-gate build,tests,review-complete \
  --json
```

### Local Issue Layout

```text
.clavue/
  issues/
    42.md
  issue-runs/
    issue_run_<id>.json
```

Local issue files should be plain Markdown with optional frontmatter:

```md
---
id: 42
title: Fix provider fallback regression
labels: [bug, p1]
writeScope: [src/providers, tests]
requiredGates: [build, tests]
---

The fallback model path should not trigger on non-retryable provider errors.
```

## Core Workflow

### 1. Intake

Normalize every issue source into a single `IssueWorkflowInput`:

- `id`
- `title`
- `body`
- `labels`
- `source`
- `repository`
- `writeScope`
- `requiredGates`
- `acceptanceCriteria`
- `riskHints`

Supported sources:

- `local`: `.clavue/issues/*.md`
- `github`: GitHub issue URL, owner/repo/number, or host-supplied issue object
- `inline`: direct title/body object for embedded hosts

Do not fetch network sources in the core normalizer. GitHub access should live behind a tool/provider adapter so hosts can control credentials and policy.

### 2. Planning And Risk Classification

Before editing, run a lightweight planning step that emits:

- inferred intent: bugfix, feature, refactor, docs, test, release, investigation
- required workflow profile: plan, build, verify, review, ship
- tool risk: read-only, local-edit, shell, network, external-state
- default permission recommendation
- stop conditions
- expected verification gates

This should be represented as a structured artifact, not only assistant prose.

### 3. Builder Job

Create one durable `AgentJob` for implementation:

- kind: `subagent`
- role metadata: `builder`
- batch/correlation id: `issue_run_<id>`
- replay input includes normalized issue, write scope, allowed tools, autonomy mode, permission mode, model, and verification expectations

Builder must:

- inspect relevant code first
- make the smallest high-quality implementation
- update or add tests when behavior changes
- run available verification
- emit evidence and quality gates

### 4. Reviewer Job

Create a reviewer job after builder completion. Reviewer should be read-first and gate-focused:

- correctness
- regression risk
- safety/policy issues
- test coverage
- public API compatibility
- docs/README impact

Reviewer output must be machine-readable:

- findings with severity `p0` to `p3`
- pass/fail score
- required fixes
- evidence references

### 5. Fixer Loop

If reviewer finds blocking issues or score is below threshold, create a fixer job:

- input includes builder output, reviewer findings, issue context, and previous trace summary
- max iterations default: `6`
- P0/P1 findings must be fixed or explicitly converted into a blocker
- P2/P3 findings can be fixed opportunistically when low-risk

Do not loop forever. The final result must explain whether the workflow completed, failed gates, hit max iterations, or was blocked by policy.

### 6. Verification

Verification combines deterministic gates and evaluator scoring.

Deterministic gates:

- `npm run build`
- `npm test`
- targeted test commands
- lint/typecheck if configured
- custom host commands

Evaluator gates:

- review score
- issue coverage score
- risk score
- evidence completeness score

The workflow succeeds only when:

- all required deterministic gates pass
- no P0/P1 unresolved findings remain
- score is at or above `passingScore`
- no policy denial blocks required work

### 7. Handoff

Final artifact:

- issue metadata
- status
- summary
- changed files if available
- job ids by role
- final score
- unresolved findings
- deterministic gate output
- evidence
- quality gates
- policy decisions summary
- replay instructions
- optional PR recommendation

GitHub PR creation, merge, close, and comment posting should be separate explicit steps guarded by external-state permissions.

## Public API Surface

### Types

Add these types in `src/types.ts` or a new `src/issue-workflow.ts` with exports from `src/index.ts`:

- `IssueWorkflowSource`
- `IssueWorkflowInput`
- `IssueWorkflowOptions`
- `IssueWorkflowRole`
- `IssueWorkflowFinding`
- `IssueWorkflowScore`
- `IssueWorkflowGate`
- `IssueWorkflowRunRecord`
- `IssueWorkflowResult`
- `IssueWorkflowStatus`

Status values:

- `completed`
- `failed_gate`
- `failed_review`
- `blocked_by_policy`
- `max_iterations`
- `cancelled`
- `error`

### Functions

- `normalizeIssueWorkflowInput(input)`
- `runIssueWorkflow(input)`
- `createIssueWorkflowJobs(input)`
- `summarizeIssueWorkflow(runId)`
- `loadIssueWorkflowRun(runId)`
- `replayIssueWorkflow(runId)`

### Tools

Add tools only after the API is stable:

- `IssueWorkflowRun`
- `IssueWorkflowGet`
- `IssueWorkflowList`
- `IssueWorkflowReplay`

These tools should be optional and should operate over `AgentJob` plus the workflow run record.

## Storage Model

Do not introduce a second job database.

Issue workflow run records should be small indexes that reference job IDs:

```ts
interface IssueWorkflowRunRecord {
  schema_version: string
  id: string
  issue: IssueWorkflowInput
  status: IssueWorkflowStatus
  createdAt: string
  updatedAt: string
  correlation_id: string
  jobs: Array<{
    role: IssueWorkflowRole
    job_id: string
    iteration: number
  }>
  requiredGates: string[]
  passingScore: number
  finalScore?: number
  errors?: string[]
}
```

The source of truth for execution remains `AgentJob`. The workflow record exists only to connect issue metadata, roles, iterations, and final status.

## Safety And Permission Model

Recommended presets:

| Preset | Autonomy | Permission | Use case |
| --- | --- | --- | --- |
| `issue.review` | `proactive` | `default` | Read-only issue analysis |
| `issue.localFix` | `autonomous` | `acceptEdits` | Local file edits without shell/network |
| `issue.devFix` | `autonomous` | `trustedAutomation` | Trusted development with tests |
| `issue.ship` | `supervised` | host-defined | PR, merge, tag, release, deploy |

Rules:

- `autonomyMode` controls initiative only.
- `permissionMode` and tool policy control execution.
- External-state actions require explicit tool availability and host policy.
- GitHub mutation must record policy decisions and evidence.
- Destructive git operations must remain blocked unless explicitly granted.

## CLI Upgrade

Add subcommands after the API is stable:

```bash
clavue-agent-sdk issue run <path-or-url>
clavue-agent-sdk issue list
clavue-agent-sdk issue get <run-id>
clavue-agent-sdk issue replay <run-id>
clavue-agent-sdk issue stop <run-id>
```

Options:

- `--source local|github|inline`
- `--workflow issue.review|issue.localFix|issue.devFix|issue.ship`
- `--autonomy supervised|proactive|autonomous`
- `--permission-mode ...`
- `--toolset ...`
- `--allow ...`
- `--deny ...`
- `--max-iterations <n>`
- `--passing-score <n>`
- `--require-gate <names>`
- `--json`

## Implementation Slices

### Slice 1: Local Issue Normalizer

Files:

- `src/issue-workflow.ts`
- `src/index.ts`
- `tests/issue-workflow.test.ts`
- README

Deliverables:

- Parse local Markdown issue files.
- Normalize inline issue objects.
- Validate required fields.
- Export public types and helper.

Acceptance gates:

- Temp-dir tests for local issue parsing.
- Invalid frontmatter and missing files return typed errors.
- `npm run build`
- `npm test`

### Slice 2: Issue Workflow Run Record

Files:

- `src/issue-workflow.ts`
- `src/types.ts`
- `tests/issue-workflow.test.ts`

Deliverables:

- Create/load/list run records.
- Store under `.clavue/issue-runs` or configurable env/option path.
- Reference `AgentJob` IDs; do not duplicate job state.

Acceptance gates:

- Run records cannot escape configured directory.
- Existing `AgentJob` APIs remain unchanged.

### Slice 3: Builder/Reviewer/Fixer/Verifier Loop

Files:

- `src/issue-workflow.ts`
- `src/tools/agent-tool.ts` if shared helper is needed
- `tests/issue-workflow.test.ts`

Deliverables:

- Create role jobs using `createAgentJob`.
- Use batch/correlation metadata for a single issue run.
- Execute bounded iterations.
- Collect job traces, evidence, quality gates, and policy summaries.

Acceptance gates:

- Stub provider test proves builder -> reviewer -> fixer -> verifier order.
- Max iteration stop is deterministic.
- Policy denial produces `blocked_by_policy`.

### Slice 4: Scoring And Gate Contract

Files:

- `src/issue-workflow.ts`
- `src/evaluation-loop.ts` or `src/retro/` integration
- `tests/issue-workflow.test.ts`

Deliverables:

- Define `IssueWorkflowScore`.
- Combine deterministic quality gates and evaluator score.
- Fail if required gates are missing or failed.

Acceptance gates:

- Missing required gate fails.
- Low score fails.
- Passing score and gates complete the run.

### Slice 5: CLI Issue Subcommands

Files:

- `src/cli.ts`
- `tests/cli.test.ts`
- README

Deliverables:

- `issue run`
- `issue get`
- `issue list`
- `issue replay`
- JSON output for automation.

Acceptance gates:

- CLI tests use temp issue files and stub provider path where possible.
- Existing one-shot CLI behavior stays compatible.

### Slice 6: GitHub Adapter

Files:

- `src/issue-workflow-github.ts`
- `src/tools/github-issue-tools.ts` or host adapter docs
- `tests/issue-workflow-github.test.ts`

Deliverables:

- Read GitHub issue by URL or owner/repo/number.
- Optional comment/PR recommendation artifact.
- Mutating GitHub actions remain separate and explicit.

Acceptance gates:

- Unit tests stub fetch.
- No live network dependency in default tests.
- GitHub mutation requires explicit external-state permission.

## Best-Practice Upgrade Over Autoresearch

This SDK should exceed a shell runner by adding:

- typed public API
- provider-agnostic execution
- structured event stream
- durable job records
- policy decision traces
- redacted input summaries
- explicit permission and autonomy separation
- local and hosted issue sources
- deterministic unit tests
- reusable workflow result artifacts

## Open Questions Before Implementation

- Should issue workflow records live under `.clavue/issue-runs` by default or under `~/.clavue-agent-sdk/issue-runs`?
- Should GitHub support be core, optional tool package, or host adapter only?
- Should scoring reuse `retro` evaluators or define a smaller issue-specific evaluator?
- Should PR creation be a separate `ship` workflow or an optional finalizer tool?
- Should multi-agent review use the same provider/model by default or require role-specific model routing?

## Recommended Priority

Implement after the current 0.7 contract stabilization is complete:

1. Local issue normalizer.
2. Issue run record over `AgentJob`.
3. Builder/reviewer/fixer/verifier loop.
4. Scoring and deterministic gates.
5. CLI issue subcommands.
6. GitHub adapter and PR finalizers.

This gives the project a concrete path from low-confirmation autonomous development into fully auditable issue-to-fix workflows.
