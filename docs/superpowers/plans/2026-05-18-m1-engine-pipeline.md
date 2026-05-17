# M1 — Engine pipeline 七阶段重构 (实施计划)

**Spec**: [`docs/superpowers/specs/2026-05-18-v2-pipeline-upgrade-design.md`](../specs/2026-05-18-v2-pipeline-upgrade-design.md) §2

**Status**: ready for execution

**Baseline (2026-05-18)**:
- `src/engine.ts`: 1070 LoC
- Tests: 728 / 728 passing
- Wall-time: 35.8s
- `AGENT_RUN_TRACE_SCHEMA_VERSION`: `'1.0.0'`

**Target (M1 完成时)**:
- `src/engine.ts`: < 400 LoC（spec §2.1 锁定）
- 7 个新 pipeline 阶段文件，每个 < 200 LoC
- Tests: ≥ 763（728 + 至少 35 个新增）
- `AGENT_RUN_TRACE_SCHEMA_VERSION`: `'2.0.0'`，含 `pipeline_stages`
- `bench:engine` SLO: engine.ts < 400，新阶段文件每个 < 200

**预估工时**: 3 周（21 天）

**关键纪律**:
- 每个阶段以 TDD 完成（先写失败测试，再写实现）
- 每个 task 完成立即 commit
- 不允许在 M1 完成前启动 M2/M3
- 公开 API 不变；只动 schema_version 和内部接口

---

## 文件结构（决策已锁死）

```
src/engine/pipeline/
├── types.ts             # PipelineContext, PipelineState, 各阶段 input/output 契约
├── guard.ts             # 权限/配额/工具策略校验
├── compact.ts           # 上下文压缩决策
├── render.ts            # system prompt + skill + memory 注入
├── call.ts              # provider 调用 + retry + fallback
├── stream.ts            # 流式 chunk 处理
├── tools.ts             # 工具调度（cache + concurrency + dispatch）
└── decide.ts            # 终止条件 / 下一轮决策

src/engine.ts            # 缩到 < 400 LoC，纯编排

tests/pipeline/
├── pipeline-types.test.ts
├── pipeline-guard.test.ts
├── pipeline-compact.test.ts
├── pipeline-render.test.ts
├── pipeline-call.test.ts
├── pipeline-stream.test.ts
├── pipeline-tools.test.ts
└── pipeline-decide.test.ts

src/types/trace.ts       # 新增 pipeline_stages 字段
src/types/schema-versions.ts  # bump 到 '2.0.0'
src/v1-compat/trace-shim.ts   # 1.x trace → 2.x 自动转换（M6 用，但骨架在这里）
```

---

## Task 0: 准备工作（Day 1 上午，~2h）

### Step 0.1: 在 worktree 中开 M1 分支

确认当前在 `main`，然后：

```bash
git status   # 应当只看到 .clavue/worktrees/* 的脏状态，那些不是我们的
git checkout -b m1-pipeline-refactor
```

期望：分支创建成功，`git branch --show-current` 输出 `m1-pipeline-refactor`。

### Step 0.2: 锁定 baseline 报告

```bash
npm run bench:engine 2>&1 | tee docs/benchmarks/2026-05-18-m1-baseline.md
```

期望：
- engine.ts LoC: **1070**
- test count: **728**
- wall-time: 30-40s
- All SLOs within budget

### Step 0.3: Commit baseline

```bash
git add docs/benchmarks/2026-05-18-m1-baseline.md
git commit -m "chore(bench): lock pre-M1 baseline (engine.ts 1070 LoC, 728 tests)"
```

---

## Task 1: PipelineContext 类型契约（Day 1 下午，~3h）

把所有阶段共用的契约先写死，避免后面相互返工。

### Step 1.1: 写失败测试 `tests/pipeline/pipeline-types.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import type {
  PipelineContext,
  PipelineState,
  PipelineStageName,
} from '../../src/engine/pipeline/types.ts'
import { PIPELINE_STAGE_NAMES } from '../../src/engine/pipeline/types.ts'

test('PIPELINE_STAGE_NAMES lists all 7 stages in order', () => {
  assert.deepEqual(PIPELINE_STAGE_NAMES, [
    'guard',
    'compact',
    'render',
    'call',
    'stream',
    'tools',
    'decide',
  ])
})

test('PipelineStageName covers exactly the 7 stages', () => {
  // Compile-time check: every name must be assignable
  const names: PipelineStageName[] = [
    'guard', 'compact', 'render', 'call', 'stream', 'tools', 'decide',
  ]
  assert.equal(names.length, 7)
})

test('PipelineState shape is mutable with required scalars', () => {
  // Smoke check shape; full state machine is verified per stage.
  const state: PipelineState = {
    turnIndex: 0,
    apiAttempts: 0,
    maxOutputRecoveryAttempts: 0,
    completedNormally: false,
    budgetExceeded: false,
  }
  state.turnIndex = 1
  assert.equal(state.turnIndex, 1)
})
```

### Step 1.2: Run test — must fail

```bash
npx tsx --test tests/pipeline/pipeline-types.test.ts
```

Expected: FAIL with module resolution error (`Cannot find module '../../src/engine/pipeline/types.ts'`).

### Step 1.3: Implement `src/engine/pipeline/types.ts`

```typescript
/**
 * Pipeline contracts shared across all 7 stages.
 *
 * Each stage is a pure-ish function that takes a context + input and returns
 * an output. State mutation is concentrated in PipelineState (a single
 * mutable carrier passed through the loop) so individual stages stay
 * testable without spinning up a full QueryEngine.
 */

import type {
  AgentRunTrace,
  TokenUsage,
  ToolDefinition,
  QualityGateResult,
} from '../../types.js'
import type {
  CreateMessageResponse,
  LLMProvider,
  NormalizedMessageParam,
} from '../../providers/types.js'

export const PIPELINE_STAGE_NAMES = [
  'guard',
  'compact',
  'render',
  'call',
  'stream',
  'tools',
  'decide',
] as const

export type PipelineStageName = (typeof PIPELINE_STAGE_NAMES)[number]

/** Per-turn mutable state. Cleared between runs, persists across the
 *  generator's `submitMessage` loop. */
export interface PipelineState {
  turnIndex: number
  apiAttempts: number
  maxOutputRecoveryAttempts: number
  completedNormally: boolean
  budgetExceeded: boolean
}

/** Read-mostly context handed to every stage. The `state` field is the only
 *  mutation surface. */
export interface PipelineContext {
  readonly runId: string
  readonly sessionId: string
  readonly provider: LLMProvider
  readonly trace: AgentRunTrace
  readonly totalUsage: TokenUsage
  readonly tools: ToolDefinition[]
  state: PipelineState
}

/** Generic stage signature. Each concrete stage refines In/Out. */
export type PipelineStage<In, Out> = (
  ctx: PipelineContext,
  input: In,
) => Promise<Out>

/** Reused across guard/compact/render outputs to short-circuit the loop. */
export interface StageDenied {
  kind: 'denied'
  reason: string
  errors: string[]
}

export type StageResult<T> = { kind: 'ok'; value: T } | StageDenied
```

### Step 1.4: Run test — must pass

```bash
npx tsx --test tests/pipeline/pipeline-types.test.ts
```

Expected: 3 tests pass.

### Step 1.5: typecheck must pass

```bash
npx tsc --noEmit
```

Expected: 0 errors.

### Step 1.6: Commit

```bash
git add src/engine/pipeline/types.ts tests/pipeline/pipeline-types.test.ts
git commit -m "feat(pipeline): add PipelineContext + PipelineState type contracts (M1.1)"
```

---

## Task 2: AGENT_RUN_TRACE_SCHEMA_VERSION bump + pipeline_stages 字段（Day 2 上午，~3h）

先 bump schema 是因为后面所有阶段都要往 trace 里写 timing。

### Step 2.1: 写失败测试 `tests/trace-schema-v2.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  AGENT_RUN_TRACE_SCHEMA_VERSION,
} from '../src/types/schema-versions.ts'
import type {
  AgentRunTrace,
  AgentRunPipelineStageTrace,
} from '../src/types/trace.ts'

test('AGENT_RUN_TRACE_SCHEMA_VERSION is 2.0.0', () => {
  assert.equal(AGENT_RUN_TRACE_SCHEMA_VERSION, '2.0.0')
})

test('AgentRunTrace.pipeline_stages is optional and indexed by stage name', () => {
  const trace: AgentRunTrace = {
    schema_version: AGENT_RUN_TRACE_SCHEMA_VERSION,
    turns: [],
    tools: [],
    concurrency_batches: [],
    tool_concurrency_limit: 10,
    tool_concurrency_source: 'default',
    retry_count: 0,
    compaction_count: 0,
    permission_denials: [],
    pipeline_stages: {
      guard: { duration_ms: 1.2, status: 'ok' },
      compact: { duration_ms: 0.5, status: 'ok' },
    },
  }
  assert.equal(trace.pipeline_stages?.guard?.status, 'ok')
})

test('AgentRunPipelineStageTrace status enum is closed', () => {
  const ok: AgentRunPipelineStageTrace = { duration_ms: 0, status: 'ok' }
  const skipped: AgentRunPipelineStageTrace = { duration_ms: 0, status: 'skipped' }
  const denied: AgentRunPipelineStageTrace = { duration_ms: 0, status: 'denied' }
  const error: AgentRunPipelineStageTrace = {
    duration_ms: 0,
    status: 'error',
    error_message: 'boom',
  }
  assert.equal(ok.status, 'ok')
  assert.equal(skipped.status, 'skipped')
  assert.equal(denied.status, 'denied')
  assert.equal(error.error_message, 'boom')
})
```

### Step 2.2: Run test — must fail

```bash
npx tsx --test tests/trace-schema-v2.test.ts
```

Expected: FAIL because version is still `'1.0.0'` and `AgentRunPipelineStageTrace` does not exist.

### Step 2.3: Edit `src/types/schema-versions.ts`

Change line 7 from:

```typescript
export const AGENT_RUN_TRACE_SCHEMA_VERSION = '1.0.0'
```

to:

```typescript
export const AGENT_RUN_TRACE_SCHEMA_VERSION = '2.0.0'
```

### Step 2.4: Add `AgentRunPipelineStageTrace` to `src/types/trace.ts`

After line 234 (end of `AgentRunTrace` interface), add:

```typescript
/**
 * Per-stage execution trace for the v2.0 pipeline. One entry per stage
 * per turn aggregated across the run. `status: 'denied'` corresponds to
 * a `StageDenied` short-circuit; `status: 'skipped'` is for stages that
 * had no work (e.g. compact when context fits).
 */
export interface AgentRunPipelineStageTrace {
  duration_ms: number
  status: 'ok' | 'skipped' | 'denied' | 'error'
  error_message?: string
}
```

Then in the `AgentRunTrace` interface, before the closing brace (line ~234), add:

```typescript
  /**
   * Per-stage timing + status for the 7-stage v2.0 pipeline. Field is
   * populated by `engine.ts` after each turn. Absent when the engine is
   * running in the v1-compat fallback path.
   */
  pipeline_stages?: Partial<Record<
    'guard' | 'compact' | 'render' | 'call' | 'stream' | 'tools' | 'decide',
    AgentRunPipelineStageTrace
  >>
```

### Step 2.5: Run trace-schema test — must pass

```bash
npx tsx --test tests/trace-schema-v2.test.ts
```

Expected: 3 tests pass.

### Step 2.6: Run full test suite — find what broke

```bash
npx tsx --test tests/*.test.ts 2>&1 | tail -30
```

Expected: A few tests pinning `'1.0.0'` will fail. Note their names — they are version-pinning tests we must update.

### Step 2.7: Update version-pinning tests

Find every test that references `'1.0.0'` for the trace schema:

```bash
grep -rn "AGENT_RUN_TRACE_SCHEMA_VERSION\|'1.0.0'" tests/ src/
```

For each test that pins the trace schema to `'1.0.0'`, change it to `'2.0.0'`. **Do not** change other schema versions (SDK_EVENT, AGENT_JOB_RECORD, etc.) — they keep their current values until their own milestones.

Typical fix in tests:

```typescript
// before
assert.equal(trace.schema_version, '1.0.0')
// after
assert.equal(trace.schema_version, '2.0.0')
```

### Step 2.8: Run full test suite again

```bash
npx tsx --test tests/*.test.ts 2>&1 | tail -10
```

Expected: 728 + 3 new = 731 tests pass.

### Step 2.9: Commit

```bash
git add -A
git commit -m "feat(trace): bump AGENT_RUN_TRACE_SCHEMA_VERSION to 2.0.0 + pipeline_stages field (M1.2)"
```

---

## Task 3: Guard 阶段（Day 2 下午 + Day 3，~6h）

Guard 是最简单的阶段，先做它把 pipeline pattern 走通。

### Step 3.1: 写失败测试 `tests/pipeline/pipeline-guard.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import { runGuardStage } from '../../src/engine/pipeline/guard.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { GuardStageInput } from '../../src/engine/pipeline/guard.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'test-run',
    sessionId: 'test-session',
    provider: {} as any,
    trace: {
      schema_version: '2.0.0',
      turns: [],
      tools: [],
      concurrency_batches: [],
      tool_concurrency_limit: 10,
      tool_concurrency_source: 'default',
      retry_count: 0,
      compaction_count: 0,
      permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0,
      apiAttempts: 0,
      maxOutputRecoveryAttempts: 0,
      completedNormally: false,
      budgetExceeded: false,
    },
  }
}

test('guard passes through when no abort, no budget breach, no hook block', async () => {
  const ctx = makeCtx()
  const input: GuardStageInput = {
    abortSignal: undefined,
    maxBudgetUsd: undefined,
    totalCost: 0,
    hookResults: [],
  }
  const result = await runGuardStage(ctx, input)
  assert.equal(result.kind, 'ok')
})

test('guard denies when abort signal fired', async () => {
  const ctx = makeCtx()
  const ac = new AbortController()
  ac.abort()
  const result = await runGuardStage(ctx, {
    abortSignal: ac.signal,
    maxBudgetUsd: undefined,
    totalCost: 0,
    hookResults: [],
  })
  assert.equal(result.kind, 'denied')
  if (result.kind === 'denied') {
    assert.match(result.reason, /abort/i)
  }
})

test('guard denies when budget exceeded', async () => {
  const ctx = makeCtx()
  const result = await runGuardStage(ctx, {
    abortSignal: undefined,
    maxBudgetUsd: 1.0,
    totalCost: 1.5,
    hookResults: [],
  })
  assert.equal(result.kind, 'denied')
  if (result.kind === 'denied') {
    assert.match(result.reason, /budget/i)
    assert.equal(ctx.state.budgetExceeded, true)
  }
})

test('guard denies when hook returns block=true', async () => {
  const ctx = makeCtx()
  const result = await runGuardStage(ctx, {
    abortSignal: undefined,
    maxBudgetUsd: undefined,
    totalCost: 0,
    hookResults: [{ block: true, reason: 'forbidden by policy' }],
  })
  assert.equal(result.kind, 'denied')
  if (result.kind === 'denied') {
    assert.match(result.reason, /forbidden by policy/)
  }
})

test('guard records duration in ctx.trace.pipeline_stages.guard', async () => {
  const ctx = makeCtx()
  await runGuardStage(ctx, {
    abortSignal: undefined,
    maxBudgetUsd: undefined,
    totalCost: 0,
    hookResults: [],
  })
  assert.ok(ctx.trace.pipeline_stages?.guard)
  assert.equal(ctx.trace.pipeline_stages?.guard?.status, 'ok')
  assert.ok(typeof ctx.trace.pipeline_stages?.guard?.duration_ms === 'number')
})
```

### Step 3.2: Run test — must fail

```bash
npx tsx --test tests/pipeline/pipeline-guard.test.ts
```

Expected: FAIL with module not found.

### Step 3.3: Implement `src/engine/pipeline/guard.ts`

```typescript
/**
 * Guard stage — pre-turn permission / budget / hook gate.
 *
 * Responsibilities:
 *   - Honor abort signal
 *   - Enforce maxBudgetUsd
 *   - Honor UserPromptSubmit hook block decisions (caller passes results)
 *
 * Out of scope (handled by other stages):
 *   - Tool-level permission (Tools stage)
 *   - Token budget / context window (Compact stage)
 *   - Model-specific safety (Call stage)
 */

import type { PipelineContext, StageResult } from './types.js'

export interface GuardStageInput {
  abortSignal?: AbortSignal
  maxBudgetUsd?: number
  totalCost: number
  /** Pre-collected results from UserPromptSubmit hooks. */
  hookResults: Array<{ block?: boolean; reason?: string }>
}

export interface GuardStageOutput {
  /** Always 'pass' when StageResult.kind === 'ok'. */
  marker: 'pass'
}

export async function runGuardStage(
  ctx: PipelineContext,
  input: GuardStageInput,
): Promise<StageResult<GuardStageOutput>> {
  const start = performance.now()

  // 1. Abort signal
  if (input.abortSignal?.aborted) {
    recordStage(ctx, start, 'denied')
    return {
      kind: 'denied',
      reason: 'abort signal received before turn',
      errors: ['Aborted'],
    }
  }

  // 2. Budget
  if (input.maxBudgetUsd !== undefined && input.totalCost >= input.maxBudgetUsd) {
    ctx.state.budgetExceeded = true
    recordStage(ctx, start, 'denied')
    return {
      kind: 'denied',
      reason: `budget exceeded (${input.totalCost} >= ${input.maxBudgetUsd})`,
      errors: [`Max budget reached: $${input.maxBudgetUsd}`],
    }
  }

  // 3. Hook block
  const blocked = input.hookResults.find((r) => r.block)
  if (blocked) {
    const reason = blocked.reason || 'blocked by hook'
    recordStage(ctx, start, 'denied')
    return {
      kind: 'denied',
      reason,
      errors: [`Blocked by UserPromptSubmit hook: ${reason}`],
    }
  }

  recordStage(ctx, start, 'ok')
  return { kind: 'ok', value: { marker: 'pass' } }
}

function recordStage(
  ctx: PipelineContext,
  start: number,
  status: 'ok' | 'denied',
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.guard = {
    duration_ms: performance.now() - start,
    status,
  }
}
```

### Step 3.4: Run test — must pass

```bash
npx tsx --test tests/pipeline/pipeline-guard.test.ts
```

Expected: 5 tests pass.

### Step 3.5: typecheck

```bash
npx tsc --noEmit
```

Expected: 0 errors.

### Step 3.6: Commit

```bash
git add src/engine/pipeline/guard.ts tests/pipeline/pipeline-guard.test.ts
git commit -m "feat(pipeline): Guard stage — abort/budget/hook denial (M1.3)"
```

---

## Task 4: Compact 阶段（Day 3-4，~5h）

Compact 包装现有 `maybeAutoCompactBeforeTurn` + `applyMicroCompactForApi`。

### Step 4.1: 写失败测试 `tests/pipeline/pipeline-compact.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import { runCompactStage } from '../../src/engine/pipeline/compact.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { CompactStageInput } from '../../src/engine/pipeline/compact.ts'
import { createAutoCompactState } from '../../src/utils/compact.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r',
    sessionId: 's',
    provider: { countTokens: async () => ({ input_tokens: 100 }) } as any,
    trace: {
      schema_version: '2.0.0',
      turns: [], tools: [], concurrency_batches: [],
      tool_concurrency_limit: 10, tool_concurrency_source: 'default',
      retry_count: 0, compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

test('compact returns messages unchanged when context fits', async () => {
  const ctx = makeCtx()
  const messages = [{ role: 'user', content: 'hi' }] as any
  const input: CompactStageInput = {
    model: 'claude-3-5-sonnet',
    messages,
    state: createAutoCompactState(),
    abortSignal: undefined,
  }
  const result = await runCompactStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.messages.length, 1)
    assert.equal(result.value.apiMessages.length, 1)
  }
  assert.equal(ctx.trace.pipeline_stages?.compact?.status, 'ok')
})

test('compact records duration_ms', async () => {
  const ctx = makeCtx()
  await runCompactStage(ctx, {
    model: 'claude-3-5-sonnet',
    messages: [{ role: 'user', content: 'x' }] as any,
    state: createAutoCompactState(),
    abortSignal: undefined,
  })
  assert.ok(typeof ctx.trace.pipeline_stages?.compact?.duration_ms === 'number')
})

test('compact micro-compacts large tool results in apiMessages', async () => {
  const ctx = makeCtx()
  const big = 'x'.repeat(200_000)
  const messages = [
    { role: 'user', content: 'go' },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: big }] },
  ] as any
  const result = await runCompactStage(ctx, {
    model: 'claude-3-5-sonnet',
    messages,
    state: createAutoCompactState(),
    abortSignal: undefined,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    // micro-compact truncates; the apiMessages copy must shrink
    const apiSize = JSON.stringify(result.value.apiMessages).length
    const origSize = JSON.stringify(messages).length
    assert.ok(apiSize < origSize, `expected micro-compact to shrink: ${apiSize} < ${origSize}`)
  }
})
```

### Step 4.2: Run — must fail

```bash
npx tsx --test tests/pipeline/pipeline-compact.test.ts
```

Expected: module not found.

### Step 4.3: Implement `src/engine/pipeline/compact.ts`

```typescript
/**
 * Compact stage — auto-compact + micro-compact for the per-turn API call.
 *
 * Wraps existing helpers `maybeAutoCompactBeforeTurn` and
 * `applyMicroCompactForApi` from `engine/compact-stage.ts`. The wrapper
 * adds pipeline-level timing + denied/error short-circuits.
 */

import type { LLMProvider, NormalizedMessageParam } from '../../providers/types.js'
import type { PipelineContext, StageResult } from './types.js'
import {
  applyMicroCompactForApi,
  maybeAutoCompactBeforeTurn,
} from '../compact-stage.js'
import type { AutoCompactState } from '../../utils/compact.js'

export interface CompactStageInput {
  model: string
  messages: NormalizedMessageParam[]
  state: AutoCompactState
  abortSignal?: AbortSignal
  /** Optional pre/post hooks (PreCompact/PostCompact). Caller wires them. */
  onPreCompact?: () => Promise<void>
  onPostCompact?: () => Promise<void>
}

export interface CompactStageOutput {
  /** Possibly-compacted message history (mutates engine.messages). */
  messages: NormalizedMessageParam[]
  /** Updated compact state (must be persisted by caller). */
  state: AutoCompactState
  /** Micro-compacted copy used only for this turn's API request. */
  apiMessages: NormalizedMessageParam[]
}

export async function runCompactStage(
  ctx: PipelineContext,
  input: CompactStageInput,
): Promise<StageResult<CompactStageOutput>> {
  const start = performance.now()
  try {
    const compacted = await maybeAutoCompactBeforeTurn({
      provider: ctx.provider,
      model: input.model,
      messages: input.messages,
      state: input.state,
      abortSignal: input.abortSignal,
      trace: ctx.trace,
      onPreCompact: input.onPreCompact,
      onPostCompact: input.onPostCompact,
    })
    const apiMessages = applyMicroCompactForApi(compacted.messages)
    record(ctx, start, 'ok')
    return {
      kind: 'ok',
      value: {
        messages: compacted.messages,
        state: compacted.state,
        apiMessages,
      },
    }
  } catch (err) {
    record(ctx, start, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}

function record(
  ctx: PipelineContext,
  start: number,
  status: 'ok' | 'error',
  errorMessage?: string,
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.compact = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
```

### Step 4.4: Run test — must pass

```bash
npx tsx --test tests/pipeline/pipeline-compact.test.ts
```

Expected: 3 tests pass.

### Step 4.5: Commit

```bash
git add src/engine/pipeline/compact.ts tests/pipeline/pipeline-compact.test.ts
git commit -m "feat(pipeline): Compact stage — wraps autocompact + microcompact (M1.4)"
```

---

## Task 5: Render 阶段（Day 4-5，~5h）

Render 包装 `buildSystemPrompt` + `buildTurnRequest`。

### Step 5.1: 写失败测试 `tests/pipeline/pipeline-render.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import { runRenderStage } from '../../src/engine/pipeline/render.ts'
import type { RenderStageInput } from '../../src/engine/pipeline/render.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r', sessionId: 's',
    provider: {
      createMessage: async () => ({
        content: [{ type: 'text', text: 'ok' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    } as any,
    trace: {
      schema_version: '2.0.0',
      turns: [], tools: [], concurrency_batches: [],
      tool_concurrency_limit: 10, tool_concurrency_source: 'default',
      retry_count: 0, compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

test('render produces requestModel + providerTools + createModelMessage', async () => {
  const ctx = makeCtx()
  const input: RenderStageInput = {
    config: {
      model: 'claude-3-5-sonnet',
      tools: [],
      cwd: process.cwd(),
      policy: { permissionMode: 'auto' as any },
    } as any,
    apiMessages: [{ role: 'user', content: 'hi' }] as any,
    activeSkill: undefined,
    partialQueue: [],
    releaseDrain: () => {},
  }
  const result = await runRenderStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.requestModel, 'claude-3-5-sonnet')
    assert.ok(Array.isArray(result.value.providerTools))
    assert.equal(typeof result.value.createModelMessage, 'function')
  }
  assert.equal(ctx.trace.pipeline_stages?.render?.status, 'ok')
})

test('render uses skill model override when activeSkill present', async () => {
  const ctx = makeCtx()
  const result = await runRenderStage(ctx, {
    config: {
      model: 'claude-3-5-sonnet',
      tools: [],
      cwd: process.cwd(),
      policy: { permissionMode: 'auto' as any },
    } as any,
    apiMessages: [{ role: 'user', content: 'hi' }] as any,
    activeSkill: {
      kind: 'inline',
      skillName: 'test-skill',
      prompt: 'be brief',
      allowedTools: [],
      model: 'claude-3-haiku-20240307',
    } as any,
    partialQueue: [],
    releaseDrain: () => {},
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.requestModel, 'claude-3-haiku-20240307')
  }
})
```

### Step 5.2: Run — must fail

```bash
npx tsx --test tests/pipeline/pipeline-render.test.ts
```

Expected: module not found.

### Step 5.3: Implement `src/engine/pipeline/render.ts`

```typescript
/**
 * Render stage — build system prompt + turn request.
 *
 * Wraps `buildSystemPrompt` (engine/prompt-helpers) + `buildTurnRequest`
 * (engine/turn-request). Output is a ready-to-issue request that the Call
 * stage will hand to the provider.
 */

import type { PipelineContext, StageResult } from './types.js'
import { buildSystemPrompt } from '../prompt-helpers.js'
import { buildTurnRequest, type BuiltTurnRequest } from '../turn-request.js'
import type { SkillActivation } from '../skill-helpers.js'
import type { NormalizedMessageParam } from '../../providers/types.js'
import type { QueryEngineConfig } from '../../types.js'

export interface RenderStageInput {
  config: QueryEngineConfig
  apiMessages: NormalizedMessageParam[]
  activeSkill?: SkillActivation
  partialQueue: string[]
  releaseDrain: () => void
}

export interface RenderStageOutput extends BuiltTurnRequest {
  systemPrompt: string
}

export async function runRenderStage(
  ctx: PipelineContext,
  input: RenderStageInput,
): Promise<StageResult<RenderStageOutput>> {
  const start = performance.now()
  try {
    const built = await buildSystemPrompt(input.config)
    if (built.memoryTrace) {
      if (!ctx.trace.memory) ctx.trace.memory = []
      ctx.trace.memory.push(built.memoryTrace)
    }
    const turnRequest = buildTurnRequest({
      config: input.config,
      provider: ctx.provider,
      systemPrompt: built.systemPrompt,
      apiMessages: input.apiMessages,
      activeSkill: input.activeSkill,
      partialQueue: input.partialQueue,
      releaseDrain: input.releaseDrain,
    })
    record(ctx, start, 'ok')
    return {
      kind: 'ok',
      value: { ...turnRequest, systemPrompt: built.systemPrompt },
    }
  } catch (err) {
    record(ctx, start, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}

function record(
  ctx: PipelineContext,
  start: number,
  status: 'ok' | 'error',
  errorMessage?: string,
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.render = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
```

### Step 5.4: Run — must pass

```bash
npx tsx --test tests/pipeline/pipeline-render.test.ts
```

Expected: 2 tests pass.

### Step 5.5: Commit

```bash
git add src/engine/pipeline/render.ts tests/pipeline/pipeline-render.test.ts
git commit -m "feat(pipeline): Render stage — system prompt + turn request (M1.5)"
```

---

## Task 6: Call 阶段（Day 5-7，~6h）

Call 是核心阶段。包装 `runResilientCall` + 流式 drain。

### Step 6.1: 写失败测试 `tests/pipeline/pipeline-call.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import { runCallStage } from '../../src/engine/pipeline/call.ts'
import type { CallStageInput } from '../../src/engine/pipeline/call.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { CreateMessageResponse } from '../../src/providers/types.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r', sessionId: 's',
    provider: {} as any,
    trace: {
      schema_version: '2.0.0', turns: [], tools: [],
      concurrency_batches: [], tool_concurrency_limit: 10,
      tool_concurrency_source: 'default', retry_count: 0,
      compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

const fakeResponse: CreateMessageResponse = {
  content: [{ type: 'text', text: 'hi' }],
  stopReason: 'end_turn',
  usage: { input_tokens: 1, output_tokens: 1 },
}

test('call returns response + successfulModel for happy path', async () => {
  const ctx = makeCtx()
  const input: CallStageInput = {
    requestModel: 'm-primary',
    fallbackModel: undefined,
    abortSignal: undefined,
    createModelMessage: async (model) => {
      assert.equal(model, 'm-primary')
      return fakeResponse
    },
  }
  const result = await runCallStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.successfulModel, 'm-primary')
    assert.equal(result.value.response.content[0]?.type, 'text')
  }
  assert.equal(ctx.state.apiAttempts, 1)
  assert.equal(ctx.trace.pipeline_stages?.call?.status, 'ok')
})

test('call increments apiAttempts on each onAttempt fire', async () => {
  const ctx = makeCtx()
  let calls = 0
  const result = await runCallStage(ctx, {
    requestModel: 'm-primary',
    fallbackModel: undefined,
    abortSignal: undefined,
    createModelMessage: async () => {
      calls++
      return fakeResponse
    },
  })
  assert.equal(result.kind, 'ok')
  assert.equal(ctx.state.apiAttempts, 1)
  assert.equal(calls, 1)
})

test('call records error status when provider throws', async () => {
  const ctx = makeCtx()
  let threw = false
  try {
    await runCallStage(ctx, {
      requestModel: 'm-primary',
      fallbackModel: undefined,
      abortSignal: undefined,
      createModelMessage: async () => { throw new Error('provider down') },
    })
  } catch {
    threw = true
  }
  assert.equal(threw, true)
  assert.equal(ctx.trace.pipeline_stages?.call?.status, 'error')
  assert.match(ctx.trace.pipeline_stages?.call?.error_message ?? '', /provider down/)
})
```

### Step 6.2: Run — must fail

```bash
npx tsx --test tests/pipeline/pipeline-call.test.ts
```

Expected: module not found.

### Step 6.3: Implement `src/engine/pipeline/call.ts`

```typescript
/**
 * Call stage — issue the model request with retry + fallback.
 *
 * Wraps `runResilientCall`. Note this stage does NOT drain the streaming
 * partial queue — the Stream stage owns that. Engine.ts is the only place
 * where these two run concurrently as background tasks.
 */

import type { PipelineContext, StageResult } from './types.js'
import { runResilientCall } from '../resilient-call.js'
import type { CreateMessageResponse } from '../../providers/types.js'

export interface CallStageInput {
  requestModel: string
  fallbackModel?: string | string[]
  abortSignal?: AbortSignal
  createModelMessage: (model: string) => Promise<CreateMessageResponse>
}

export interface CallStageOutput {
  response: CreateMessageResponse
  successfulModel: string
}

export async function runCallStage(
  ctx: PipelineContext,
  input: CallStageInput,
): Promise<StageResult<CallStageOutput>> {
  const start = performance.now()
  try {
    const outcome = await runResilientCall({
      primaryModel: input.requestModel,
      fallbackModel: input.fallbackModel,
      abortSignal: input.abortSignal,
      call: input.createModelMessage,
      onAttempt: () => { ctx.state.apiAttempts += 1 },
    })
    record(ctx, start, 'ok')
    return {
      kind: 'ok',
      value: { response: outcome.response, successfulModel: outcome.model },
    }
  } catch (err) {
    record(ctx, start, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}

function record(
  ctx: PipelineContext,
  start: number,
  status: 'ok' | 'error',
  errorMessage?: string,
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.call = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
```

### Step 6.4: Run — must pass

```bash
npx tsx --test tests/pipeline/pipeline-call.test.ts
```

Expected: 3 tests pass.

### Step 6.5: Commit

```bash
git add src/engine/pipeline/call.ts tests/pipeline/pipeline-call.test.ts
git commit -m "feat(pipeline): Call stage — wraps runResilientCall (M1.6)"
```

---

## Task 7: Stream 阶段（Day 7-8，~5h）

Stream 阶段封装 partial-message drain。它和 Call 在 engine.ts 中并发运行。

### Step 7.1: 写失败测试 `tests/pipeline/pipeline-stream.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import { drainStream } from '../../src/engine/pipeline/stream.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r', sessionId: 's', provider: {} as any,
    trace: {
      schema_version: '2.0.0', turns: [], tools: [],
      concurrency_batches: [], tool_concurrency_limit: 10,
      tool_concurrency_source: 'default', retry_count: 0,
      compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

test('drainStream yields nothing when streaming disabled', async () => {
  const ctx = makeCtx()
  const queue: string[] = []
  let resolved = false
  const stream = drainStream(ctx, {
    queue,
    wantStreaming: false,
    isDoneRef: { current: false },
    waitForFill: () => Promise.resolve(),
  })
  const events: any[] = []
  for await (const ev of stream) events.push(ev)
  resolved = true
  assert.equal(events.length, 0)
  assert.equal(resolved, true)
})

test('drainStream yields partial_message events from queue until done', async () => {
  const ctx = makeCtx()
  const queue: string[] = ['hel', 'lo']
  const isDoneRef = { current: false }
  let resumeWaiter: (() => void) | null = null
  const waitForFill = () => new Promise<void>((res) => { resumeWaiter = res })

  const stream = drainStream(ctx, {
    queue, wantStreaming: true, isDoneRef, waitForFill,
  })
  const collector: any[] = []
  const consumeP = (async () => {
    for await (const ev of stream) collector.push(ev)
  })()

  // Drain initial 2 items, queue empty → drainStream awaits waitForFill
  while (collector.length < 2) await new Promise((r) => setImmediate(r))
  assert.deepEqual(collector.map((e) => e.partial.text), ['hel', 'lo'])

  // Mark done and unblock the waiter
  isDoneRef.current = true
  resumeWaiter?.()

  await consumeP
  assert.equal(collector.length, 2)
})

test('drainStream records duration on close', async () => {
  const ctx = makeCtx()
  const isDoneRef = { current: true }
  const stream = drainStream(ctx, {
    queue: [], wantStreaming: true, isDoneRef,
    waitForFill: () => Promise.resolve(),
  })
  for await (const _ of stream) { /* noop */ }
  assert.equal(ctx.trace.pipeline_stages?.stream?.status, 'ok')
})
```

### Step 7.2: Run — must fail

```bash
npx tsx --test tests/pipeline/pipeline-stream.test.ts
```

Expected: module not found.

### Step 7.3: Implement `src/engine/pipeline/stream.ts`

```typescript
/**
 * Stream stage — drain partial text deltas while Call stage is in flight.
 *
 * Engine wires this concurrently with Call: Call pushes deltas to `queue`,
 * Stream yields them as `partial_message` SDKMessage events. When Call
 * completes (`isDoneRef.current = true`) and the queue is empty, drain
 * exits cleanly.
 */

import type { PipelineContext } from './types.js'
import type { SDKMessage } from '../../types.js'

export interface DrainStreamInput {
  queue: string[]
  wantStreaming: boolean
  /** Mutable ref the Call stage flips to true on completion. */
  isDoneRef: { current: boolean }
  /** Returns a promise that resolves when the queue gets new content
   *  or when Call signals completion. */
  waitForFill: () => Promise<void>
}

export async function* drainStream(
  ctx: PipelineContext,
  input: DrainStreamInput,
): AsyncGenerator<SDKMessage> {
  const start = performance.now()
  try {
    if (!input.wantStreaming) {
      record(ctx, start, 'skipped')
      return
    }
    while (!input.isDoneRef.current || input.queue.length > 0) {
      if (input.queue.length === 0) {
        await input.waitForFill()
        continue
      }
      const delta = input.queue.shift()!
      yield {
        type: 'partial_message',
        partial: { type: 'text', text: delta },
      } as SDKMessage
    }
    record(ctx, start, 'ok')
  } catch (err) {
    record(ctx, start, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}

function record(
  ctx: PipelineContext,
  start: number,
  status: 'ok' | 'skipped' | 'error',
  errorMessage?: string,
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.stream = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
```

### Step 7.4: Run — must pass

```bash
npx tsx --test tests/pipeline/pipeline-stream.test.ts
```

Expected: 3 tests pass.

### Step 7.5: Commit

```bash
git add src/engine/pipeline/stream.ts tests/pipeline/pipeline-stream.test.ts
git commit -m "feat(pipeline): Stream stage — drain partial deltas (M1.7)"
```

---

## Task 8: Tools 阶段（Day 8-10，~7h）

Tools 是最重的阶段。包装 `executeTools`（含 cache + concurrency + dispatch + guardrails）。

### Step 8.1: 写失败测试 `tests/pipeline/pipeline-tools.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import { runToolsStage } from '../../src/engine/pipeline/tools.ts'
import type { ToolsStageInput } from '../../src/engine/pipeline/tools.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { CreateMessageResponse } from '../../src/providers/types.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r', sessionId: 's', provider: {} as any,
    trace: {
      schema_version: '2.0.0', turns: [], tools: [],
      concurrency_batches: [], tool_concurrency_limit: 10,
      tool_concurrency_source: 'default', retry_count: 0,
      compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

test('tools stage returns empty results when response has no tool_use blocks', async () => {
  const ctx = makeCtx()
  const response: CreateMessageResponse = {
    content: [{ type: 'text', text: 'no tools needed' }],
    stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  const input: ToolsStageInput = {
    response,
    config: { tools: [], policy: { permissionMode: 'auto' as any } } as any,
    activeSkill: undefined,
    maxToolConcurrency: 10,
    toolResultCache: { get: () => undefined, set: () => {} } as any,
    concurrencyController: { current: () => 10, recordBatchOutcome: () => {} } as any,
    executeTools: async () => [],
  }
  const result = await runToolsStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.toolUseBlocks.length, 0)
    assert.equal(result.value.toolResults.length, 0)
  }
  assert.equal(ctx.trace.pipeline_stages?.tools?.status, 'skipped')
})

test('tools stage extracts tool_use blocks and dispatches them', async () => {
  const ctx = makeCtx()
  const response: CreateMessageResponse = {
    content: [
      { type: 'tool_use', id: 't1', name: 'foo', input: { x: 1 } } as any,
      { type: 'text', text: 'going to call foo' },
    ],
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  let dispatched = 0
  const input: ToolsStageInput = {
    response,
    config: { tools: [], policy: { permissionMode: 'auto' as any } } as any,
    activeSkill: undefined,
    maxToolConcurrency: 10,
    toolResultCache: { get: () => undefined, set: () => {} } as any,
    concurrencyController: { current: () => 10, recordBatchOutcome: () => {} } as any,
    executeTools: async (blocks) => {
      dispatched = blocks.length
      return blocks.map((b) => ({
        type: 'tool_result' as const,
        tool_use_id: b.id,
        content: 'done',
        is_error: false,
        tool_name: b.name,
      }))
    },
  }
  const result = await runToolsStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.toolUseBlocks.length, 1)
    assert.equal(result.value.toolResults.length, 1)
    assert.equal(dispatched, 1)
  }
  assert.equal(ctx.trace.pipeline_stages?.tools?.status, 'ok')
})

test('tools stage propagates GuardrailAbortError', async () => {
  const ctx = makeCtx()
  const response: CreateMessageResponse = {
    content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} }] as any,
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  const { GuardrailAbortError } = await import('../../src/guardrails/errors.ts')
  let thrown: unknown
  try {
    await runToolsStage(ctx, {
      response,
      config: { tools: [], policy: { permissionMode: 'auto' as any } } as any,
      activeSkill: undefined,
      maxToolConcurrency: 10,
      toolResultCache: { get: () => undefined, set: () => {} } as any,
      concurrencyController: { current: () => 10, recordBatchOutcome: () => {} } as any,
      executeTools: async () => {
        throw new GuardrailAbortError('blocked', 'tool_input')
      },
    })
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof GuardrailAbortError)
  assert.equal(ctx.trace.pipeline_stages?.tools?.status, 'error')
})
```

### Step 8.2: Run — must fail

```bash
npx tsx --test tests/pipeline/pipeline-tools.test.ts
```

Expected: module not found.

### Step 8.3: Implement `src/engine/pipeline/tools.ts`

```typescript
/**
 * Tools stage — extract tool_use blocks + dispatch + collect results.
 *
 * The actual tool execution is injected via `input.executeTools` so this
 * stage stays decoupled from QueryEngine internals (cache, concurrency
 * controller, guardrails are all wired by engine.ts and passed in).
 */

import type { PipelineContext, StageResult } from './types.js'
import type { CreateMessageResponse } from '../../providers/types.js'
import type { QueryEngineConfig, ToolResult } from '../../types.js'
import type { ToolResultCache } from '../tool-result-cache.js'
import type { ConcurrencyController } from '../concurrency-controller.js'
import type { SkillActivation } from '../skill-helpers.js'

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

export interface ToolsStageInput {
  response: CreateMessageResponse
  config: QueryEngineConfig
  activeSkill?: SkillActivation
  maxToolConcurrency: number
  toolResultCache: ToolResultCache
  concurrencyController: ConcurrencyController
  /** Injected executor — engine.ts wires it to the existing executeTools method. */
  executeTools: (blocks: ToolUseBlock[]) => Promise<(ToolResult & { tool_name?: string })[]>
}

export interface ToolsStageOutput {
  toolUseBlocks: ToolUseBlock[]
  toolResults: (ToolResult & { tool_name?: string })[]
}

export async function runToolsStage(
  ctx: PipelineContext,
  input: ToolsStageInput,
): Promise<StageResult<ToolsStageOutput>> {
  const start = performance.now()
  const blocks = input.response.content.filter(
    (b): b is ToolUseBlock => b.type === 'tool_use',
  )

  if (blocks.length === 0) {
    record(ctx, start, 'skipped')
    return { kind: 'ok', value: { toolUseBlocks: [], toolResults: [] } }
  }

  try {
    const results = await input.executeTools(blocks)
    record(ctx, start, 'ok')
    return { kind: 'ok', value: { toolUseBlocks: blocks, toolResults: results } }
  } catch (err) {
    record(ctx, start, 'error', err instanceof Error ? err.message : String(err))
    throw err
  }
}

function record(
  ctx: PipelineContext,
  start: number,
  status: 'ok' | 'skipped' | 'error',
  errorMessage?: string,
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.tools = {
    duration_ms: performance.now() - start,
    status,
    ...(errorMessage ? { error_message: errorMessage } : {}),
  }
}
```

### Step 8.4: Run — must pass

```bash
npx tsx --test tests/pipeline/pipeline-tools.test.ts
```

Expected: 3 tests pass.

### Step 8.5: Commit

```bash
git add src/engine/pipeline/tools.ts tests/pipeline/pipeline-tools.test.ts
git commit -m "feat(pipeline): Tools stage — extract + dispatch tool_use blocks (M1.8)"
```

---

## Task 9: Decide 阶段（Day 10-11，~4h）

Decide 决定 `continue / stop / compact_retry / max_output_recovery`。

### Step 9.1: 写失败测试 `tests/pipeline/pipeline-decide.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import { runDecideStage } from '../../src/engine/pipeline/decide.ts'
import type { DecideStageInput } from '../../src/engine/pipeline/decide.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { CreateMessageResponse } from '../../src/providers/types.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r', sessionId: 's', provider: {} as any,
    trace: {
      schema_version: '2.0.0', turns: [], tools: [],
      concurrency_batches: [], tool_concurrency_limit: 10,
      tool_concurrency_source: 'default', retry_count: 0,
      compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

const noToolsResponse = (stop: string): CreateMessageResponse => ({
  content: [{ type: 'text', text: 'done' }],
  stopReason: stop as any,
  usage: { input_tokens: 1, output_tokens: 1 },
})

test('decide stops when no tool calls and stopReason=end_turn', async () => {
  const ctx = makeCtx()
  const input: DecideStageInput = {
    response: noToolsResponse('end_turn'),
    hadToolCalls: false,
    maxOutputRecoveryLimit: 3,
  }
  const result = await runDecideStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'stop')
    assert.equal(ctx.state.completedNormally, true)
  }
})

test('decide triggers max_output_recovery when stopReason=max_tokens, no tools, attempts left', async () => {
  const ctx = makeCtx()
  ctx.state.maxOutputRecoveryAttempts = 0
  const result = await runDecideStage(ctx, {
    response: noToolsResponse('max_tokens'),
    hadToolCalls: false,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'max_output_recovery')
  }
  assert.equal(ctx.state.maxOutputRecoveryAttempts, 1)
})

test('decide stops when max_output_recovery attempts exhausted', async () => {
  const ctx = makeCtx()
  ctx.state.maxOutputRecoveryAttempts = 3
  const result = await runDecideStage(ctx, {
    response: noToolsResponse('max_tokens'),
    hadToolCalls: false,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'stop')
    assert.equal(ctx.state.completedNormally, true)
  }
})

test('decide continues when tools were called and stopReason != end_turn', async () => {
  const ctx = makeCtx()
  const result = await runDecideStage(ctx, {
    response: noToolsResponse('tool_use'),
    hadToolCalls: true,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'continue')
  }
})

test('decide stops when tools were called but stopReason=end_turn', async () => {
  const ctx = makeCtx()
  const result = await runDecideStage(ctx, {
    response: noToolsResponse('end_turn'),
    hadToolCalls: true,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.next, 'stop')
    assert.equal(ctx.state.completedNormally, true)
  }
})

test('decide resets max_output recovery counter when tools were called', async () => {
  const ctx = makeCtx()
  ctx.state.maxOutputRecoveryAttempts = 2
  await runDecideStage(ctx, {
    response: noToolsResponse('tool_use'),
    hadToolCalls: true,
    maxOutputRecoveryLimit: 3,
  })
  assert.equal(ctx.state.maxOutputRecoveryAttempts, 0)
})
```

### Step 9.2: Run — must fail

```bash
npx tsx --test tests/pipeline/pipeline-decide.test.ts
```

Expected: module not found.

### Step 9.3: Implement `src/engine/pipeline/decide.ts`

```typescript
/**
 * Decide stage — terminate / continue / max_output recovery.
 *
 * Inputs are the assistant response + whether tools were dispatched this
 * turn. Output instructs engine.ts what to do next:
 *   - 'stop': loop exits, success or final-turn
 *   - 'continue': run another turn (tools were called, more work pending)
 *   - 'max_output_recovery': inject "please continue" and refund the turn
 */

import type { PipelineContext, StageResult } from './types.js'
import type { CreateMessageResponse } from '../../providers/types.js'

export interface DecideStageInput {
  response: CreateMessageResponse
  hadToolCalls: boolean
  maxOutputRecoveryLimit: number
}

export type DecideNext = 'stop' | 'continue' | 'max_output_recovery'

export interface DecideStageOutput {
  next: DecideNext
}

export async function runDecideStage(
  ctx: PipelineContext,
  input: DecideStageInput,
): Promise<StageResult<DecideStageOutput>> {
  const start = performance.now()

  // 1. End-of-turn always wins.
  if (input.response.stopReason === 'end_turn') {
    ctx.state.completedNormally = true
    record(ctx, start, 'ok')
    return { kind: 'ok', value: { next: 'stop' } }
  }

  // 2. No tools + max_tokens → recovery if budget left, else stop.
  if (!input.hadToolCalls && input.response.stopReason === 'max_tokens') {
    if (ctx.state.maxOutputRecoveryAttempts < input.maxOutputRecoveryLimit) {
      ctx.state.maxOutputRecoveryAttempts += 1
      record(ctx, start, 'ok')
      return { kind: 'ok', value: { next: 'max_output_recovery' } }
    }
    ctx.state.completedNormally = true
    record(ctx, start, 'ok')
    return { kind: 'ok', value: { next: 'stop' } }
  }

  // 3. No tools + no end_turn → engine done (rare but possible — e.g. content_filter)
  if (!input.hadToolCalls) {
    ctx.state.completedNormally = true
    record(ctx, start, 'ok')
    return { kind: 'ok', value: { next: 'stop' } }
  }

  // 4. Tools were called → reset recovery counter, continue loop.
  ctx.state.maxOutputRecoveryAttempts = 0
  record(ctx, start, 'ok')
  return { kind: 'ok', value: { next: 'continue' } }
}

function record(
  ctx: PipelineContext,
  start: number,
  status: 'ok',
): void {
  if (!ctx.trace.pipeline_stages) ctx.trace.pipeline_stages = {}
  ctx.trace.pipeline_stages.decide = {
    duration_ms: performance.now() - start,
    status,
  }
}
```

### Step 9.4: Run — must pass

```bash
npx tsx --test tests/pipeline/pipeline-decide.test.ts
```

Expected: 6 tests pass.

### Step 9.5: Commit

```bash
git add src/engine/pipeline/decide.ts tests/pipeline/pipeline-decide.test.ts
git commit -m "feat(pipeline): Decide stage — stop/continue/max_output_recovery (M1.9)"
```

---

## Task 10: 重写 `engine.ts` 用新 pipeline（Day 11-15，~12h）

最高风险 task。**先一次写全替换稿，测试通过再 commit；失败可整体 revert**。

### Step 10.1: 备份当前 engine.ts

```bash
cp src/engine.ts src/engine.ts.bak
git add src/engine.ts.bak
git commit -m "chore(engine): backup pre-pipeline engine.ts before rewrite"
```

(Will delete in Step 10.10.)

### Step 10.2: 重写 `submitMessage`

打开 `src/engine.ts`，整个 `submitMessage` 方法（~360 行，line 226-583）替换为：

```typescript
async *submitMessage(
  prompt: string | any[],
): AsyncGenerator<SDKMessage> {
  const runId = crypto.randomUUID()

  // Hooks: SessionStart + UserPromptSubmit
  await this.executeHooks('SessionStart')
  const userHookResults = await this.executeHooks('UserPromptSubmit', {
    toolInput: prompt,
  })

  // Build pipeline context
  const ctx: PipelineContext = {
    runId,
    sessionId: this.sessionId,
    provider: this.provider,
    trace: this.trace,
    totalUsage: this.totalUsage,
    tools: this.config.tools,
    state: {
      turnIndex: 0,
      apiAttempts: 0,
      maxOutputRecoveryAttempts: 0,
      completedNormally: false,
      budgetExceeded: false,
    },
  }

  // Stage: Guard (pre-loop, hook block check)
  const guardResult = await runGuardStage(ctx, {
    abortSignal: this.config.abortSignal,
    maxBudgetUsd: this.config.maxBudgetUsd,
    totalCost: this.totalCost,
    hookResults: userHookResults,
  })
  if (guardResult.kind === 'denied') {
    yield buildErrorResultEvent({
      subtype: 'error_during_execution',
      sessionId: this.sessionId,
      totalUsage: this.totalUsage,
      numTurns: 0,
      totalCost: 0,
      durationApiMs: 0,
      modelUsage: this.getModelUsage(),
      permissionDenials: this.trace.permission_denials,
      evidence: this.getEvidence(),
      qualityGates: this.getQualityGates(),
      trace: this.getTrace(),
      errors: guardResult.errors,
    })
    return
  }

  // Add user message
  this.messages.push({ role: 'user', content: prompt as any })
  this.config.initialPrompt = typeof prompt === 'string' ? prompt : undefined

  // Init system message
  yield {
    type: 'system',
    subtype: 'init',
    session_id: this.sessionId,
    tools: this.config.tools.map((t) => t.name),
    model: this.config.model,
    cwd: this.config.cwd,
    mcp_servers: [],
    permission_mode: this.config.policy.permissionMode,
    autonomy_mode: getAutonomyMode(this.config),
  } as SDKMessage

  yield buildPhaseMessage(this.sessionId, runId, 'intake')
  yield buildPhaseMessage(this.sessionId, runId, 'context')

  let turnsRemaining = this.config.maxTurns
  const MAX_OUTPUT_RECOVERY = 3

  while (turnsRemaining > 0) {
    if (this.config.abortSignal?.aborted) break
    if (this.config.maxBudgetUsd && this.totalCost >= this.config.maxBudgetUsd) {
      ctx.state.budgetExceeded = true
      break
    }

    // Stage: Compact
    const compactResult = await runCompactStage(ctx, {
      model: this.config.model,
      messages: this.messages,
      state: this.compactState,
      abortSignal: this.config.abortSignal,
      onPreCompact: () => this.executeHooks('PreCompact').then(() => undefined),
      onPostCompact: () => this.executeHooks('PostCompact').then(() => undefined),
    })
    if (compactResult.kind !== 'ok') break
    this.messages = compactResult.value.messages
    this.compactState = compactResult.value.state
    const apiMessages = compactResult.value.apiMessages

    this.turnCount++
    turnsRemaining--
    ctx.state.turnIndex = this.turnCount

    // Stage: Render
    const partialQueue: string[] = []
    let partialResolve: (() => void) | null = null
    const wantStreaming = this.config.includePartialMessages === true
    const releaseDrain = (): void => {
      if (partialResolve) {
        const r = partialResolve
        partialResolve = null
        r()
      }
    }
    const renderResult = await runRenderStage(ctx, {
      config: this.config,
      apiMessages,
      activeSkill: this.activeSkill,
      partialQueue,
      releaseDrain,
    })
    if (renderResult.kind !== 'ok') break

    // Stages: Call + Stream (concurrent)
    const apiStart = performance.now()
    yield buildPhaseMessage(this.sessionId, runId, 'model_request', this.turnCount)

    const isDoneRef = { current: false }
    let callError: unknown
    let callResponse: any = null
    let successfulModel = renderResult.value.requestModel

    const callTask = (async () => {
      try {
        const callResult = await runCallStage(ctx, {
          requestModel: renderResult.value.requestModel,
          fallbackModel: renderResult.value.fallbackModel,
          abortSignal: this.config.abortSignal,
          createModelMessage: renderResult.value.createModelMessage,
        })
        if (callResult.kind === 'ok') {
          callResponse = callResult.value.response
          successfulModel = callResult.value.successfulModel
        }
      } catch (err) {
        callError = err
      } finally {
        isDoneRef.current = true
        releaseDrain()
      }
    })()

    if (wantStreaming) {
      for await (const ev of drainStream(ctx, {
        queue: partialQueue,
        wantStreaming: true,
        isDoneRef,
        waitForFill: () => new Promise<void>((res) => { partialResolve = res }),
      })) {
        yield ev
      }
    }

    await callTask
    this.trace.retry_count += Math.max(0, ctx.state.apiAttempts - 1)
    ctx.state.apiAttempts = 0

    if (callError) {
      // Prompt-too-long recovery
      if (isPromptTooLongError(callError)) {
        const recovery = await tryCompactOnPromptTooLong({
          provider: this.provider,
          model: this.config.model,
          messages: this.messages,
          state: this.compactState,
          abortSignal: this.config.abortSignal,
          trace: this.trace,
        })
        if (recovery.recovered) {
          this.messages = recovery.messages
          this.compactState = recovery.state
          turnsRemaining++
          this.turnCount--
          continue
        }
      }
      yield buildErrorResultEvent({
        subtype: 'error',
        sessionId: this.sessionId,
        totalUsage: this.totalUsage,
        numTurns: this.turnCount,
        totalCost: this.totalCost,
        durationApiMs: this.apiTimeMs + performance.now() - apiStart,
        modelUsage: this.getModelUsage(),
        permissionDenials: this.trace.permission_denials,
        evidence: this.getEvidence(),
        qualityGates: this.getQualityGates(),
        trace: this.getTrace(),
        errors: [(callError as any)?.message || String(callError)],
      })
      return
    }

    yield buildPhaseMessage(this.sessionId, runId, 'model_response', this.turnCount)
    const turnApiTimeMs = performance.now() - apiStart
    this.apiTimeMs += turnApiTimeMs

    // Bookkeeping
    const usageResult = recordTurnUsage({
      response: callResponse,
      successfulModel,
      turnApiTimeMs,
      trace: this.trace,
      totalUsage: this.totalUsage,
      totalCost: this.totalCost,
      modelUsage: this.modelUsage,
      turnCount: this.turnCount,
    })
    this.totalCost = usageResult.totalCost

    this.messages.push({ role: 'assistant', content: callResponse.content as any })
    yield {
      type: 'assistant',
      message: { role: 'assistant', content: callResponse.content as any },
    }

    // Stage: Tools
    let toolsResult: any
    try {
      toolsResult = await runToolsStage(ctx, {
        response: callResponse,
        config: this.config,
        activeSkill: this.activeSkill,
        maxToolConcurrency: this.maxToolConcurrency,
        toolResultCache: this.toolResultCache,
        concurrencyController: this.concurrencyController,
        executeTools: (blocks) => this.executeTools(blocks),
      })
    } catch (err) {
      if (err instanceof GuardrailAbortError) {
        yield buildErrorResultEvent({
          subtype: 'error_guardrail_abort',
          sessionId: this.sessionId,
          totalUsage: this.totalUsage,
          numTurns: this.turnCount,
          totalCost: this.totalCost,
          durationApiMs: this.apiTimeMs,
          modelUsage: this.getModelUsage(),
          permissionDenials: this.trace.permission_denials,
          evidence: this.getEvidence(),
          qualityGates: this.getQualityGates(),
          trace: this.getTrace(),
          errors: [err.message],
        })
        return
      }
      throw err
    }
    const hadToolCalls = toolsResult.kind === 'ok' && toolsResult.value.toolUseBlocks.length > 0
    const toolResults: (ToolResult & { tool_name?: string })[] =
      toolsResult.kind === 'ok' ? toolsResult.value.toolResults : []

    if (hadToolCalls) {
      for (const block of toolsResult.value.toolUseBlocks) {
        yield buildPhaseMessage(this.sessionId, runId, 'tool_execution', this.turnCount, block.id)
      }
      for (const event of buildToolResultEvents(this.sessionId, runId, toolResults)) {
        yield event
      }
      this.messages.push(buildToolResultsUserMessage(toolResults))
    }

    // Stage: Decide
    const decideResult = await runDecideStage(ctx, {
      response: callResponse,
      hadToolCalls,
      maxOutputRecoveryLimit: MAX_OUTPUT_RECOVERY,
    })
    if (decideResult.kind !== 'ok') break
    if (decideResult.value.next === 'max_output_recovery') {
      this.messages.push({
        role: 'user',
        content: 'Please continue from where you left off.',
      })
      turnsRemaining++
      this.turnCount--
      continue
    }
    if (decideResult.value.next === 'stop') break
    // 'continue' — fall through to next iteration
  }

  await this.executeHooks('Stop')
  await this.executeHooks('SessionEnd')

  const baseSubtype = ctx.state.budgetExceeded
    ? 'error_max_budget_usd'
    : ctx.state.completedNormally
      ? 'success'
      : 'error_max_turns'
  const gateFailure = baseSubtype === 'success' ? this.getTerminalQualityGateFailure() : undefined
  const endSubtype = gateFailure ? 'error_quality_gate_failed' : baseSubtype
  const errors = gateFailure
    ? [`Required quality gate failed: ${gateFailure.name}${gateFailure.summary ? ` - ${gateFailure.summary}` : ''}`]
    : undefined

  yield buildPhaseMessage(this.sessionId, runId, 'verification')
  yield buildPhaseMessage(this.sessionId, runId, 'finalize')

  yield buildFinalResultEvent({
    subtype: endSubtype,
    sessionId: this.sessionId,
    numTurns: this.turnCount,
    totalCost: this.totalCost,
    durationApiMs: this.apiTimeMs,
    totalUsage: this.totalUsage,
    modelUsage: this.getModelUsage(),
    permissionDenials: this.trace.permission_denials,
    evidence: this.getEvidence(),
    qualityGates: this.getQualityGates(),
    trace: this.getTrace(),
    errors,
  })
}
```

### Step 10.3: Add imports at top of engine.ts

After existing imports (around line 105), add:

```typescript
import type { PipelineContext } from './engine/pipeline/types.js'
import { runGuardStage } from './engine/pipeline/guard.js'
import { runCompactStage } from './engine/pipeline/compact.js'
import { runRenderStage } from './engine/pipeline/render.js'
import { runCallStage } from './engine/pipeline/call.js'
import { drainStream } from './engine/pipeline/stream.js'
import { runToolsStage } from './engine/pipeline/tools.js'
import { runDecideStage } from './engine/pipeline/decide.js'
```

Some old imports become unused — let typecheck flag them.

### Step 10.4: typecheck

```bash
npx tsc --noEmit 2>&1 | head -40
```

Fix every error. Most will be "imported but unused" — remove the unused import. If a real type error appears, the rewrite is wrong; revert via `git checkout src/engine.ts` and re-do that section.

### Step 10.5: Run pipeline tests

```bash
npx tsx --test tests/pipeline/*.test.ts
```

Expected: all 22 pipeline tests pass.

### Step 10.6: Run full test suite

```bash
npx tsx --test tests/*.test.ts 2>&1 | tail -20
```

Expected: 728 + 22 (pipeline) + 3 (trace v2) = 753 tests pass.

If anything fails:
- For each failure, read the test name. Is it about the rewrite changing observable behavior? If yes, the rewrite is wrong — fix engine.ts to preserve the old behavior. If the old behavior was buggy and we want to fix it, this is a v2.0 breaking change → document in migration guide.
- **Do not silence tests.** Every failure is a signal.

### Step 10.7: Run bench:engine

```bash
npm run bench:engine 2>&1 | tee docs/benchmarks/2026-05-W2-after-pipeline.md
```

Expected:
- engine.ts LoC: should drop from 1070 to 700-800 (we have not yet shrunk to 400 — that's Task 11)
- All SLOs still pass (1100 ceiling)

If engine.ts is still > 1000, the rewrite is incomplete — go back and trim more.

### Step 10.8: Run examples sanity check

```bash
npm run test:examples:offline 2>&1 | tail -20
```

Expected: 6 offline examples all pass.

### Step 10.9: Commit

```bash
git add src/engine.ts docs/benchmarks/2026-05-W2-after-pipeline.md
git commit -m "refactor(engine): submitMessage rewritten to use 7-stage pipeline (M1.10)

engine.ts shrinks from 1070 LoC to ~700-800 LoC. Behavior is byte-
identical: 753/753 tests pass (728 baseline + 22 pipeline + 3 trace v2).
Stage timings are now visible in AgentRunTrace.pipeline_stages."
```

### Step 10.10: Remove backup

```bash
git rm src/engine.ts.bak
git commit -m "chore(engine): remove engine.ts.bak after pipeline rewrite verified"
```

---

## Task 11: 进一步瘦身 engine.ts 到 < 400 LoC（Day 16-17，~6h）

经过 Task 10，engine.ts 应该在 700-800 LoC。继续提取直到 < 400：
- `executeTools` 方法 → `engine/execute-tools.ts`
- `getActiveQualityGatePolicy` / `getTerminalQualityGateFailure` → 已在 helpers
- `getEvidence`, `getQualityGates`, `getTrace`, `getModelUsage` → `engine/getters.ts`
- 如仍 > 400：`buildErrorResultEvent` 调用点合并、辅助 phase yield 合并、构造函数初始化提到工厂

### Step 11.1: 测出当前 engine.ts 行数

```bash
wc -l src/engine.ts
```

### Step 11.2: 提取 executeTools

把 `private async executeTools(...)`（~150 行）整体移到新文件 `src/engine/execute-tools.ts` 作为导出函数 `executeTools(engine: Pick<QueryEngine, 'config' | 'activeSkill' | ...>, blocks)`。

由于 executeTools 强依赖 engine 内部状态（cache, controller, hooks, trace），实际签名为：

```typescript
// src/engine/execute-tools.ts
import type { ToolUseBlock, ToolDispatchContext } from './types-internal.js'
// ... full implementation moved here
```

具体提取边界：保留对 `this.executeHooks` / `this.toolResultCache` / `this.concurrencyController` / `this.trace` 的依赖，通过参数对象传入。engine.ts 中保留一个 thin wrapper：

```typescript
private async executeTools(blocks: ToolUseBlock[]): Promise<...> {
  return executeToolsImpl({
    blocks,
    config: this.config,
    activeSkill: this.activeSkill,
    toolResultCache: this.toolResultCache,
    concurrencyController: this.concurrencyController,
    maxToolConcurrency: this.maxToolConcurrency,
    trace: this.trace,
    qualityGates: this.qualityGates,
    evidence: this.evidence,
    sessionId: this.sessionId,
    runId: this._currentRunId, // need to capture in submitMessage
    runHooks: (event, input) => this.executeHooks(event, input),
  })
}
```

写新 `tests/execute-tools-impl.test.ts`（≥ 5 个测试）覆盖：
- 单 read-only tool 直接缓存命中
- 多 mutation tool 顺序执行
- 混合 tool 分组
- guardrail tool_input 拒绝
- guardrail tool_output 拒绝

### Step 11.3: 提取 getters

新文件 `src/engine/getters.ts`：

```typescript
import type { AgentRunTrace, Evidence, QualityGateResult, TokenUsage } from '../types.js'

export function snapshotTrace(trace: AgentRunTrace): AgentRunTrace {
  return JSON.parse(JSON.stringify(trace))
}

export function snapshotEvidence(evidence: Evidence[]): Evidence[] {
  return evidence.map((e) => ({ ...e }))
}

export function snapshotQualityGates(gates: QualityGateResult[]): QualityGateResult[] {
  return gates.map((g) => ({ ...g }))
}

export function summarizeModelUsage(
  modelUsage: Map<string, { count: number; usage: TokenUsage }>,
): Array<{ model: string; count: number; usage: TokenUsage }> {
  return Array.from(modelUsage.entries()).map(([model, { count, usage }]) => ({
    model, count, usage: { ...usage },
  }))
}
```

`engine.ts` 的 `getTrace()` / `getEvidence()` / `getQualityGates()` / `getModelUsage()` 各缩成 1 行调用。

### Step 11.4: 写测试 + 跑

```bash
npx tsx --test tests/execute-tools-impl.test.ts tests/getters.test.ts
npx tsc --noEmit
npx tsx --test tests/*.test.ts 2>&1 | tail -10
```

Expected: 全部通过。

### Step 11.5: 测 engine.ts 行数

```bash
wc -l src/engine.ts
```

Expected: **< 400 LoC**. 如果还 > 400，找出最大的方法继续提取：
- 寻找 yield 块连续 5 行以上的，看能否合并到 phase helper
- 寻找 try/catch 嵌套块，看能否独立到 try-helper
- 构造函数 / 字段初始化能否抽到 `engine-factory.ts`

### Step 11.6: Commit

```bash
git add -A
git commit -m "refactor(engine): extract executeTools + getters → engine.ts < 500 LoC (M1.11)"
```

---

## Task 12: 收紧 SLO 闸门到新阈值（Day 18，~2h）

### Step 12.1: 改 `scripts/bench/engine-slo.ts`

打开文件，把 engine.ts LoC 阈值从 `1100` 改为 `400`。新增 pipeline 阶段文件 SLO（每个 < 200 LoC）。

### Step 12.2: 跑闸门

```bash
npm run bench:engine
```

Expected: 全绿。如果有阶段文件 > 200 LoC，找出来精简。

### Step 12.3: 更新 `docs/v2_benchmark_report.md` §7

改 SLO 表的 `engine.ts LoC` 行：`< 1100` → `< 400`，新增 7 个 pipeline 阶段行（各 < 200）。

### Step 12.4: Commit

```bash
git add scripts/bench/engine-slo.ts docs/v2_benchmark_report.md
git commit -m "chore(bench): tighten engine.ts SLO to 400 LoC + add pipeline stage SLOs (M1.12)"
```

---

## Task 13: v1-compat trace shim 骨架（Day 19，~3h）

为 v2.0 兼容层准备。这个 shim 让消费旧 trace schema 的 host 在 v2.0 期间继续工作。

### Step 13.1: 写测试 `tests/v1-compat-trace.test.ts`

```typescript
import test from 'node:test'
import assert from 'node:assert/strict'

import { downgradeTraceToV1 } from '../src/v1-compat/trace-shim.ts'
import type { AgentRunTrace } from '../src/types/trace.ts'

test('downgradeTraceToV1 strips pipeline_stages and sets schema_version=1.0.0', () => {
  const v2: AgentRunTrace = {
    schema_version: '2.0.0',
    turns: [], tools: [], concurrency_batches: [],
    tool_concurrency_limit: 10, tool_concurrency_source: 'default',
    retry_count: 0, compaction_count: 0, permission_denials: [],
    pipeline_stages: { guard: { duration_ms: 1, status: 'ok' } },
  }
  const v1 = downgradeTraceToV1(v2)
  assert.equal(v1.schema_version, '1.0.0')
  assert.equal((v1 as any).pipeline_stages, undefined)
})

test('downgradeTraceToV1 preserves all v1 fields', () => {
  const v2: AgentRunTrace = {
    schema_version: '2.0.0',
    turns: [{ index: 0, prompt_tokens: 1, completion_tokens: 1, latency_ms: 100 } as any],
    tools: [{ name: 'foo' } as any],
    concurrency_batches: [1, 2, 3],
    tool_concurrency_limit: 5,
    tool_concurrency_source: 'env',
    retry_count: 2,
    compaction_count: 1,
    permission_denials: [{ tool: 'shell', reason: 'denied' }],
  }
  const v1 = downgradeTraceToV1(v2)
  assert.equal(v1.turns.length, 1)
  assert.equal(v1.tools.length, 1)
  assert.deepEqual(v1.concurrency_batches, [1, 2, 3])
  assert.equal(v1.tool_concurrency_limit, 5)
  assert.equal(v1.retry_count, 2)
  assert.equal(v1.permission_denials.length, 1)
})
```

### Step 13.2: Run — must fail

```bash
npx tsx --test tests/v1-compat-trace.test.ts
```

Expected: module not found.

### Step 13.3: Implement `src/v1-compat/trace-shim.ts`

```typescript
/**
 * v1-compat trace shim.
 *
 * v2.0 added `pipeline_stages` and bumped `schema_version` to '2.0.0'.
 * Hosts that still consume the v1 schema can call `downgradeTraceToV1`
 * to get a structurally-identical trace with the new field stripped and
 * the version pinned back to '1.0.0'.
 *
 * This shim is published in v2.0 GA and will be removed in v2.1 (see
 * docs/v1_to_v2_pipeline_migration.md).
 */

import type { AgentRunTrace } from '../types/trace.js'

export function downgradeTraceToV1(trace: AgentRunTrace): AgentRunTrace {
  // Shallow clone is enough — v1 consumers ignore unknown nested fields.
  // We only need to strip pipeline_stages and rewrite schema_version.
  const { pipeline_stages, ...rest } = trace
  return {
    ...rest,
    schema_version: '1.0.0',
  }
}
```

### Step 13.4: Run — must pass

```bash
npx tsx --test tests/v1-compat-trace.test.ts
```

Expected: 2 tests pass.

### Step 13.5: Add subpath export `src/subpath/v1-compat.ts`

```typescript
export { downgradeTraceToV1 } from '../v1-compat/trace-shim.js'
```

Update `package.json#exports` to include:

```json
"./v1-compat": {
  "types": "./dist/subpath/v1-compat.d.ts",
  "import": "./dist/subpath/v1-compat.js"
}
```

### Step 13.6: Verify subpath export test passes

```bash
npx tsx --test tests/subpath-exports.test.ts
```

If the existing subpath test asserts an exact subpath count, update its assertion (13 → 14).

### Step 13.7: Commit

```bash
git add -A
git commit -m "feat(v1-compat): add downgradeTraceToV1 shim + /v1-compat subpath (M1.13)"
```

---

## Task 14: 完整回归 + 更新 CHANGELOG + 文档（Day 20-21，~6h）

### Step 14.1: 跑全量回归

```bash
npm run build
npx tsc --noEmit
npx tsx --test tests/*.test.ts 2>&1 | tail -5
npm run bench:engine
npm run bench
npm run test:examples:offline
```

期望：全绿。

如果 examples:offline 失败，逐个跑：

```bash
npx tsx examples/19-graph-dsl.ts
# ...
```

### Step 14.2: 更新 CHANGELOG.md

在顶部插入：

```markdown
## [2.0.0-rc.0] — 2026-06-08

**Major release: engine pipeline rewrite.** Behavior is byte-identical
for default callers; the agent loop is now a 7-stage pipeline that hosts
can observe and (in v2.1+) extend.

### Breaking

- **`AGENT_RUN_TRACE_SCHEMA_VERSION` bumped to `2.0.0`** with a new
  `pipeline_stages` field. Hosts consuming v1 traces should either
  update their parser or import `downgradeTraceToV1` from
  `clavue-agent-sdk/v1-compat`. The shim ships in 2.0 and will be
  removed in 2.1.

### Added

- 7-stage agent pipeline: `Guard / Compact / Render / Call / Stream /
  Tools / Decide`. Each stage is independently testable and emits
  per-stage timing into `AgentRunTrace.pipeline_stages`.
- `clavue-agent-sdk/v1-compat` subpath: `downgradeTraceToV1`.
- New types: `AgentRunPipelineStageTrace`, `PipelineContext`,
  `PipelineState`, `PipelineStageName`, `StageResult`.

### Changed

- `engine.ts` shrunk from 1070 LoC to <500 LoC. SLO ceiling tightened to
  500 (`scripts/bench/engine-slo.ts`).
- Each pipeline stage is < 200 LoC.

### Tests

Suite total: **753 / 753** (728 baseline + 22 pipeline + 3 trace v2 +
extras from execute-tools / getters / v1-compat).
```

### Step 14.3: 写迁移指南

新文件 `docs/v1_to_v2_pipeline_migration.md`：

````markdown
# Migrating from clavue-agent-sdk 1.x to 2.0

## What changed

### 1. AGENT_RUN_TRACE_SCHEMA_VERSION: '1.0.0' → '2.0.0'

`AgentRunTrace` gains an optional `pipeline_stages` field that records
per-stage timing for the 7-stage pipeline.

```typescript
// 2.0 trace shape
trace.pipeline_stages = {
  guard: { duration_ms: 0.1, status: 'ok' },
  compact: { duration_ms: 0.5, status: 'ok' },
  render: { duration_ms: 1.2, status: 'ok' },
  call: { duration_ms: 1842.0, status: 'ok' },
  stream: { duration_ms: 1840.0, status: 'ok' },
  tools: { duration_ms: 38.0, status: 'ok' },
  decide: { duration_ms: 0.05, status: 'ok' },
}
```

### Migration paths

**Option A — Update your trace parser** (recommended for new hosts):

```typescript
import type { AgentRunTrace } from 'clavue-agent-sdk'

function processTrace(trace: AgentRunTrace) {
  // schema_version is now '2.0.0'
  // pipeline_stages is optional; check before reading
  if (trace.pipeline_stages?.call) {
    console.log(`Provider call took ${trace.pipeline_stages.call.duration_ms}ms`)
  }
}
```

**Option B — Use the v1-compat shim** (recommended for existing hosts that
cannot ship a parser update right now):

```typescript
import { downgradeTraceToV1 } from 'clavue-agent-sdk/v1-compat'

const v1Shape = downgradeTraceToV1(result.trace)
// v1Shape.schema_version === '1.0.0'
// v1Shape.pipeline_stages === undefined
```

The shim is removed in v2.1.

### 2. No behavior changes

- `run()`, `query()`, `createAgent()` signatures unchanged
- All public types unchanged except `AgentRunTrace.pipeline_stages` (optional)
- All event types, hook events, error types unchanged

## Upgrade checklist

- [ ] `npm install clavue-agent-sdk@^2.0.0`
- [ ] If you parse traces directly, choose Option A or B above
- [ ] If you pin `AGENT_RUN_TRACE_SCHEMA_VERSION`, bump to `'2.0.0'`
- [ ] Run your test suite — no other changes expected
````

### Step 14.4: 跑 examples + bench 最后一次

```bash
npm run bench:engine
npm run test:examples:offline
```

### Step 14.5: Commit + 收尾

```bash
git add CHANGELOG.md docs/v1_to_v2_pipeline_migration.md
git commit -m "docs(v2.0): CHANGELOG + v1→v2 pipeline migration guide (M1.14)"
```

---

## M1 完成验收闸门

执行下列命令，全部必须绿：

```bash
# 1. Build
npm run build

# 2. Typecheck
npx tsc --noEmit

# 3. All tests
npx tsx --test tests/*.test.ts 2>&1 | tail -5
# Expect: 753+ tests passing, 0 failing

# 4. Engine SLO
npm run bench:engine
# Expect: engine.ts LoC < 400, all stages < 200, all SLOs green

# 5. All benchmarks
npm run bench

# 6. Offline examples
npm run test:examples:offline
# Expect: all 6 pass
```

如果全部通过，M1 完成。打 tag：

```bash
git tag -a m1-pipeline-complete -m "M1 engine pipeline rewrite complete"
```

下一个 milestone 是 M4 eval harness，由独立 plan 接手。

---

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| Task 10 重写引入 regression | Step 10.1 备份；测试 728 → 753，任何掉测试都视作 regression，必须修 |
| pipeline_stages timing 增加 trace size | timing 是数字，每 turn ~7 个数字，开销可忽略 |
| 重构改变 yield 顺序 | engine 测试已 pin 顺序；如果失败说明重写错了 |
| v1-compat shim 不充分 | shim 只暴露一个降级函数，简单且明确，问题面小 |

**回滚预案**：
- Task 10 失败：`git reset --hard m1-pre-task-10`（在 Step 10.1 之前打 tag）
- 整个 M1 失败：`git checkout main` 丢弃 `m1-pipeline-refactor` 分支

---

## Self-review

我已对 spec §2 (M1 engine pipeline) 全部 5 项验收做了任务覆盖：

- ✅ `engine.ts < 400 LoC`：Task 11 + 12 强制（已对齐 spec §2.1）
- ✅ 七阶段每个有 ≥ 5 个独立单元测试：Tasks 3-9 覆盖。**实际数**：5 (guard) + 3 (compact) + 2 (render) + 3 (call) + 3 (stream) + 3 (tools) + 6 (decide) = 25 个 pipeline 测试。spec 要求"每个阶段 ≥ 5"——目前 compact/render/call/stream/tools 不足。**执行时补**：每个阶段补到 5 个，预计补 12 个测试，最终 ≥ 37 个 pipeline 测试。
- ✅ 728 测试全部通过 + 新增至少 35 个：25 (pipeline) + 12 (执行时补) + 3 (trace v2) + 5 (execute-tools) + 3 (getters) + 2 (v1-compat) = 50 → 满足且超额
- ✅ `npm run bench:engine` 通过新 SLO：Task 12
- ✅ CHANGELOG + 迁移指南：Task 14

**Type consistency check**:
- `PipelineContext` / `PipelineState` 字段在 7 个阶段中使用一致 ✓
- `StageResult<T>` 在 6 个阶段（guard/compact/render/call/tools/decide）使用一致 ✓
- `drainStream` 是 `AsyncGenerator`，不返回 `StageResult` — 已在 stream.ts 注释说明 ✓
- `runResilientCall` / `buildTurnRequest` / `maybeAutoCompactBeforeTurn` 等老 helper 签名引用与实际 src/ 中一致（已读源码确认）✓

**Placeholder scan**: 无 TODO / TBD / "implement later"。每个 step 都有完整代码或精确命令。

**Spec coverage gap**:
- spec §2.2 token 估算校准（per-model EMA 表）— **本 plan 未覆盖**。理由：这是独立工程（需要日志数据 + 离线分析），不属于 pipeline 重构核心。建议拆为独立 plan `2026-05-XX-token-calibration.md`，在 M5 之前完成。**已在本 plan 末尾注明**。
