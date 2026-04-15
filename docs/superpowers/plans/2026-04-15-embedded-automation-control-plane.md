# Implementation Plan: Embedded Automation Control Plane

Date: 2026-04-15
Spec: `docs/superpowers/specs/2026-04-15-embedded-automation-control-plane-design.md`
Status: ready for implementation

## Scope check

This plan covers one subsystem only: the deterministic control-plane policy core for the retro/eval SDK. It does not include execution adapters, repair loops, CLI integration, or report generation.

## File structure

### Files to create

- `src/retro/policy.ts`
  - Implements the pure decision engine.
  - Defines policy input/output types that are specific to decision-making.
  - Contains the deterministic rule ordering and safe-action fallback logic.

### Files to modify

- `src/retro/types.ts`
  - Add exported control-plane types that should be part of the public retro SDK contract.
  - Keep shared/public type definitions here when they are reused across modules.

- `src/retro/index.ts`
  - Export `decideRetroAction()` and the new control-plane types.

- `src/index.ts`
  - Re-export the control-plane API from the top-level package surface.

- `tests/retro-run.test.ts`
  - Add TDD coverage for all first-slice policy behaviors.
  - Keep tests colocated with the existing retro core tests for now.

- `README.md`
  - Update the retro/eval section with a machine-consumable control-plane example.
  - Add API table entries for the new policy function and related types where appropriate.

## Implementation tasks

### Task 1: Add failing tests for the stop path

- [ ] **Step 1: Append a failing test for the no-findings case in `tests/retro-run.test.ts`**

Add a test named:

```ts
test('decideRetroAction returns stop when there are no findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [async () => ({ findings: [] })],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'stop')
})
```

- [ ] **Step 2: Run the single test to verify it fails**

Run:

```bash
cd "/Users/lu/openagent/open-agent-sdk-typescript" && npx tsx --test tests/retro-run.test.ts
```

Expected: FAIL because `decideRetroAction` does not exist yet.

### Task 2: Add the minimum public types for the policy API

- [ ] **Step 3: Extend `src/retro/types.ts` with control-plane types**

Add these exported types after `RetroRunResult`:

```ts
export type RetroActionKind =
  | 'attempt_fix'
  | 'retest'
  | 'retry_with_more_context'
  | 'escalate'
  | 'defer'
  | 'stop'

export interface RetroPolicy {
  maxAttempts?: number
  minimumOverallScore?: number
  escalateSeverity?: RetroSeverity
  allowedActions?: RetroActionKind[]
}

export interface RetroPolicyInput {
  run: RetroRunResult
  previousRun?: RetroRunResult
  comparison?: RetroRunComparison
  attemptCount?: number
  policy?: RetroPolicy
}

export interface RetroActionPlan {
  kind: RetroActionKind
  reason: string
  priority: number
  findingIds: string[]
  constraints: Record<string, unknown>
}
```

Also add the missing forward type reference needed by `RetroPolicyInput`:

```ts
export interface RetroRunComparison {
  summary: {
    previousRunAt: string
    currentRunAt: string
  }
  scoreDeltas: Record<RetroDimension | 'overall', {
    previous: number
    current: number
    delta: number
  }>
  newFindings: RetroNormalizedFinding[]
  resolvedFindings: RetroNormalizedFinding[]
}
```

Then update `src/retro/compare.ts` later so its interfaces match or reuse these exports cleanly.

- [ ] **Step 4: Create `src/retro/policy.ts` with the smallest implementation that satisfies the stop-path test**

Start with:

```ts
import type { RetroActionPlan, RetroPolicyInput } from './types.js'

export function decideRetroAction(input: RetroPolicyInput): RetroActionPlan {
  if (input.run.findings.length === 0) {
    return {
      kind: 'stop',
      reason: 'No findings recorded.',
      priority: 0,
      findingIds: [],
      constraints: {},
    }
  }

  return {
    kind: 'retest',
    reason: 'Baseline comparison not available.',
    priority: 2,
    findingIds: input.run.findings.map((finding) => finding.id),
    constraints: {},
  }
}
```

- [ ] **Step 5: Export the new API from `src/retro/index.ts`**

Add:

```ts
export { decideRetroAction } from './policy.js'
```

and include the new types in the exported type block:

```ts
RetroActionKind,
RetroActionPlan,
RetroPolicy,
RetroPolicyInput,
```

- [ ] **Step 6: Re-export the new API from `src/index.ts`**

Add `decideRetroAction` to the retro export block and add the four new types to the type export block.

- [ ] **Step 7: Run the retro test file to verify the first new test passes**

Run:

```bash
cd "/Users/lu/openagent/open-agent-sdk-typescript" && npx tsx --test tests/retro-run.test.ts
```

Expected: PASS for the stop-path test.

### Task 3: Add failing tests for the remaining rule set

- [ ] **Step 8: Append a failing test for severe fix findings**

Add:

```ts
test('decideRetroAction returns attempt_fix for high severity fix findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'reliability',
            title: 'Retry gap',
            rationale: 'Transient failures need stronger recovery.',
            severity: 'high',
            confidence: 'high',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'attempt_fix')
  assert.equal(action.findingIds.length, 1)
})
```

- [ ] **Step 9: Append a failing test for exhausted attempts**

Add:

```ts
test('decideRetroAction returns escalate when retry budget is exhausted', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'compatibility',
            title: 'Gateway mismatch',
            rationale: 'Provider contract is still broken.',
            severity: 'critical',
            confidence: 'high',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    attemptCount: 3,
    policy: { maxAttempts: 3 },
  })

  assert.equal(action.kind, 'escalate')
})
```

- [ ] **Step 10: Append a failing test for worsening drift**

Add:

```ts
test('decideRetroAction returns attempt_fix when overall score regresses', async () => {
  const { compareRetroRuns, decideRetroAction } = await import('../src/index.ts')

  const previous = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [async () => ({ findings: [] })],
    runAt: '2026-04-14T00:00:00.000Z',
  })

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'stability',
            title: 'Boot race',
            rationale: 'Startup ordering is unstable.',
            severity: 'medium',
            confidence: 'high',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const comparison = compareRetroRuns(previous, run)
  const action = decideRetroAction({ run, previousRun: previous, comparison })

  assert.equal(action.kind, 'attempt_fix')
})
```

- [ ] **Step 11: Append a failing test for no comparison with findings**

Add:

```ts
test('decideRetroAction returns retest when findings exist without comparison context', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'stability',
            title: 'Flaky boot path',
            rationale: 'Cold-start behavior is inconsistent.',
            severity: 'medium',
            confidence: 'high',
            disposition: 'investigate',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'retest')
})
```

- [ ] **Step 12: Append a failing test for defer-only findings**

Add:

```ts
test('decideRetroAction returns defer for defer-only findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'interaction_logic',
            title: 'Nice-to-have polish',
            rationale: 'This can wait.',
            severity: 'low',
            confidence: 'medium',
            disposition: 'defer',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'defer')
})
```

- [ ] **Step 13: Append a failing test for preserve-only findings**

Add:

```ts
test('decideRetroAction returns stop for preserve-only findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'interaction_logic',
            title: 'Strong onboarding',
            rationale: 'This should be preserved.',
            severity: 'low',
            confidence: 'medium',
            disposition: 'preserve',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'stop')
})
```

- [ ] **Step 14: Append a failing test for disallowed actions**

Add:

```ts
test('decideRetroAction falls back to a safe allowed action', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'reliability',
            title: 'Retry gap',
            rationale: 'Transient failures need stronger recovery.',
            severity: 'high',
            confidence: 'high',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    policy: { allowedActions: ['defer', 'stop'] },
  })

  assert.equal(action.kind, 'defer')
})
```

- [ ] **Step 15: Run the retro test file and confirm the new tests fail for the expected reasons**

Run:

```bash
cd "/Users/lu/openagent/open-agent-sdk-typescript" && npx tsx --test tests/retro-run.test.ts
```

Expected: FAIL on new assertions because the policy implementation is still minimal.

### Task 4: Implement the full deterministic rule ordering

- [ ] **Step 16: Refine `src/retro/policy.ts` to classify findings and apply rules in order**

Implement small helpers inside `src/retro/policy.ts`:

```ts
function actionableFindings(input: RetroPolicyInput) { ... }
function severeFixFindings(input: RetroPolicyInput) { ... }
function allFindingsAreDisposition(run, disposition) { ... }
function allowedOrFallback(preferred, allowedActions) { ... }
```

Required behavior:

- `stop` when `run.findings.length === 0`
- `escalate` when `attemptCount >= (policy.maxAttempts ?? 3)` and at least one finding is severity `high` or `critical` and disposition is not `preserve`
- `attempt_fix` when any finding is severity `high` or `critical` and disposition is `fix`
- `attempt_fix` when `comparison?.scoreDeltas.overall.delta < 0` and there is at least one non-preserve/non-defer finding
- `defer` when every finding has disposition `defer`
- `stop` when every finding has disposition `preserve`
- `retest` for the remaining findings-present case

Return these concrete priorities:

- `attempt_fix`: `1`
- `retest`: `2`
- `retry_with_more_context`: `3`
- `escalate`: `4`
- `defer`: `5`
- `stop`: `6`

Return `findingIds` from the findings that triggered the chosen action.

Return `constraints` with at least:

```ts
{
  attemptCount: input.attemptCount ?? 0,
  maxAttempts: input.policy?.maxAttempts ?? 3,
}
```

- [ ] **Step 17: If needed, unify comparison typing between `src/retro/types.ts` and `src/retro/compare.ts`**

If `RetroRunComparison` is now defined in `types.ts`, remove duplicate interface definitions from `compare.ts` and import the shared type from `./types.js` instead.

- [ ] **Step 18: Run the retro test file to verify all policy tests pass**

Run:

```bash
cd "/Users/lu/openagent/open-agent-sdk-typescript" && npx tsx --test tests/retro-run.test.ts
```

Expected: PASS.

### Task 5: Document and verify the public API

- [ ] **Step 19: Update `README.md` with a machine-consumable control-plane example**

Add an example near the retro section using:

```ts
import {
  compareRetroRuns,
  decideRetroAction,
  loadRetroRun,
  runRetroEvaluation,
  saveRetroRun,
} from "@codeany/open-agent-sdk";

const current = await runRetroEvaluation({
  target: { name: "my-project", cwd: process.cwd() },
  evaluators,
});

const previous = await loadRetroRun("run-previous");
const comparison = previous ? compareRetroRuns(previous, current) : undefined;
const action = decideRetroAction({
  run: current,
  previousRun: previous ?? undefined,
  comparison,
  attemptCount: 0,
  policy: { maxAttempts: 3 },
});

await saveRetroRun("run-current", current);
console.log(action.kind);
```

- [ ] **Step 20: Add API table entries in `README.md`**

Add:

- `decideRetroAction(input)` — Decide the next machine action from current retro state
- `compareRetroRuns(previous, current)` — Compare two retro runs for score deltas and finding drift
- `saveRetroRun(runId, result, opts)` — Persist a retro run result to the run ledger
- `loadRetroRun(runId, opts)` — Load a persisted retro run result from the run ledger

- [ ] **Step 21: Run focused regression tests plus build**

Run:

```bash
cd "/Users/lu/openagent/open-agent-sdk-typescript" && npx tsx --test tests/retro-run.test.ts tests/openai-provider.test.ts
```

Expected: PASS.

Then run:

```bash
cd "/Users/lu/openagent/open-agent-sdk-typescript" && npm run build
```

Expected: PASS.

### Task 6: Final review

- [ ] **Step 22: Inspect the final diff**

Run:

```bash
git -C "/Users/lu/openagent/open-agent-sdk-typescript" status --short && printf '\n---\n' && git -C "/Users/lu/openagent/open-agent-sdk-typescript" diff --stat
```

Confirm the changed files are limited to:

- `src/retro/policy.ts`
- `src/retro/types.ts`
- `src/retro/compare.ts` (only if comparison types were unified)
- `src/retro/index.ts`
- `src/index.ts`
- `tests/retro-run.test.ts`
- `README.md`
- `docs/superpowers/specs/2026-04-15-embedded-automation-control-plane-design.md`
- `docs/superpowers/plans/2026-04-15-embedded-automation-control-plane.md`

Do not delete `.tmp-retro-ledger/` unless explicitly asked.
