# Embedded Automation Control Plane Design

Date: 2026-04-15
Topic: server-side control plane for an embeddable automated agent SDK
Status: approved direction in chat; implementation pending

## Goal

Add a machine-consumable control plane that decides what an embedded agent should do next after retro/eval observation and run comparison.

This is not a human report layer. The SDK should expose typed decisions that host applications can consume and execute through their own runtime, UI, job system, tool adapters, or agent workers.

## Non-goals

- Do not generate markdown or human-facing reports.
- Do not execute fixes directly in this slice.
- Do not bind the SDK to one CLI, UI, worker queue, or hosting model.
- Do not call models or tools from the policy layer.

## Architecture

The automation system has three separate layers.

1. Observation
   - Existing `runRetroEvaluation()` creates a typed run result.
   - Existing `compareRetroRuns()` compares current and previous runs.
   - Observation records state; it does not decide or execute.

2. Decision
   - New deterministic policy engine converts run state into a typed next action.
   - It is pure and side-effect free.
   - It returns machine-readable action plans for host software.

3. Execution
   - Not implemented in this slice.
   - Future host-provided adapters can execute actions through patching, retesting, escalation, ticketing, repair agents, or app-specific workflows.

## Public API

Add a policy module under `src/retro/policy.ts`.

Primary function:

```ts
decideRetroAction(input: RetroPolicyInput): RetroActionPlan
```

Core types:

```ts
type RetroActionKind =
  | 'attempt_fix'
  | 'retest'
  | 'retry_with_more_context'
  | 'escalate'
  | 'defer'
  | 'stop'

interface RetroPolicy {
  maxAttempts?: number
  minimumOverallScore?: number
  escalateSeverity?: RetroSeverity
  allowedActions?: RetroActionKind[]
}

interface RetroPolicyInput {
  run: RetroRunResult
  previousRun?: RetroRunResult
  comparison?: RetroRunComparison
  attemptCount?: number
  policy?: RetroPolicy
}

interface RetroActionPlan {
  kind: RetroActionKind
  reason: string
  priority: number
  findingIds: string[]
  constraints: Record<string, unknown>
}
```

## Initial decision rules

Rules are deterministic and evaluated in priority order.

1. Stop when there are no findings
   - Action: `stop`
   - Reason: no actionable findings exist.

2. Escalate repeated unresolved high-priority work
   - If `attemptCount >= maxAttempts` and actionable high-priority findings remain.
   - Action: `escalate`
   - Reason: retry budget exhausted.

3. Attempt fix for critical/high fix findings
   - If current run contains `critical` or `high` findings with disposition `fix`.
   - Action: `attempt_fix`
   - Reason: severe actionable findings remain.

4. Attempt fix when score drift worsens
   - If comparison exists and the overall score delta is negative with current actionable findings.
   - Action: `attempt_fix`
   - Reason: current run regressed.

5. Defer defer-only findings
   - If remaining findings are all `defer`.
   - Action: `defer`
   - Reason: no immediate action allowed.

6. Stop for preserve-only findings
   - If remaining findings are all `preserve`.
   - Action: `stop`
   - Reason: only strengths were recorded.

7. Retest when comparison is missing but findings exist
   - Action: `retest`
   - Reason: baseline needed before deciding long-term drift.

## Allowed action constraints

If `allowedActions` is provided, the policy must not return an action outside that set.

Fallback order when the preferred action is disallowed:

1. `escalate`
2. `defer`
3. `stop`

This keeps the policy safe for embedded products with restricted capabilities.

## Data flow

Typical host integration:

```ts
const run = await runRetroEvaluation(...)
const previous = await loadRetroRun(previousRunId)
const comparison = previous ? compareRetroRuns(previous, run) : undefined
const action = decideRetroAction({ run, previousRun: previous, comparison, policy })

await saveRetroRun(currentRunId, run)
await hostRuntime.execute(action)
```

The SDK decides what should happen next. The host application decides how to execute it.

## Error handling

The policy layer should not throw for normal decision states.

- Missing previous run: use current run only.
- Missing comparison: produce a baseline-oriented action when useful.
- Empty findings: stop.
- Restricted allowed actions: return the safest allowed fallback.

Programmer errors, such as malformed objects that violate TypeScript contracts at runtime, do not need defensive compatibility shims in this slice.

## Testing strategy

Use TDD. Write failing tests before implementation.

Minimum behavior tests:

- no findings returns `stop`
- critical/high fix finding returns `attempt_fix`
- exhausted attempts returns `escalate`
- negative overall drift returns `attempt_fix`
- findings without previous comparison returns `retest`
- defer-only findings returns `defer`
- preserve-only findings returns `stop`
- disallowed preferred action falls back safely

Verification:

- focused retro tests
- existing OpenAI provider tests
- package build

## Implementation slice

Implement only the deterministic control-plane policy core:

- create `src/retro/policy.ts`
- export policy function and types through `src/retro/index.ts`
- re-export through `src/index.ts`
- add TDD coverage in `tests/retro-run.test.ts`
- update README API table and machine-consumable usage example

Execution adapters and autonomous repair loops remain future work.
