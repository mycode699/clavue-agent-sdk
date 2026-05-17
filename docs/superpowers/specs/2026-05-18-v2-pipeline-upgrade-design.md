---
title: clavue-agent-sdk v2.0 — engine pipeline + handoff DSL + eval harness 升级方案
date: 2026-05-18
status: approved
baseline:
  version: 1.0.6
  tests: 728/728
  build: tsc 0 error
  engine_loc: 1069 / 1100 SLO
  src_total_loc: 27722
  schema_versions: 7 (independent)
direction: 技术深度（同层最强 TS agent SDK）
release_strategy: v2.0 大重构（动公开 schema，保留 1 个 minor 兼容层）
estimated_effort: 12 周（单人全职）/ 6 周（双人配合）
---

# clavue-agent-sdk v2.0 升级方案

## 0. 为什么是现在

1.0.6 已经把 v2 audit 的 ~85% ROI 关掉，v3 七轴全部 shipped，bench:engine
SLO 已强制。这是**最后一次**可以做大重构的窗口——再往下任何 patch 都会
让公开 schema 钉得更死。

12 周战役解决三个根因：

- **R1**: `engine.ts` 还没真正 pipeline 化（M2 重构从 v2_audit 拖了 6 个月）
- **R2**: Multi-agent handoff DSL 是同层全员有、clavue 唯一缺的能力
- **R3**: Eval harness 缺位，回归无 baseline，improvement loop 无证据

## 1. 总体架构（v2.0 目标态）

```
┌─────────────────────────────────────────────────────────────┐
│  Public API (vendor-neutral)                                 │
│  src/index.ts (target < 400 LoC, currently 979)              │
│  src/agent.ts (split into 4 files, currently 791)            │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│  Engine pipeline (NEW — 7 stages, each independently         │
│  testable, traceable, replaceable)                           │
│                                                              │
│   ┌──────┐  ┌────────┐  ┌──────┐  ┌────┐                    │
│   │Guard │→ │Compact │→ │Render│→ │Call│ ┐                  │
│   └──────┘  └────────┘  └──────┘  └────┘ │                  │
│                                          ↓                   │
│   ┌──────┐  ┌─────┐  ┌────────┐         │                  │
│   │Decide│← │Tools│← │ Stream │←────────┘                  │
│   └──────┘  └─────┘  └────────┘                             │
│      ↻ next turn                                             │
│                                                              │
│  src/engine.ts (target < 400 LoC, currently 1069)            │
│  src/engine/pipeline/{guard,compact,render,call,             │
│                       stream,tools,decide}.ts                │
└──────────────────────────┬──────────────────────────────────┘
                           │
┌──────────────────────────┴──────────────────────────────────┐
│  Capability axes (extend pipeline via hooks, NOT inline)     │
│                                                              │
│  src/handoff/        ← NEW (M2)                              │
│  src/sandbox/        ← strengthened (M3, currently 276 LoC)  │
│  src/evals/          ← NEW (M4)                              │
│  src/graph/  src/guardrails/  src/tracing/  src/rag/         │
│  src/genui/  src/voice/  src/runtime/  src/memory/           │
└──────────────────────────────────────────────────────────────┘
```

## 2. M1 — Engine pipeline 七阶段重构（Week 1-3）

### 2.1 设计

每个阶段是一个**纯函数 + 输入输出契约**，不持有状态：

```typescript
// src/engine/pipeline/types.ts
export interface PipelineContext {
  readonly turnIndex: number;
  readonly runId: string;
  readonly options: ResolvedAgentOptions;
  readonly trace: TraceCollector;
  // 阶段间传递的可变快照
  state: PipelineState;
}

export type PipelineStage<In, Out> = (
  ctx: PipelineContext,
  input: In
) => Promise<Out>;
```

七阶段契约：

| 阶段 | 输入 | 输出 | 文件 | 目标 LoC |
|---|---|---|---|---|
| Guard | `RawTurnRequest` | `GuardedTurnRequest \| Denied` | `pipeline/guard.ts` | < 200 |
| Compact | `GuardedTurnRequest` | `CompactedRequest` | `pipeline/compact.ts` | < 200 |
| Render | `CompactedRequest` | `RenderedRequest` | `pipeline/render.ts` | < 200 |
| Call | `RenderedRequest` | `ProviderResponse` | `pipeline/call.ts` | < 200 |
| Stream | `ProviderResponse` | `NormalizedResponse` | `pipeline/stream.ts` | < 150 |
| Tools | `NormalizedResponse` | `ToolDispatchResult` | `pipeline/tools.ts` | < 200 |
| Decide | `ToolDispatchResult` | `'continue' \| 'stop' \| 'compact_retry'` | `pipeline/decide.ts` | < 150 |

`engine.ts` 缩到 ~400 行，只负责：编排、错误传播、trace 聚合、turn loop。

### 2.2 Token 估算校准

- 用 1.0.5 起累积的真实 `input_tokens` / `output_tokens` 数据做 EMA
- `AUTOCOMPACT_BUFFER_FRACTION = 0.08` → 改成 per-model 表，from `src/providers/capabilities.ts`
- `tokens.ts` 增加 `calibrate(model, observed)` 公开函数，host 可注入实测数据

### 2.3 Schema 演化

- `AGENT_RUN_TRACE_SCHEMA_VERSION` 1.0.0 → 2.0.0
- trace 新增 `pipeline_stages: Record<StageName, { duration_ms, status }>`
- 旧字段保留 alias 1 个 minor

### 2.4 SLO 调整

`bench:engine`：
- engine.ts LoC: 1100 → **500**
- 新增 `pipeline/*.ts` 各 < 200 LoC
- 新增 wall-time SLO per stage: < 50ms (excluding provider call)

### 2.5 验收

- [ ] `engine.ts` < 400 LoC
- [ ] 七阶段每个有 ≥ 5 个独立单元测试
- [ ] 728 测试全部通过 + 新增至少 35 个 pipeline 测试
- [ ] `npm run bench:engine` 通过新 SLO
- [ ] CHANGELOG 标注 schema bump + 迁移指南草稿

## 3. M4 (并行) — Eval harness 骨架（Week 1-3）

### 3.1 为什么提前

M1 重构需要 baseline 做回归。eval 数字是最硬的 baseline。
否则 M1 完成后只能说"测试通过"，不能说"性能/质量没退步"。

### 3.2 骨架设计

```
src/evals/
├── runner.ts          # 通用 harness — runEval(suite, agent, options)
├── types.ts           # Suite, Task, Result, Score
├── adapters/
│   ├── builtin.ts     # 自建 ~30 task 集（Week 1-3 只做这个）
│   ├── swe-bench.ts   # SWE-bench Lite (Week 8-9)
│   └── tau-bench.ts   # τ-bench retail (Week 8-9)
├── scorers/
│   ├── exact-match.ts
│   ├── llm-judge.ts
│   └── code-execution.ts
└── reports/
    └── markdown.ts    # 出 docs/benchmarks/<date>.md
```

### 3.3 自建 task 集（Week 1-3 唯一交付）

至少 30 个 task，覆盖：
- 工具调用（10）：file read/edit, shell, grep, MCP
- 多轮对话（5）：状态保持
- 计划执行（5）：plan → solve → verify
- 错误恢复（5）：rate limit / timeout / 不可用 model
- Memory（3）：结构化记忆写入与召回
- Workflow contract（2）：parse / render / validate

### 3.4 验收（Week 3）

- [ ] `npm run eval:builtin` 跑通 30 task
- [ ] 出 `docs/benchmarks/2026-05-W3-baseline.md`，记录 1.0.6 baseline
- [ ] M1 重构完成后再跑一次，新报告 vs baseline，证明无回归

## 4. M2 — Handoff DSL 一等公民（Week 4-5）

### 4.1 API

```typescript
// 用户可见 API
const billing = createAgent({
  name: 'billing',
  model: 'claude-3-5-sonnet',
  systemPrompt: '...',
});

const triage = createAgent({
  name: 'triage',
  handoffs: [billing, tech, escalate],
  handoffPolicy: {
    mode: 'auto',           // 'auto' | 'explicit' | 'guided'
    maxDepth: 3,
    onHandoff: (from, to, ctx) => { /* hook */ },
  },
});

await triage.run({ message: '我的账单有问题' });
// → 自动 handoff 到 billing agent
```

### 4.2 实现

- `src/handoff/runtime.ts`：handoff 决策 + 执行
- `src/handoff/policy.ts`：3 种 mode 实现
- 与 engine 集成点：**Decide 阶段** hook（不进 engine.ts 热路径）
- 与 graph 整合：handoff 节点是 graph 节点的特化

### 4.3 公开类型

```typescript
export interface HandoffPolicy {
  mode: 'auto' | 'explicit' | 'guided';
  maxDepth?: number;        // 默认 3，防止环
  onHandoff?: HandoffHook;
}

export interface HandoffEvent {
  from: string;
  to: string;
  reason: string;
  turnIndex: number;
}

// 新增 SDK event kind: 'handoff_decided' | 'handoff_completed'
// SDK_EVENT_SCHEMA_VERSION bump
```

### 4.4 验收

- [ ] `examples/33-multi-agent-handoff.ts` 跑通三 agent 客服 triage
- [ ] benchmark：3-agent triage vs AgentTool 实现，token 节省 ≥ 15%，延迟 ≤ -10%
- [ ] 至少 8 个 handoff 单元测试（3 mode × auto/manual + 环检测 + maxDepth）

## 5. M3 — 真 sandbox（Week 6-7）

### 5.1 现状

- `src/runtime/worker-thread-*.ts`：worker_thread 隔离已有底子
- `src/sandbox/`：276 LoC 的 capability token 设计已有
- 缺：网络隔离、文件系统沙箱、资源限额、崩溃恢复

### 5.2 公开 API

**OS 支持**: macOS + Linux only。Windows 上 `runInSandbox` 接口存在但运行时抛
`AgentError({ kind: 'sandbox_violation', message: 'sandbox not supported on win32' })`。
不在 v2.0 范围内补 Windows 支持。

```typescript
import { runInSandbox } from 'clavue-agent-sdk/sandbox';

const result = await runInSandbox(async () => {
  // 不可信代码
}, {
  network: 'deny',           // 'deny' | 'allow' | { allowlist: string[] }
  filesystem: {
    read: ['/tmp/safe'],
    write: ['/tmp/safe/out'],
  },
  resources: {
    cpuTimeMs: 5000,
    memoryMb: 128,
    wallClockMs: 10000,
  },
  onViolation: 'kill',       // 'kill' | 'throw' | 'warn'
});
```

### 5.3 验收

- [ ] 3 个 example：计算密集 / 不可信代码 / 资源受限
- [ ] sandbox 违规日志进 trace（新 TraceEvent kind: `sandbox_violation`）
- [ ] benchmark：sandbox 启动开销 < 200ms (p95)
- [ ] worker 死掉 host 不崩（fault injection 测试）

## 6. M4 续 — Eval harness 数据扩充（Week 8-9）

### 6.1 新增

- SWE-bench Lite 子集（30 个 issue）
- τ-bench retail 子集（airline 太复杂，先 retail）
- LLM-as-judge scorer（用 GPT-4o 当 judge）

### 6.2 与 retro 整合

```
失败 case → retro 评估 → 失败模式聚类 → 写入 docs/benchmarks/failure-modes.md
成功 case → improvement memory 候选 → 后续运行命中率统计
```

### 6.3 验收

- [ ] `npm run eval:swe-bench-lite` 给出通过率
- [ ] `npm run eval:tau-bench` 给出 retail 子集成绩
- [ ] `docs/benchmarks/v2-vs-v1.md` 对比表
- [ ] retro/improvement loop 闭环：连续 3 次跑 builtin task 集，命中率单调上升

## 7. M5 — 生产化补完（Week 10）

### 7.1 Error taxonomy

```typescript
export type AgentErrorKind =
  | 'auth'
  | 'rate_limit'
  | 'overload'
  | 'timeout'
  | 'prompt_too_long'
  | 'content_filter'
  | 'model_unsupported'
  | 'provider_conversion'
  | 'sandbox_violation'
  | 'tool_denied'
  | 'unknown';

export class AgentError extends Error {
  readonly kind: AgentErrorKind;
  readonly retriable: boolean;
  readonly cause?: unknown;
}
```

所有 provider 错误 → 归一化到 `AgentError`。retry / fallback 逻辑基于 `retriable` + `kind`。

### 7.2 Provider 健康度

```typescript
provider.health(): Promise<{
  p50_ms: number;
  p95_ms: number;
  error_rate: number;
  last_failure?: { at: Date; kind: AgentErrorKind };
}>
```

### 7.3 Tool 安全注解

```typescript
export interface ToolSafetyAnnotations {
  readonly readonly: boolean;
  readonly write: boolean;
  readonly shell: boolean;
  readonly network: boolean;
  readonly destructive: boolean;
  readonly idempotent: boolean;
  readonly approval_required: boolean;
}
```

引擎默认对 `destructive: true` 的 tool 在 `permissionMode: 'read-only'` 下拒绝。

### 7.4 默认 permission mode 收紧

`createAgent({ ... })` 不传 `permissionMode` 时：
- 1.x: `'auto'`
- 2.0: `'read-only'`（breaking）

迁移：兼容层在 v1-compat 中保留旧默认行为。

## 8. M6 — v2.0 收尾（Week 11-12）

### 8.1 兼容层

```
src/v1-compat/
├── trace-shim.ts           # 老 schema 字段 → 新 schema 字段
├── permission-default.ts   # 'auto' default 保留
├── error-shim.ts           # 老 Error 形状 → AgentError
└── README.md
```

保留 1 个 minor（v2.1 时移除）。

### 8.2 文档

- `docs/v1_to_v2_pipeline_migration.md`（新）
- `README.md` 重写，从 88KB → ~30KB
  - Hero: 15 秒 demo
  - 5 分钟入门
  - 能力矩阵（vs openai-agents-py / Mastra）
  - 进阶：subpath / handoff / sandbox / eval
- `docs/benchmarks/v2.0-final.md` 全量基线

### 8.3 发布

- v2.0.0-rc.0 → npm dist-tag `next`
- 1 周收 host feedback
- v2.0.0 GA + Twitter/HackerNews 发声（虽然目标是技术深度，但 v2 切版必须发声）

## 9. 公开 Schema 影响清单

**Breaking（需要兼容层）**：
- `AGENT_RUN_TRACE_SCHEMA_VERSION` 1.0.0 → 2.0.0（新增 pipeline_stages）
- `SDK_EVENT_SCHEMA_VERSION` bump（新增 handoff_decided/completed）
- `permissionMode` 默认值 `'auto'` → `'read-only'`
- `Error` 类 → `AgentError` 类（保留 instanceof 兼容）

**Additive（无需兼容层）**：
- `AgentOptions.handoffs`, `handoffPolicy`
- `AgentOptions.sandbox`
- `runInSandbox()` API
- `npm run eval:*` 脚本
- `provider.health()` 方法（providers/types.ts 中 optional）

## 10. 风险与回滚

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| M1 pipeline 拆分破坏 728 测试中的边界 case | 中 | 高 | M4 eval baseline 提前 + 测试覆盖率必达 90%+ |
| handoff DSL 与 graph 整合不优雅 | 中 | 中 | RFC 先行，至少出 2 个 example 验证 |
| sandbox 在不同 OS 行为差异 | 中 | 中 | 仅实现 macOS + Linux；Windows 上 `runInSandbox` 接口存在但运行时抛 `'sandbox not supported on win32'`，文档明说 |
| eval harness 数据集体积进 npm | 低 | 高 | 数据集放独立 repo，runner 通过 fetch 拉取 |
| schema bump 让下游 host 痛苦 | 高 | 高 | 兼容层 + 1 minor deprecation + 详细 migration guide |
| 12 周战役延期 | 高 | 中 | 每 milestone 独立可发布；M1 是唯一不可拆的 |

**回滚预案**：v2.0.0-rc 阶段如果 host 反馈 schema 迁移痛苦超预期，分两条线发布：
- v1.1.x：仅 additive（handoff / sandbox / eval），不动 schema
- v2.0.x：完整 pipeline 重构，承认是 ecosystem upgrade

## 11. 不在本次范围

明确写出来防止 scope creep：

- ❌ RAG 深度（Mastra 标配，但同层 parity 等下次）
- ❌ Voice realtime / Deepgram Live
- ❌ Generative UI 深度（已有 250 LoC 够用）
- ❌ Tracing dashboard UI（OTel 兼容已够，UI 是 v4 平台层的事）
- ❌ clavue-orchestrator / clavue-studio（v4 平台化）
- ❌ README 翻译 / Discord / Show HN（运营战线，非本次）

## 12. 验收总闸

v2.0 GA 必须同时满足：

1. `npm run test` 全绿（≥ 800 个测试）
2. `npm run build` tsc 0 error
3. `npm run bench:engine` 通过新 SLO（engine.ts < 500）
4. `npm run bench` 全部基线通过
5. `npm run eval:builtin` 通过率 ≥ 95%
6. `npm run eval:swe-bench-lite` 通过率公开（不限定阈值，但必须有数字）
7. CHANGELOG 完整 + migration guide 完整
8. 至少 1 个外部 host 试用 v2.0-rc 并 sign off

## 13. 实施顺序（强制）

```
Week 1-3:  M1 pipeline + M4 eval 骨架（并行）
Week 4-5:  M2 handoff DSL
Week 6-7:  M3 sandbox
Week 8-9:  M4 eval 数据扩充
Week 10:   M5 生产化
Week 11-12: M6 v2.0 收尾 + GA
```

**M1 是地基，绝不允许在 M1 完成前启动 M2/M3**。
M4 骨架与 M1 并行是为了锁 baseline，不是分散精力。

---

## 附录 A — 当前 codebase 评分（5 视角）

| 维度 | 分数 | 一句话 |
|---|---|---|
| 架构 | 8.0 | 干净但 engine.ts 还在裸奔 |
| 产品 | 7.0 | 有护城河没有故事 |
| 研究/eval | 7.5 | 工具齐全没有 loop 闭环证据 |
| 运营/增长 | 5.5 | silent ship，本次不处理 |
| 工程 | 8.5 | 工匠级纪律，缺 CI |

加权综合 7.3 / 10 → v2.0 目标 8.5 / 10（运营维度本次不动）。

## 附录 B — 当前 baseline 数据（2026-05-18）

```
Version:        1.0.6
src/ files:     165
src/ LoC:       27,722
tests:          75 files / 728 cases
examples:       32
subpath:        13
engine.ts:      1,069 / 1,100 SLO
agent.ts:       791
index.ts:       979
v3 axes total:  ~7,800 LoC
```
