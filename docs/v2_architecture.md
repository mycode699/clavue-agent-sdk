# Clavue Agent SDK — v2 架构设计

> **状态**: Draft for review
> **配套文档**: [v2_audit_report.md](./v2_audit_report.md) · [v2_roadmap.md](./v2_roadmap.md)
> **核心立场**: 不再"加功能"，把 agent loop 拆成可独立测、可独立换、可独立观测的管道。

---

## 设计原则（按优先级）

1. **正确性 > 性能 > 人体工程 > 表面功能数**
   - "30+ tools" 不是卖点。"每个 tool 在 abort/permission/retry 边界上行为可证" 才是。
2. **流式优先 (Streaming-First)**
   - 所有 provider 接口默认流式，非流式是 streaming 的 collect()。
   - 首 token 延迟 (TTFT) 是 SLO 指标。
3. **管道而非过程**
   - 一切线性流程拆为 stage。stage 可单独 mock、可插中间件、可旁路。
4. **契约稳定 > 实现自由**
   - schema_version 是合同。公开类型加 `@stable` 注释；标 `@experimental` 的可改。
5. **零依赖默认**
   - tiktoken / embedding / OTel 均为 optional peer，缺失时 SDK 仍跑（降级为字符估算 / keyword search / no-op tracer）。
6. **小核心 + 显式扩展**
   - `clavue-agent-sdk/core` ≤ 3000 LoC。其余进 `/tools`、`/workflow`、`/retro` 子包。

---

## 顶层架构（C4 Container 视角）

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          Host Application                               │
│  (Web service / CI runner / CLI / IDE extension)                        │
└────────────────────────────┬────────────────────────────────────────────┘
                             │
                ┌────────────▼─────────────┐
                │     Public API           │
                │  Agent / run / query     │
                │  defineTool / Skill      │
                └────────────┬─────────────┘
                             │
   ┌─────────────────────────▼──────────────────────────────────────────┐
   │                  Agent Runtime (this SDK)                          │
   │                                                                    │
   │  ┌──────────┐  ┌────────────┐  ┌──────────┐  ┌─────────────────┐  │
   │  │ Sessions │  │ Middleware │  │  Hooks   │  │ Telemetry/OTel  │  │
   │  │ (resume) │  │ (use)      │  │ (events) │  │ (spans/metrics) │  │
   │  └──────────┘  └────────────┘  └──────────┘  └─────────────────┘  │
   │                                                                    │
   │  ┌────────────────────────────────────────────────────────────┐   │
   │  │              Turn Pipeline (per turn)                       │   │
   │  │  Guard → Compact → Render → Call → Stream → Tools → Decide  │   │
   │  └────────────────────────────────────────────────────────────┘   │
   │                                                                    │
   │  ┌──────────────┐  ┌─────────────┐  ┌────────────────────────┐   │
   │  │  Provider    │  │  ToolRouter │  │  WorkItem (issue/wf)   │   │
   │  │  (streaming, │  │  (concurrency│ │  (real LLM-driven loop │   │
   │  │   caching)   │  │   batcher)   │  │   with Agent)          │   │
   │  └──────────────┘  └─────────────┘  └────────────────────────┘   │
   └────────────────────────────────────────────────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
   ┌────────────┐      ┌──────────┐         ┌────────────┐
   │ Anthropic  │      │ OpenAI   │         │ MCP / SSE  │
   │ (caching)  │      │ (Resp.   │         │            │
   │            │      │  API)    │         │            │
   └────────────┘      └──────────┘         └────────────┘
```

---

## 核心重构 #1 — Turn Pipeline

### 现状 vs 目标

```
v1 (现状):
  QueryEngine.submitMessage  ←  260 行单方法、所有职责
v2 (目标):
  TurnPipeline               ←  60 行编排
  ├─ stage/Guard             ←  abort + budget check
  ├─ stage/Compact           ←  autoCompact + microCompact
  ├─ stage/Render            ←  buildSystemPrompt + memory inject
  ├─ stage/Call              ←  ResilientCall (retry+fallback+overflow)
  ├─ stage/Stream            ←  emit partial events
  ├─ stage/Tools             ←  ToolRouter（执行）
  └─ stage/Decide            ←  next turn / break / max_output recovery
```

### 接口

```ts
// src/core/pipeline/types.ts
export interface TurnContext {
  runId: string
  turn: number
  messages: NormalizedMessageParam[]
  systemPrompt: string
  tools: ToolDefinition[]
  policy: ToolPolicy
  abortSignal: AbortSignal
  // 各 stage 的产出累积在这里
  emit: (event: SDKMessage) => void
  trace: TraceCollector
}

export interface TurnStage {
  name: string
  run(ctx: TurnContext): Promise<TurnDecision>
}

export type TurnDecision =
  | { kind: 'continue' }      // 进入下一阶段
  | { kind: 'next_turn' }     // 直接进入下一轮
  | { kind: 'retry_turn' }    // 同一轮重做（compact 后）
  | { kind: 'finish'; result: AgentRunResult }
  | { kind: 'abort' }
```

### 关键收益

- **每个 stage 单测**: `await Compact.run(mockCtx)` 不需要真实 provider。
- **Stage 可替换**: 想换成"先编辑后回答"的非传统 loop？换 Pipeline 实例，stages 复用。
- **观测点天然**: 每个 stage 自动 emit `phase` 事件 + 占用一个 OTel span。

---

## 核心重构 #2 — Streaming-First Provider

```ts
// src/providers/types.ts (v2)
export interface LLMProvider {
  apiType: ApiType
  capabilities: ModelCapabilities

  /** 流式（默认主路径）。返回异步迭代 chunk 序列。 */
  stream(params: StreamParams): AsyncIterable<StreamChunk>

  /** 非流式：默认实现 = collect(stream())。Provider 想优化可重写。 */
  create(params: CreateParams): Promise<CreateMessageResponse>

  /** 离线 token 计数 (Anthropic 真实 / OpenAI tiktoken / fallback 估算) */
  countTokens?(params: CountTokensParams): Promise<{ input_tokens: number }>
}

export type StreamChunk =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_input_delta'; id: string; partial_json: string }
  | { type: 'tool_use_complete'; id: string; input: unknown }
  | { type: 'thinking_delta'; text: string }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'message_complete'; stopReason: string }
```

### Anthropic 实现要点

```ts
async *stream(params) {
  const stream = await this.client.messages.stream({
    ...params,
    system: this.applyCacheControl(params.system, params.tools),  // 关键
  })
  for await (const event of stream) {
    yield this.normalizeEvent(event)
  }
}

private applyCacheControl(system: string, tools: NormalizedTool[]) {
  // tools 数组末项 + system 末段 标记 cache_control: ephemeral
  // 自动管理 cache breakpoint（最多 4 个）
}
```

### OpenAI / Responses API 实现要点

- 优先使用 `/responses` 端点（如 capability gate 通过）
- 流式用 SSE
- thinking 模型把 reasoning 单独做成 `thinking_delta`

---

## 核心重构 #3 — 真实 Token 计数

```ts
// src/core/tokens/counter.ts
export interface TokenCounter {
  count(messages, model): Promise<number>
}

export function createTokenCounter(provider: LLMProvider): TokenCounter {
  if (provider.countTokens) {
    return new ApiBackedCounter(provider)  // Anthropic native
  }
  if (modelLooksLikeOpenAI(model)) {
    return new TiktokenCounter()  // optional peer dep
  }
  return new HeuristicCounter()  // 4-char fallback + 经验系数表
}
```

`HeuristicCounter` 维护一张运行时校准表：
```ts
// 启动时：用 response.usage.input_tokens 反推系数
calibration[model][contentType] = realTokens / charLen
```

每次 response 来都更新 EMA（exponential moving average）。第二次起估算误差 <5%。

---

## 核心重构 #4 — 真实 Issue Workflow

### 当前问题（详见审计 P0-1）

`runIssueWorkflow` 不调 LLM。

### v2 设计

```ts
// src/workflow/issue-workflow.ts (v2)
export interface RunIssueWorkflowV2Input {
  issue: IssueRecord
  agent: Agent | (() => Agent)        // 必填——真实 LLM
  workspace: { cwd: string; isolation?: 'worktree' | 'inplace' }
  verifier: Verifier                  // 必填——产 quality_gate
  policy?: WorkflowPolicy             // 可选——max iter, gate threshold
}

export interface Verifier {
  /** Builder 完成后跑：lint/test/typecheck，返回 quality_gates */
  verify(input: { cwd: string; changes: ChangeSet }): Promise<QualityGateResult[]>
}

export interface ChangeSet {
  files_changed: string[]
  diff_summary: string
}
```

### 默认 Verifier 实现

```ts
export class CommandVerifier implements Verifier {
  constructor(private commands: { name: string; cmd: string }[]) {}
  async verify({ cwd }) {
    return Promise.all(this.commands.map(async ({ name, cmd }) => {
      const { exitCode, stdout, stderr } = await exec(cmd, { cwd })
      return {
        name,
        status: exitCode === 0 ? 'passed' : 'failed',
        summary: exitCode === 0 ? stdout.slice(-500) : stderr.slice(-500),
      }
    }))
  }
}
```

### 真实闭环

```ts
async function runIssueWorkflow(input) {
  for (let iter = 1; iter <= maxIter; iter++) {
    // 1. Builder: 真实 LLM 改代码
    const buildRun = await input.agent.run(buildPrompt(issue, iter), {
      workflowMode: 'build',
      cwd: workspace.cwd,
    })

    // 2. Verifier: 跑 tests/lint
    const gates = await verifier.verify({ cwd, changes: extractChanges(buildRun) })
    const passing = allRequiredGatesPass(gates, requiredGates)

    if (passing) return { status: 'completed', proof_of_work: ... }

    // 3. Reviewer: 让 LLM 看 verifier 输出，决定 fix 策略
    const reviewRun = await input.agent.run(reviewPrompt(issue, gates, iter), {
      workflowMode: 'review',
    })

    // 4. Fixer: 下一轮 builder 把 review 反馈纳入
  }
}
```

---

## 核心重构 #5 — Middleware 层

```ts
// src/core/middleware.ts
export type Middleware = (ctx: TurnContext, next: () => Promise<void>) => Promise<void>

agent.use(rateLimit({ maxToolsPerSecond: 10 }))
agent.use(audit({ logger: console.log }))
agent.use(piiScrubber({ patterns: [/\b\d{3}-\d{2}-\d{4}\b/] }))
```

Middleware 在 Turn Pipeline 外包一层：

```
[mw1 [mw2 [Pipeline.run() ] mw2] mw1]
```

vs Hooks（事件订阅）：
- Hook = "告诉我发生了 X"
- Middleware = "我想包装 X 的执行"

两者并存。

---

## 核心重构 #6 — Subagent 隔离

```ts
export interface SubagentDefinition {
  name: string
  description: string
  systemPrompt: string
  toolset: ToolDefinition[] | { inherit: 'parent'; restrict?: string[] }
  budget?: { maxTurns?: number; maxUsd?: number }
  runtime?: 'inprocess' | 'worker_thread'   // worker_thread = 真隔离
}

// AgentTool 强制收窄：
tools = parent.tools.filter(t => subagent.toolset includes t.name)
// 默认 deny 比 parent 更危险的工具（safety.destructive=true）
```

worker_thread 模式：
- 用 Node `worker_threads` 启子线程
- IPC 通过 MessagePort 传 SDKMessage
- abort 通过 `worker.terminate()` 强制结束

---

## 核心重构 #7 — 子包导出（package.json#exports）

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./core": "./dist/core/index.js",
    "./tools": "./dist/tools/index.js",
    "./tools/file-io": "./dist/tools/file-io.js",
    "./tools/shell": "./dist/tools/shell.js",
    "./tools/web": "./dist/tools/web.js",
    "./contracts": "./dist/contracts/index.js",
    "./workflow": "./dist/workflow/index.js",
    "./retro": "./dist/retro/index.js",
    "./testing": "./dist/testing/index.js"
  }
}
```

下游：
```ts
import { run } from 'clavue-agent-sdk'
import { FileReadTool, BashTool } from 'clavue-agent-sdk/tools'
import type { AgentRunResult } from 'clavue-agent-sdk/contracts'
```

主入口仍向后兼容（re-export 子包），但鼓励新用户走子路径，启用更好的 tree-shaking。

---

## 核心重构 #8 — Telemetry 接口

```ts
// src/core/telemetry.ts
export interface Telemetry {
  startSpan(name: string, attrs?: Record<string, unknown>): Span
  recordMetric(name: string, value: number, attrs?: Record<string, unknown>): void
  log(level: 'debug' | 'info' | 'warn' | 'error', msg: string, fields?: object): void
}

// 默认 no-op；用户可以注入 OTel adapter:
import { OpenTelemetryAdapter } from 'clavue-agent-sdk/telemetry/otel'
agent.useTelemetry(new OpenTelemetryAdapter(otelTracer))
```

每个 stage、每个 tool、每个 provider call 自动开 span。

---

## 数据模型变化

### 新增类型（@stable）

```ts
// src/contracts/streaming.ts
export interface SDKPartialAssistantMessage {
  type: 'partial_assistant'
  content_type: 'text' | 'tool_input' | 'thinking'
  delta: string
}

// src/contracts/tool-router.ts
export interface ToolDispatchPlan {
  batches: Array<{ kind: 'parallel' | 'serial'; calls: ToolUseBlock[] }>
  reasoning?: string
}
```

### 演化的类型（@stable，schema_version 升级）

```
SDK_EVENT_SCHEMA_VERSION         '1.0.0' → '2.0.0'   新增 partial events
AGENT_RUN_RESULT_SCHEMA_VERSION  '1.0.0' → '2.0.0'   新增 first_token_ms 字段
AGENT_RUN_TRACE_SCHEMA_VERSION   '1.0.0' → '2.0.0'   stages 替代 turns 内嵌
```

### 弃用（保留兼容层）

- `AgentOptions.jsonSchema` → `AgentOptions.outputSchema`（且真实生效）
- `IssueWorkflowResult` 字段重排（schema bump）

---

## 验证策略

### 单元测试增量

```
tests/v2/
├── pipeline/
│   ├── guard.test.ts
│   ├── compact.test.ts
│   ├── render.test.ts
│   ├── call.test.ts
│   ├── stream.test.ts
│   ├── tools.test.ts
│   └── decide.test.ts
├── providers/
│   ├── streaming-anthropic.test.ts
│   ├── streaming-openai.test.ts
│   └── caching-anthropic.test.ts
├── workflow/
│   ├── issue-workflow-real.test.ts   ← 用 mock Agent + verifier
│   └── workflow-policy.test.ts
└── tokens/
    ├── api-counter.test.ts
    └── heuristic-counter.test.ts
```

### Benchmark 套件

每个 PR 跑 `npm run bench`：

```
metric                  v1 baseline   v2 target
TTFT (p50)              ~3000ms       <500ms
Multi-turn cost (10t)   1.0×          <0.30×    (caching)
Compact accuracy        ±35%          ±5%
Engine LoC (hot path)   1537          <500
Tool dispatch latency   varies        <2ms      (router overhead)
```

### 兼容性测试

`tests/compat/v1-v2.test.ts`：
- 用 v1 公开 API 写一组场景
- 在 v2 上跑，断言行为相同（除非显式列入 breaking changes）

---

## 不在 v2 范围内（明确划界）

- 多模态生成（图像/音频）：等 provider 普及
- 分布式 Agent（跨进程协调）：宿主自己用 Redis/queue
- GUI 调试器：另起项目
- 商业 hosted 后端：开源不做

---

## 失败回退

如果某项重构在实施时遇到不可绕过的阻力：

| 重构 | 失败回退 |
|---|---|
| Streaming | 保留非流式 `create()`，缓存功能仍能落地 |
| Caching | Capability gate 关闭，无功能损失 |
| Pipeline | 保留 v1 engine 作为 `engine.legacy.ts`，新引擎 opt-in |
| Workflow real loop | 标记 v1 的 `runIssueWorkflow` 为 `@deprecated` 但不删 |
| Subpath exports | 子包导出是纯增量，主入口不变 |

每一项都有 escape hatch。

---

## 下一步：实施计划见 [v2_roadmap.md](./v2_roadmap.md)
