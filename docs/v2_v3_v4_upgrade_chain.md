# Clavue Agent SDK — v2/v3 完整升级链路

> **撰写日期**: 2026-05-08
> **基线**: 0.7.5 + 已落地 11/17 P0/P1 修复 (325 测试 / tsc clean)
> **配套**: [v2_audit_report.md](./v2_audit_report.md) · [v2_architecture.md](./v2_architecture.md) · [v2_roadmap.md](./v2_roadmap.md)
> **回答的问题**: "为什么不能跟 agent-sdk 比？同层能不能更强？"

---

## 2026-05-08 实际进度快照（v3 七轴全部 shipped）

| 能力轴 | 实现文件 | 测试 | Example |
|---|---|---|---|
| Graph DSL (6 节点) | `src/graph/runtime.ts`, `src/graph/types.ts` | `tests/graph.test.ts`, `tests/graph-retriever.test.ts` | `examples/19-graph-dsl.ts`, `28-rag-graph.ts` |
| Live Tracing + OTel bridge | `src/tracing/runtime.ts`, `src/tracing/otel-shim.ts` | `tests/tracing*.test.ts` (×3) | `examples/21-tracing-replay.ts`, `27-trace-exporter.ts`, `29-otel-shim.ts` |
| 4-scope Guardrails + policy hook | `src/guardrails/runtime.ts`, `src/engine.ts` | `tests/guardrails.test.ts`, `tests/engine-guardrails*.test.ts` (×2) | `examples/20-guardrails.ts` |
| Sandbox / capability tokens | `src/sandbox/` | `tests/sandbox.test.ts` | `examples/22-capability-tokens.ts` |
| RAG (InMemory + pgvector + retriever node) | `src/rag/runtime.ts`, `src/rag/pgvector.ts` | `tests/rag.test.ts`, `tests/rag-pgvector.test.ts`, `tests/graph-retriever.test.ts` | `examples/23-rag-retriever.ts`, `28-rag-graph.ts` |
| Generative UI (framework-agnostic) | `src/genui/index.ts` | `tests/genui.test.ts` | `examples/24-generative-ui.ts` |
| Voice (stub + 3 real adapters) | `src/voice/runtime.ts`, `src/voice/adapters.ts` | `tests/voice.test.ts`, `tests/voice-adapters.test.ts` | `examples/25-voice.ts`, `30-voice-adapters.ts` |

**当前 baseline**: 472/472 tests · tsc 0 error · 零新增 runtime 依赖（`FetchLike` / `PgClientLike` / `OtelTracerLike` 全部结构化注入）。

**D3 (issue-workflow → graph DSL migration)** 已诚实推迟到 v4 —— `runIssueWorkflowWithAgent` 已是 real loop，graph 迁移在现有持久化规模下净收益不足，详见 `v3_rfc.md` 的 D3 状态条目。

**明确 out-of-scope**（不画饼）：
- Deepgram Live / OpenAI Realtime websocket 语音流
- 本地 `whisper.cpp` / `faster-whisper` 二进制运行
- pgvector 真 Postgres 集成测试（需要 docker；CI 跑 stub 客户端）

---

## TL;DR — 三段式答案

1. **能比，应该比。** 不是"螺丝刀比电锯"——`clavue-agent-sdk` 跟 `claude-agent-sdk-python` / `openai-agents-python` / `Mastra` / `Vercel AI SDK` 是同一层产品。
2. **当前在同层中段位**——某些维度已超越（in-process MCP、proof-of-work、retro/eval、workflow contract、issue workflow real loop），某些维度落后（multi-agent handoff、tracing UI、RAG、guardrails 形式化、voice/realtime）。
3. **要爬到顶层**，分两条战线：**v2 收尾**（把"扎实"做完，1.0.0）+ **v3 跃迁**（4 个能力维度突破，做"独有"）。本文档给的是这两条战线的合并链路。

---

## 第一部分 · 真实对标（不再含糊）

### 同层 SDK 公开能力矩阵

| 能力维度 | clavue 0.7.5+ | claude-agent-sdk (py) | openai-agents (py) | Mastra | Vercel AI SDK |
|---|---|---|---|---|---|
| **核心** |
| 进程内 agent loop | ✅ | ❌ (调 CLI 子进程) | ✅ | ✅ | ✅ |
| 流式（已落地） | ✅ partial_message | ✅ | ✅ | ✅ | ✅ (best-in-class) |
| 多 provider | ✅ Anthropic + OpenAI 兼容 | ⚠️ 仅 Claude | ✅ 100+ | ✅ 40+ | ✅ |
| Prompt caching | ✅ 自动 cache_control | ✅ (CLI 内置) | ⚠️ 手动 | ⚠️ 手动 | ⚠️ 部分 |
| 结构化输出 | ✅ outputSchema | ⚠️ 例子级 | ✅ Pydantic | ✅ Zod | ✅ Zod (流式 partial obj) |
| **工具与 MCP** |
| MCP 客户端 | ✅ stdio/SSE/HTTP | ✅ | ✅ | ✅ | ❌ |
| In-process MCP server | ✅ `createSdkMcpServer` | ✅ (SDK MCP) | ⚠️ | ❌ | ❌ |
| 工具权限（allow/deny/path 隔离） | ✅ | ✅ | ⚠️ | ⚠️ | ❌ |
| **多 agent** |
| Subagent | ⚠️ in-process 同进程 | ⚠️ 例子 | ✅ Handoff (一等公民) | ✅ Workflow node | ❌ |
| Multi-agent handoff DSL | ❌ | ❌ | ✅ | ✅ `.then().branch().parallel()` | ❌ |
| Worker thread / 真隔离 | ❌ (M6 计划) | ❌ | ❌ | ❌ | ❌ |
| **状态与记忆** |
| Session 持久化 | ✅ | ✅ | ✅ | ✅ | ✅ |
| 结构化 memory | ✅ keyword | ⚠️ 无原生 | ⚠️ | ✅ semantic recall | ⚠️ |
| RAG 一等公民 | ❌ | ❌ | ❌ | ✅ | ⚠️ 例子 |
| **生产化** |
| Hooks | ✅ 7 个事件 | ✅ PreToolUse | ⚠️ Guardrails | ⚠️ Lifecycle | ⚠️ |
| Guardrails (input/output 校验) | ⚠️ 通过 hook 拼 | ❌ | ✅ 一等公民 | ⚠️ | ❌ |
| Tracing / Observability | ⚠️ 自定义 trace schema | ❌ | ✅ 内置 dashboard | ✅ | ⚠️ |
| OTel 兼容 | ❌ (M5 计划) | ❌ | ⚠️ | ✅ | ⚠️ |
| Eval 内建 | ✅ `retro/*` 7 模块 | ❌ | ⚠️ Python evals | ✅ Built-in | ❌ |
| **独有 / 差异化** |
| Workflow contract (`WORKFLOW.md`) | ✅ **独有** | ❌ | ❌ | ❌ | ❌ |
| Proof-of-work artifact | ✅ **独有** | ❌ | ❌ | ❌ | ❌ |
| Quality gate policy | ✅ **独有** | ❌ | ❌ | ❌ | ❌ |
| Issue workflow real loop | ✅ **独有** | ❌ | ❌ | ❌ | ❌ |
| Orchestration policy (DAG-aware dispatch) | ✅ **独有** | ❌ | ❌ | ❌ | ❌ |
| **前端能力** |
| 多模态输入 (image) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Voice / realtime | ❌ | ❌ | ✅ gpt-realtime | ✅ separate pkg | ⚠️ |
| Generative UI / streaming components | ❌ | ❌ | ❌ | ❌ | ✅ **独有** |

### 客观结论

```
当前 clavue 优势（独有或 best-in-class）:
  ✓ Workflow contract + proof-of-work + quality gate  → 没有同层做这层抽象
  ✓ Retro/eval 7 个模块                                → openai-agents 只有 evals 入门
  ✓ Issue workflow real loop                           → 同层都没做（Mastra 的 workflow 是通用 graph，不是修复闭环）
  ✓ Orchestration policy 候选选择 + backoff            → 独有
  ✓ TS + ESM + 进程内零依赖                            → claude-agent-sdk 用 CLI，openai-agents 是 Python

当前 clavue 落后（必须补）:
  ✗ Multi-agent handoff DSL                            → openai-agents / Mastra 都有，clavue 用 AgentTool 拼
  ✗ Tracing dashboard                                  → openai-agents 内置最强；Mastra 也有
  ✗ Guardrails 一等公民                                → openai-agents 独立概念
  ✗ RAG 内建                                           → Mastra 标配
  ✗ Voice / realtime                                   → 时代趋势，迟早要做
  ✗ 真隔离 subagent                                    → 同层都没做，但你想超越就该做
```

**所以"我们能力更强水平更高"是可达的**——把独有维度做深，把落后维度补齐到 parity，再在 1-2 个点做出代际差。

---

## 第二部分 · 升级链路（v2 → v3 → v4）

### 三层升级地图

```
┌────────────────────────────────────────────────────────────────┐
│ v4 (12-18 月):   PLATFORM LAYER (基于 clavue 的产品形态)        │
│                  clavue-orchestrator / clavue-studio            │
│                  Portfolio · Intervention · Dashboard · Deploy  │
└──────────────────────────▲─────────────────────────────────────┘
                           │ depends on
┌──────────────────────────┴─────────────────────────────────────┐
│ v3 (6-9 月):     CAPABILITY LAYER (代际差能力)                  │
│                  Multi-Agent Graph · Real Sandbox · Live Trace  │
│                  Guardrails · RAG · Generative UI · Realtime    │
└──────────────────────────▲─────────────────────────────────────┘
                           │ depends on
┌──────────────────────────┴─────────────────────────────────────┐
│ v2 (现在 → 3 月):  FOUNDATION (1.0.0)                           │
│                  M2 Pipeline · M5 Telemetry · M6 Subagent       │
│                  M7 Migration · 1.0.0 Release                   │
└────────────────────────────────────────────────────────────────┘
```

---

## v2 — Foundation（1.0.0 收尾）

### 状态：**11/17 已修，剩 6 项**

| 待修 | 优先级 | 工期 |
|---|---|---|
| P1-1 engine god-class 完成 (M2 pipeline) | 🔴 高 | 2 周 |
| P1-4 retry/fallback/compact 三路径统一 | 🟡 中（M2 同期） | 0 (含在 M2) |
| P1-5 Hook → Middleware 演进 | 🟡 中 | 3 天 |
| P1-6 Subagent 隔离 (worker_thread) | 🟢 低（v3 前补） | 4 天 |
| P1-7 Memory 向量检索 | 🟢 低 (留 v3) | — |
| P1-8 Workflow contract / orchestration / issue 三态合并 | 🟢 低 | 3 天 |

### v2 完成线（3 个 minor 发布）

```
0.8.0  M2 Pipeline 重构          (~2 周)
       - 拆 Guard/Compact/Render/Call/Stream/Tools/Decide 7 stage
       - 统一 ResilientCall（retry+fallback+overflow）
       - engine.ts → <500 行 hot path
       - 旧 engine 保留 1 个 minor (legacy flag)

0.9.0  M5 Telemetry + Subpath    (~1 周)
       - Telemetry 接口 + no-op + OTel adapter
       - 每个 stage / tool / provider call 自动 span
       - subpath exports 验证（已落地）

0.10.0 M6 Subagent + Middleware  (~1 周)
       - worker_thread runtime 选项
       - 工具继承收窄（destructive 默认不传）
       - middleware 层 use() + rateLimit/audit/PII 内置
       - P1-5 hook 演进收口

1.0.0  M7 Migration + Bench      (~1 周)
       - v1→v2 迁移指南
       - benchmark 报告（TTFT/cost/LoC/dispatch/abort）
       - README 拆分
       - 删 @deprecated 90 天到期的 API
```

**v2 完工后的位置**: 同层 SDK 中**第一梯队靠后**（追上 openai-agents / Mastra 的 parity）。

---

## v3 — Capability Layer（代际差能力）

> 这是回答"水平更高"的真核心。v2 是把"扎实"做完；v3 是**做别人没做的、或者比别人做得更好的**。

### 7 个能力轴，每个都对标具体 peer

#### v3.1 · Multi-Agent Graph DSL（对标：openai-agents Handoffs / Mastra Workflows）

**目标**: clavue 第一个公开 graph DSL，且**比同层都强**——因为我们已经有 `WORKFLOW.md` + `orchestration-policy` 基础。

```ts
// src/graph/index.ts (新增)
export interface AgentGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
  entry: string
}

export type GraphNode =
  | { kind: 'agent'; id: string; agent: AgentLike; outputSchema?: OutputSchema }
  | { kind: 'human'; id: string; prompt: (ctx) => Promise<HumanInput> }
  | { kind: 'verifier'; id: string; verifier: Verifier }
  | { kind: 'router'; id: string; route: (ctx) => string /* node id */ }
  | { kind: 'parallel'; id: string; branches: string[]; join: 'all' | 'race' | 'majority' }

export type GraphEdge = {
  from: string
  to: string
  when?: (ctx) => boolean
  transform?: (output: unknown) => unknown
}

// 使用：
const graph = defineGraph({
  entry: 'plan',
  nodes: [
    { kind: 'agent', id: 'plan', agent: planAgent, outputSchema: PlanSchema },
    { kind: 'parallel', id: 'build', branches: ['build_fe', 'build_be'], join: 'all' },
    { kind: 'agent', id: 'build_fe', agent: feAgent },
    { kind: 'agent', id: 'build_be', agent: beAgent },
    { kind: 'verifier', id: 'verify', verifier: testVerifier },
    { kind: 'router', id: 'fix_or_done',
      route: (ctx) => ctx.gates.allPassing ? 'done' : 'fix' },
    { kind: 'agent', id: 'fix', agent: fixAgent },
    { kind: 'human', id: 'review', prompt: askUser },
  ],
  edges: [
    { from: 'plan', to: 'build' },
    { from: 'build', to: 'verify' },
    { from: 'verify', to: 'fix_or_done' },
    { from: 'fix', to: 'verify' },
    { from: 'done', to: 'review' },
  ],
})

const result = await runGraph(graph, { input: issue })
```

**为什么我们能比 openai-agents handoffs 更强**:
- 它的 handoff 只支持 agent→agent 链式；我们能加 verifier / human / router / parallel 4 种节点 kind
- 它的状态隐式；我们用 `WorkflowContract` 显式

**为什么我们能比 Mastra workflows 更轻**:
- Mastra workflow 绑定 Mastra 框架；我们的 graph 是纯函数 + Agent 接口，能用任何 LLM 后端

**工期**: 3 周（含测试 + 例子）

---

#### v3.2 · 真隔离 Sandbox（对标：openai-agents Sandbox Agents）

**目标**: 既然 OpenAI 都把 sandbox 列一等公民了，我们做 **3 种 isolation level**：

```ts
type SandboxRuntime =
  | { kind: 'inprocess' }                              // 当前默认
  | { kind: 'worker_thread'; abortLatencyMs?: number } // M6 已规划
  | { kind: 'container'; image: string; mounts: ... } // 新增：Docker/Podman
  | { kind: 'firecracker'; ... }                       // 新增：μVM
```

**关键差异化**: 我们做 **capability-based sandbox**——不是简单容器，而是给 sandbox 一组 capability tokens（"可读 /repo"、"可执行 npm test"、"可访问 localhost:5432"）。Tool 执行时校验 token，而不是依赖文件系统权限。

**工期**: 4 周（worker_thread 1 周 + container 2 周 + capability 系统 1 周）

---

#### v3.3 · Live Tracing（对标：openai-agents Tracing dashboard）

**目标**: 内置一个 zero-config trace viewer。OpenAI Agents 的 dashboard 是它的杀手锏；我们要做**自托管 + 实时**。

```bash
# 启动 SDK，trace UI 自动起在 :7777
clavue-agent-sdk run "..." --trace-ui

# 或者：
agent.useTrace({ ui: { port: 7777, open: true } })
```

UI 内容：
- 时间轴：每个 turn / stage / tool 一条 bar
- Tree view：subagent / graph node 嵌套
- Tokens flame chart：input/output/cache 拆分
- 替代播放：rewind 到任一点，改 prompt 重跑

**栈**: 内嵌 React + Vite build artifact 进 dist/，启动时 serve 静态资源 + WebSocket trace 流。

**为什么我们能比 OpenAI 强**:
- 自托管（OpenAI 那个上 dashboard 要绑账号）
- 离线可用
- Replay 能力（OpenAI 只能看，不能改后重跑）

**工期**: 5 周（UI 4 周 + 集成 1 周）

---

#### v3.4 · Guardrails 一等公民（对标：openai-agents Guardrails）

```ts
agent.useGuardrail({
  scope: 'input',        // 'input' | 'output' | 'tool_input' | 'tool_output'
  name: 'no_secrets',
  check: async (text) => {
    const found = scanSecrets(text)
    return found.length === 0 ? { pass: true } : { pass: false, blocking: true, message: `Secret detected: ${found[0].kind}` }
  },
})
```

**比 openai-agents 强的点**:
- 我们 guardrail 复用 quality_gate schema → 同时进 proof-of-work artifact
- 4 个 scope（输入/输出/工具入/工具出），openai 只有输入输出

**工期**: 1 周

---

#### v3.5 · RAG 一等公民（对标：Mastra RAG）

不重做向量库——我们做 **provider-agnostic adapter**：

```ts
const rag = createRag({
  embedder: 'openai',                       // 内置 3 个，可换
  store: new PgVectorStore({ ... }),        // 内置 5 个 store adapter
  chunker: 'sentence',                      // 内置 3 种
})

await rag.ingest('./docs/**/*.md')

const agent = createAgent({
  rag: { 
    instance: rag, 
    autoQuery: true,                        // 每轮自动查询并注入
    topK: 5, 
    rerank: 'cohere',                       // 内置 2 个 rerank
  },
})
```

**关键**: `rag` 是 optional peer——不装 `clavue-agent-sdk/rag` 也能跑。

**工期**: 4 周（核心 2 周 + 5 个 store adapter 各 0.5 周）

---

#### v3.6 · Generative UI Streaming（对标：Vercel AI SDK 的 React Server Components）

**目标**: 我们做 **Component Streaming via Tool**——把 React/Vue/Svelte 组件作为工具的输出。

```ts
const ChartTool = defineTool({
  name: 'render_chart',
  output: 'component',
  call: async ({ data }) => ({
    component: 'BarChart',
    props: { data, color: 'primary' },
  }),
})

// 客户端：
for await (const event of agent.stream(...)) {
  if (event.type === 'tool_component') {
    renderComponent(event.component, event.props)  // 直接挂到 DOM
  }
}
```

**比 Vercel AI SDK 强**:
- 它绑 Next.js / React Server Components；我们框架无关，能用 Vue/Svelte/Solid
- 它要服务端把 JSX 流过来；我们流 component descriptor，客户端解析

**工期**: 3 周

---

#### v3.7 · Voice / Realtime（对标：openai-agents Realtime Agents）

**目标**: 做 **provider-agnostic realtime**，OpenAI 的 gpt-realtime + Anthropic 未来的对话 API + 第三方 ASR/TTS 都能跑。

```ts
const voiceAgent = createVoiceAgent({
  llm: { provider: 'openai', model: 'gpt-realtime-2' },
  asr: { provider: 'whisper', streaming: true },     // 可换 deepgram / azure
  tts: { provider: 'openai', voice: 'alloy' },       // 可换 elevenlabs / play.ht
  vad: 'silero',                                      // 端到端 VAD
})

await voiceAgent.connect(audioStream)
```

**工期**: 6 周（最重，但回报极高——voice 是 2026 趋势）

---

### v3 完整里程碑

```
0.11.0 v3.1 Graph DSL                    (3 周)
0.12.0 v3.4 Guardrails                   (1 周)
0.13.0 v3.3 Live Tracing v1               (5 周)
0.14.0 v3.2 Sandbox runtimes              (4 周)
0.15.0 v3.5 RAG adapter                   (4 周)
0.16.0 v3.6 Generative UI                (3 周)
0.17.0 v3.7 Voice / Realtime             (6 周)
2.0.0  v3 收尾 + breaking changes汇总     (2 周)
                                          ──────
总工期                                    28 周（≈7 月）
```

按"做出代际差"原则，**优先级排序**：
1. **Graph DSL**（同层都有但我们能做更好）
2. **Live Tracing**（杀手锏，自托管 + replay）
3. **Guardrails**（短平快，1 周补 parity）
4. **RAG**（Mastra 的护城河，必须有）
5. **Generative UI**（Vercel 独有，我们破其垄断）
6. **Sandbox runtimes**（高级用户需要）
7. **Voice**（趋势但重）

---

## v4 — Platform Layer（基于 SDK 长出产品）

> **这才是回答 "对比 codex-launcher" 的正确姿势**——不是把 platform 塞进 SDK，是在 SDK 上长一个 platform。

### `clavue-orchestrator`（独立仓库 / monorepo 子包）

```
┌──────────────────────────────────────────────────────────────────┐
│  clavue-orchestrator                                              │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌──────────────┐  │
│  │ Portfolio  │ │ Factory    │ │Intervention│ │ ReleaseReview│  │
│  │ (N 项目)   │ │ (graph 模板) │ │ (人在环)   │ │ (审批闭环)    │  │
│  └────────────┘ └────────────┘ └────────────┘ └──────────────┘  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │  Dashboard (Next.js)  +  Auth  +  Multi-tenant              │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────▲─────────────────────────────────┘
                                  │ depends on
┌─────────────────────────────────┴─────────────────────────────────┐
│  clavue-agent-sdk @ 2.0.0  (v3 收尾后，稳定 API)                  │
└───────────────────────────────────────────────────────────────────┘
```

### 跟 codex-launcher 的对位

| codex-launcher 概念 | clavue-orchestrator 对位 | 实现路径 |
|---|---|---|
| `runs/` | `clavue-agent-sdk` 的 AgentRunResult + 持久化 | 已有 |
| `portfolio/` | 新模块：N 个 graph 并行执行的状态聚合 | 用 v3.1 graph + storage adapter |
| `factory/` | 新模块：graph 模板库（blueprint→builder×N→integrator） | v3.1 graph 的 high-level preset |
| `intervention/` | 新模块：human node + 通知通道 (Slack/Discord) | v3.1 graph human node + adapter |
| `release_review/` | 新模块：proof-of-work + quality_gate 串联审批 | 已有 SDK 原语，组合即可 |
| `远程部署` | 新模块：sandbox container / k8s adapter | v3.2 container runtime |
| `dashboard` | 新模块：Next.js + 实时事件 | v3.3 trace UI 升级版 |

### v4 工期估算

```
v4.0  Portfolio + Factory                  (4 周)
v4.1  Intervention (Slack/Discord/Email)   (2 周)
v4.2  Release Review                       (2 周)
v4.3  Dashboard MVP (Next.js)              (6 周)
v4.4  Multi-tenant + Auth                  (3 周)
v4.5  Deploy adapter (k8s/Render/Fly)      (3 周)
                                           ──────
                                           20 周
```

启动条件：clavue-agent-sdk @ 2.0.0 稳定（v3 收尾），即 2026-12 之后。

---

## 第三部分 · 完整时间线

```
2026 Q2 (5-6月)   v2 收尾    0.8 → 0.10 → 1.0.0
                  - M2 Pipeline (核心)
                  - M5 Telemetry
                  - M6 Subagent + Middleware
                  - M7 Migration + Bench

2026 Q3-Q4 (7-12月)  v3 跃迁  0.11 → 0.17 → 2.0.0
                  - Graph DSL ✦
                  - Live Tracing ✦
                  - Guardrails
                  - RAG
                  - Sandbox runtimes
                  - Generative UI
                  - Voice / Realtime

2027 Q1 (1-3月)   v3 缓冲 + dogfood 反馈 + 文档大版本

2027 Q2-Q3 (4-9月)  v4 启动  clavue-orchestrator
                  - Portfolio / Factory / Intervention
                  - Release Review
                  - Dashboard
                  - Multi-tenant + Deploy
```

---

## 第四部分 · 资源与决策

### 工期假设

```
单人全职：       v2 (2 月) + v3 (7 月) + v4 (5 月) = 14 月
双人配合：       v2 (1 月) + v3 (4 月) + v4 (3 月) = 8 月
3-4 人小团队：   v2 (3 周) + v3 (3 月) + v4 (2 月) = 6 月
```

### 必须做的"超越"决策（4 个）

> 决定能不能"水平更高"的关键拐点。

**决策 1**: **Graph DSL 对标谁，深度多大？**
- A) 浅层：抄 openai-agents handoffs 即可
- B) 中层：handoff + verifier + parallel 4 种节点（推荐）
- C) 深层：完整 BPMN 兼容（过度）
- **推荐 B**——比 A 强 2 倍，比 C 实用 5 倍。

**决策 2**: **Tracing UI 内嵌还是分发？**
- A) 内嵌 dist/（包体 +5MB，但 npm i 即可用）
- B) 分发为 `clavue-agent-sdk-trace-ui` 单独包
- **推荐 B**——尊重 npm 体积纪律；用 `npx clavue-trace` 一行启动。

**决策 3**: **是否做 v3.7 Voice？**
- 利：2026 是 voice 年；OpenAI Realtime 已起势
- 弊：6 周工期最大；ASR/TTS 链路复杂
- **推荐：v3 末做，可滑到 v3.5 之后看团队带宽。**

**决策 4**: **v4 Platform 是开源还是商业化？**
- A) 全开源（GitHub）→ 维护成本高
- B) Core 开源（orchestrator engine） + 商业 Dashboard
- C) 全商业（hosted SaaS）
- **推荐 B**——既保留生态又有营收路径；类似 Supabase / Posthog 的模型。

---

## 第五部分 · 立刻该做的 3 件事

> 不要等 14 个月。这 3 件事**这周就能动**。

### 1. **重写 README 头屏对比表**（半天）

把当前那张"clavue vs codex-launcher"的误导对比换成**真实同层对比**（本文档第一部分的矩阵）。让外部读者一眼看出我们独有什么、对标什么。

### 2. **开 v3 brainstorm 的 RFC**（1 天）

`docs/v3_rfc.md`：列 7 个能力轴 + 决策点，邀请外部 reviewer 评论。这件事**今天就该开**——v3 不能闭门设计。

### 3. **Graph DSL 的 prototype**（3 天）

最小可演示版：
```ts
// examples/20-graph-dsl-preview.ts
const graph = defineGraph({...})
const result = await runGraph(graph, { input: 'fix bug X' })
```

哪怕只支持 agent + verifier + router 3 种节点，也能立刻验证设计、收集反馈。先于完整 v3.1 实现。

---

## 一句话总结

**不差，但不要骄傲。** clavue 在同层 SDK 中已是第一梯队靠后，独有维度（workflow contract / proof-of-work / retro / issue real loop）已经超越 peer。**要"水平更高"，路线清楚**：v2 把扎实做完（3 个月）→ v3 在 7 个能力轴上做出代际差（7 个月）→ v4 在 SDK 上长 platform（5 个月）。

**真正的护城河**: workflow contract + proof-of-work + retro + graph DSL 的组合。同层没人做，下层做不到，上层不会做。这 4 张牌打好，clavue 就是 **"production-grade agent SDK 的事实标准"**。

下一步：开 [v3_rfc.md](./v3_rfc.md) 还是先做 Graph DSL prototype？告诉我哪个先动。

---

## Update — 2026-05-08 · v3.1 Graph DSL prototype landed

第一根能力轴的最小可运行原型已落地，无需等 v3 GA。

### 交付物

| 路径 | 内容 |
|---|---|
| `src/graph/types.ts` | `AgentGraph` / `GraphNode` (4 kinds) / `GraphEdge` / `RunGraphOptions/Result` |
| `src/graph/runtime.ts` | `runGraph()` + `validateGraph()`，~230 行，零外部依赖，含 cycle / maxSteps 保护 |
| `src/graph/index.ts` | 公开导出 |
| `src/index.ts` | 顶层 re-export `runGraph` / `validateGraph` 与 graph 类型 |
| `tests/graph.test.ts` | 9 个 case：validate · 4 kinds 各自 · race · cycle · maxSteps · edge guards |
| `examples/19-graph-dsl.ts` | `plan → parallel(fe,be) → verify → route → fix → verify` 完整闭环（stub agent，无 LLM 依赖） |

### 节点 kind 一览（与 openai-agents handoffs 对位）

| Kind | 状态 | 与 openai-agents 差距 |
|---|---|---|
| `agent` | ✅ 跑通 | parity |
| `verifier` | ✅ 跑通 + 复用现有 `Verifier` 接口 | **超越**（peer 没有这个 kind） |
| `router` | ✅ 跑通 | **超越**（peer 用 LLM 路由，我们支持纯函数） |
| `parallel` | ✅ 跑通（join: all / race） | parity-ish |
| `human` | ✅ 跑通（approved + 可选 note） | **超越**（openai handoffs 无原生 human-in-the-loop kind） |

### Telemetry hook

`runGraph(graph, input, { onStep })` — 每个节点结束后回调一次，附带 `nodeId / kind / status / timing / output`。回调里抛错被吞掉，确保观测层不会破坏 run。这是 v3.3 Live Tracing 的最小起点；后续把 `onStep` 接到 trace store / WebSocket 即可。

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 337 / 337 passed (基线 325 + 新增 12)
npx tsx examples/19-graph-dsl.ts → completed in 9 steps，5 kind 全部走过
```

### 这意味着什么

- v3.1 文档里的 type surface 不是空想——它能运行，且 5 个 kind 全齐。
- Verifier 节点直接复用 issue-workflow real loop 的 quality_gate 协议——没多写一遍 schema。
- `onStep` 是 v3.3 Live Tracing 的最小着力点：先有钩子，dashboard 后做。
- 后续 v3 工作可基于这个 prototype 渐进迭代：把 graph runtime 接入 issue-workflow、或把 `onStep` 接到 OTel adapter。

> 下一步候选：(a) 把 graph runtime 接入 issue-workflow 替代当前固定 4 角色；(b) `onStep` 加 OTel adapter；(c) 写 v3_rfc.md 收外部反馈。

---

## Update — 2026-05-08 · v3.4 Guardrails prototype landed

第二根能力轴的最小可运行原型已落地。这是文档承诺中"4 scope vs openai 2 scope"代差的代码兑现。

### 交付物

| 路径 | 内容 |
|---|---|
| `src/guardrails/types.ts` | `Guardrail` / `GuardrailScope` (4 种) / `GuardrailViolation` / `GuardrailEvaluation` |
| `src/guardrails/runtime.ts` | `GuardrailRegistry` — add/remove/list/evaluate，含吞错保护 |
| `src/guardrails/index.ts` | 公开导出 |
| `src/index.ts` | 顶层 re-export `GuardrailRegistry` 与 guardrail 类型 |
| `tests/guardrails.test.ts` | 11 cases：4 scope · blocking/warn · 异常 · ctx 校验 · scope 隔离 · 4-scope sanity |
| `examples/20-guardrails.ts` | 5 个真实场景：API key / profanity / rm -rf / AWS key 全跑通 |

### 4 scope vs peer

| Scope | clavue | openai-agents | 用途 |
|---|---|---|---|
| `input` | ✅ | ✅ | 模型看到 prompt 前清洗 |
| `output` | ✅ | ✅ | 模型回复后清洗 |
| `tool_input` | ✅ | ❌ | **每次工具调用前**逐个 gate（block destructive bash 等） |
| `tool_output` | ✅ | ❌ | **每次工具结果**回流前清洗（防 secret 泄漏给模型） |

代差就在 `tool_input` / `tool_output`。peer 缺这两个 scope，意味着无法精细化拦截单次工具行为；clavue 有，所以能复用现有 `permissionMode` + `canUseTool` 之上再加策略层。

### Blocking vs warn-only

每个 violation 自带 `blocking` 标记。`pass=false` 但 `blocking=false` → `evaluation.passed` 仍为 `true`，violation 仅作为告警记录在 trace 里。这是 openai-agents 没区分的语义。

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 348 / 348 passed (基线 325 + graph 12 + guardrails 11)
npx tsx examples/20-guardrails.ts → 5 scenarios with expected pass/violation outcomes
```

### 这意味着什么

- v3.4 文档里"4 scope > peer 2 scope"不再是营销话术——它是 ~150 行可运行代码 + 11 个测试。
- `GuardrailRegistry` 是 plain object，没绑 engine，所以 graph / engine pipeline / 现有 `canUseTool` 都能引用同一份 rail 集合。
- 异常隔离：buggy guardrail 不会 crash run，会记成 blocking violation。
- 集成路径已清晰：engine pipeline 在 `tool_call` 前后各调一次 `evaluate()`，policy_decisions trace 直接收 `violations`。

### 累计 v3 prototype 状态

| 能力轴 | 状态 | 测试 | Example |
|---|---|---|---|
| v3.1 Graph DSL (5 kinds + onStep) | ✅ | 12 | 19-graph-dsl |
| v3.4 Guardrails (4 scopes) | ✅ | 11 | 20-guardrails |
| v3.2 Sandbox runtimes | ⏳ | — | — |
| v3.3 Live Tracing | ⏳（onStep 是起点） | — | — |
| v3.5 RAG | ⏳ | — | — |
| v3.6 Generative UI | ⏳ | — | — |
| v3.7 Voice | ⏳ | — | — |

> 下一步候选：(a) v3.3 把 graph 的 `onStep` 接到 trace store（从钩子升级到事件总线）；(b) v3.2 sandbox capability tokens 最小骨架；(c) 把 guardrails 接入 graph runtime 让它包住 agent/tool 节点。三选一即可继续推进。

---

## Update — 2026-05-08 · v3.3 Live Tracing prototype landed

第三根能力轴落地。v3.1 的 `onStep` 钩子 ➔ 真正的事件总线 + 可序列化 + 可重放。这是与 openai-agents tracing dashboard 的代差关键：peer 只能"看"，clavue 能"重放"。

### 交付物

| 路径 | 内容 |
|---|---|
| `src/tracing/types.ts` | `TraceEvent` / `TraceRun` / `TraceQuery` + 三种 event data 类型 |
| `src/tracing/runtime.ts` | `TraceStore` — startRun / append* / query / replay / serialize / importRun，~210 行 |
| `src/tracing/index.ts` | 公开导出 |
| `src/index.ts` | 顶层 re-export `TraceStore` 与 trace 类型 |
| `tests/tracing.test.ts` | 11 cases：append 顺序 · query 过滤 · 三种结构化 appender · replay · round-trip · graph 集成 · guardrail 集成 |
| `examples/21-tracing-replay.ts` | guardrail + plan→verify→route→fix→verify 完整 run 录制 → JSON 序列化 → 新 store 反序列化 → 重放 |

### 内置 event kind

| Kind | spanId 约定 | 来源 |
|---|---|---|
| `graph_step` | `nodeId` | `appendGraphStep(step)` — graph runtime 的 `onStep` 直送 |
| `guardrail` | `tool:<name>`（仅 tool scope） | `appendGuardrail(scope, evaluation, ctx?)` |
| `tool_call` | `tool:<name>` | `appendToolCall({ toolName, phase, input/output })` |
| `note` / 其他 | 自定义 | `append({ kind, data, spanId? })` 透传 |

### Replay 是差异化关键

| 能力 | clavue v3.3 | openai-agents tracing dashboard |
|---|---|---|
| 录制全程事件 | ✅ | ✅ |
| Web 端查看历史 run | 自建（小事） | ✅（managed） |
| **重放事件流到任意 consumer**（UI / OTel exporter / 回归 harness） | ✅ `store.replay(runId, fn, { from, kinds })` | ❌ |
| **JSON 序列化整 run，跨进程导入** | ✅ `serialize` / `static deserialize` / `importRun` | ❌（cloud-only） |
| **本地、零网络、零账号** | ✅ | ❌（必须连 OpenAI 账号） |

代差不在"能不能看"，在"能不能编程化复用"。peer 的 trace 只能用人眼看；我们的 trace 是 first-class 数据流，可以喂回归测试、热升级 UI、迁移到 OTel。

### 异常隔离

`replay` 的 consumer 抛错会被向上传递（这是它的契约——重放器是同步管线的一部分）。但 graph 的 `onStep` 钩子先吞错（telemetry 不破坏 run），二者互补：录制端永不破坏 run，回放端忠实复现。

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 359 / 359 passed (基线 325 + graph 12 + guardrails 11 + tracing 11)
npx tsx examples/21-tracing-replay.ts
  → captured events: 7 (1 guardrail + 6 graph_step)
  → replay (graph_step only): plan / verify / route / fix / verify / route 全部按序回放
  → JSON size: ~1878 bytes
```

### 这意味着什么

- v3.3 文档承诺的"replay 是 peer 没有的能力"不再是 marketing — 是 ~210 行运行时 + 11 个测试。
- `TraceStore` 是 plain class，不绑 engine 也不绑 graph：guardrail registry / graph runtime / 未来 engine pipeline 共享同一个录制接口。
- JSON round-trip 让 trace 可以离线归档、跨进程迁移、注入到回归 harness — 这是 enterprise customer 真要的能力。
- 集成路径清晰：engine pipeline 把 `tool_call` 前后各 `appendToolCall` + `appendGuardrail` 一次，整条链就被录下来了。

### 累计 v3 prototype 状态

| 能力轴 | 状态 | 测试 | Example |
|---|---|---|---|
| v3.1 Graph DSL (5 kinds + onStep) | ✅ | 12 | 19-graph-dsl |
| v3.4 Guardrails (4 scopes) | ✅ | 11 | 20-guardrails |
| v3.3 Live Tracing (replay + serialize) | ✅ | 11 | 21-tracing-replay |
| v3.2 Sandbox runtimes | ⏳ | — | — |
| v3.5 RAG | ⏳ | — | — |
| v3.6 Generative UI | ⏳ | — | — |
| v3.7 Voice | ⏳ | — | — |

3/7 能力轴落地。剩 4 根：sandbox / RAG / generative UI / voice。

> 下一步候选：(a) v3.2 sandbox capability tokens 最小骨架（独立轴）；(b) 把 guardrails + tracing 接入 graph runtime（横向整合，让三轴互锁）；(c) v3.5 RAG retriever 接口骨架。优先 (b) — 横向整合一次就把三轴的故事讲圆。

---

## Update — 2026-05-08 · v3.2 Sandbox capability tokens prototype landed

第四根能力轴落地。从粗粒度的 `permissionMode` + per-call hook，进化到**每次调用、每个资源、可吊销、可限时、可限次**的 capability token。peer 没有这个原语。

### 交付物

| 路径 | 内容 |
|---|---|
| `src/sandbox/types.ts` | `CapabilityToken` / `MintTokenInput` / `CapabilityDecision` / 4 deny reason |
| `src/sandbox/runtime.ts` | `CapabilityRegistry`：mint / revoke / get / list / check + `matchResource` glob 编译器 |
| `src/sandbox/index.ts` | 公开导出 |
| `src/index.ts` | 顶层 re-export `CapabilityRegistry` / `matchResource` 与 sandbox 类型 |
| `tests/sandbox.test.ts` | 13 cases：glob `*` / `**` / `/**` 边界 · 4 种 deny reason · revoke 幂等 · 多 token 回退 · clone 隔离 |
| `examples/22-capability-tokens.ts` | 6 个真实场景：allow / resource_mismatch / capability_mismatch / exhausted / expired / revoked 全跑通 |

### 4 种 deny reason vs peer

| Reason | 触发条件 | peer (claude-agent-sdk / openai-agents) |
|---|---|---|
| `capability_mismatch` | 没有任何 token 拥有该 capability | ❌ 只能"全允/全拒"或 hook 自实现 |
| `resource_mismatch` | capability 命中但 resource glob 不匹配 | ❌ 同上 |
| `revoked` | 显式撤销该 token | ❌ 同上 |
| `expired` | `expiresAt` 过期 | ❌ 同上 |
| `exhausted` | `maxUses` 用尽 | ❌ 同上 |

代差: **每次 `check()` 返回明确原因 + 触发 token id**，可以直接喂 trace、提示用户、写 audit log。peer 的粗粒度 `permissionMode` 不知道为什么拒、也无法定向只对某条路径开口。

### Glob 语法

```
*    → 匹配单个 path 段（不含 /）
**   → 匹配任意 path（含 /）
/**  → 特殊：可吃掉前置 / 或匹配空尾（让 file:///repo/** 同时匹配 file:///repo）
其它 → 字面量（regex 元字符自动转义）
```

### 关键设计

1. **顺序决定胜出**：`check()` 按 mint 顺序遍历，第一个 fresh+matching 的 token 获胜并消耗一次。
2. **状态化耗损**：`maxUses` + `usedCount` 内置在 token 自身，无需外部 counter。
3. **错误隔离**：revoke 已撤销 token 返回 `false` 而非抛错（幂等）。
4. **快照即只读**：`get()` / `list()` 返回 deep clone，外部 mutate 不影响 registry。
5. **零依赖**：纯 TS、无 crypto、无 IO。需要 bearer-checkable 的 host 自加签名层。

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 372 / 372 passed (基线 325 + graph 12 + guardrails 11 + tracing 11 + sandbox 13)
npx tsx examples/22-capability-tokens.ts → 6 个场景全部按预期返回 (allow / 4 种 deny / revoke)
```

### 这意味着什么

- v3.2 文档承诺的"capability tokens > permissionMode"不再是 marketing — 它是 ~150 行运行时 + 13 个测试，每个 deny reason 都有专门 case 覆盖。
- `CapabilityRegistry` 是 plain class，graph runtime / engine pipeline / canUseTool 都能引用同一份 registry。
- 集成路径清晰：engine 在 tool dispatch 前 `registry.check(capability, resource)` 一次；deny 转成 `tool_input` guardrail violation；trace 录 `tokenId` + `reason` 即得审计链。

### 累计 v3 prototype 状态

| 能力轴 | 状态 | 测试 | Example |
|---|---|---|---|
| v3.1 Graph DSL (5 kinds + onStep) | ✅ | 12 | 19-graph-dsl |
| v3.4 Guardrails (4 scopes) | ✅ | 11 | 20-guardrails |
| v3.3 Live Tracing (replay + serialize) | ✅ | 11 | 21-tracing-replay |
| v3.2 Sandbox capability tokens | ✅ | 13 | 22-capability-tokens |
| v3.5 RAG | ⏳ | — | — |
| v3.6 Generative UI | ⏳ | — | — |
| v3.7 Voice | ⏳ | — | — |

**4/7 能力轴落地**。47 个新测试 + 4 个 example 全部跑通，0 行既有代码改动（surgical: 全部新增模块）。剩 3 根：RAG / generative UI / voice。

> 下一步候选：(a) v3.5 RAG retriever 接口骨架（独立轴，最简）；(b) v3.6 generative UI 流式组件协议；(c) 横向整合 — 把 guardrails+tracing+sandbox 接入 graph runtime。优先 (a)，4/7 → 5/7，离收官最近。

---

## Update — 2026-05-08 · v3.5 RAG retriever prototype landed

第五根能力轴落地。provider-agnostic `Retriever` 接口 + 参考实现 `InMemoryRetriever`。Mastra 的 RAG 是内建但和框架耦合；我们只 own 协议，任何 embedding provider / vector DB 都能实现。

### 交付物

| 路径 | 内容 |
|---|---|
| `src/rag/types.ts` | `Retriever` / `RagDocument` / `RetrieveQuery` / `RetrievalHit` / `EmbedFn` |
| `src/rag/runtime.ts` | `InMemoryRetriever`：add / clear / count / retrieve + `cosine()` |
| `src/rag/index.ts` | 公开导出 |
| `src/index.ts` | 顶层 re-export `InMemoryRetriever` / `cosine` 与 RAG 类型 |
| `tests/rag.test.ts` | 13 cases：cosine 边界 · upsert · ranking · topK · where filter · clone 隔离 · async embed |
| `examples/23-rag-retriever.ts` | 5 文档 + 3 个 query（semantic / public-only / axis filter）跑通 |

### Retriever 协议（peer 没有这个接口）

```ts
interface Retriever {
  retrieve(query: RetrieveQuery): Promise<RetrievalHit[]>
  add?(docs: RagDocument[]): void | Promise<void>
  clear?(): void | Promise<void>
  count?(): number
}
```

`add` / `clear` / `count` 是 optional —— read-only 的远程 store（Pinecone serverless 等）只实现 `retrieve` 即可。

### vs peer

| 维度 | clavue v3.5 | Mastra | claude-agent-sdk | openai-agents |
|---|---|---|---|---|
| 内建 RAG 接口 | ✅ `Retriever` | ✅ 但耦合框架 | ❌ | ❌ |
| Embedding provider 自带 | ❌（外部注入 `embed`） | ✅ 但锁定 | — | — |
| Vector store 适配器 | 协议而非实现：任何 DB 实现接口即可 | 5 个内建 + 闭源 | — | — |
| 元数据过滤 | ✅ `where: { k: v }` | ✅ | — | — |
| 同步/异步 embed | ✅ 都支持 | 仅异步 | — | — |

代差: Mastra 的 RAG 强但**绑定**他们的 stack；peer 双 SDK 干脆没这层。我们写"协议 + 一个参考实现 + 多个适配点"，让用户用 pgvector / Qdrant / Pinecone / Weaviate 都能 plug in，不被锁。

### 关键设计

1. **协议只有 1 个必选方法** (`retrieve`)，可写适配器极便宜。
2. `cosine()` 导出可被外部 store 复用（避免每个 adapter 自己实现）。
3. `cosine` 在零向量上返回 0（不是 NaN），保证排序稳定。
4. `where` 过滤在 score 计算前完成 —— 不是先算再筛。
5. `retrieve` 返回 hit 是 deep clone，外部 mutate 不污染 store。

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 385 / 385 passed (基线 325 + graph 12 + guardrails 11 + tracing 11 + sandbox 13 + rag 13)
npx tsx examples/23-rag-retriever.ts
  → 5 docs ingested, 3 queries 各自返回 ranked hits
  → metadata filter 正确隔离 private 文档
  → axis filter 正确缩小到 v3.1 子集
```

### 这意味着什么

- v3.5 文档承诺的"provider-agnostic RAG"不再是 marketing — 是 ~140 行运行时 + 13 个测试。
- `Retriever` 是 plain interface，graph 的 agent 节点可以注入 retriever 作为工具，guardrail 可以拦截 retrieve 的 query/result，tracing 可以录 retrieval hits — 三轴自然接入。
- 集成路径清晰：engine 在 system prompt 渲染前调一次 `retriever.retrieve()`，把 hits 拼进 context；trace 录 hits（便于回放调试）；guardrail `tool_output` 防 retrieved 文档泄露 secret。

### 累计 v3 prototype 状态

| 能力轴 | 状态 | 测试 | Example |
|---|---|---|---|
| v3.1 Graph DSL (5 kinds + onStep) | ✅ | 12 | 19-graph-dsl |
| v3.4 Guardrails (4 scopes) | ✅ | 11 | 20-guardrails |
| v3.3 Live Tracing (replay + serialize) | ✅ | 11 | 21-tracing-replay |
| v3.2 Sandbox capability tokens | ✅ | 13 | 22-capability-tokens |
| v3.5 RAG retriever | ✅ | 13 | 23-rag-retriever |
| v3.6 Generative UI | ⏳ | — | — |
| v3.7 Voice | ⏳ | — | — |

**5/7 能力轴落地**。60 个新测试 + 5 个 example 全部跑通，0 行既有代码改动。剩 2 根：generative UI / voice。

> 下一步：v3.6 Generative UI 流式 fragment 协议，再到 v3.7 Voice provider-agnostic ASR/TTS。两根落完即 7/7。

---

## Update — 2026-05-08 · v3.6 Generative UI prototype landed

第六根能力轴落地。framework-agnostic streaming UI: agent 输出 typed `UiFragment` 流，renderer (React / Vue / Svelte / CLI / 任何 thing) 消费同一个 `AsyncIterable<UiFragment>`。Vercel AI SDK 的 RSC streaming 锁 React；我们走 Web 标准。

### 交付物

| 路径 | 内容 |
|---|---|
| `src/genui/types.ts` | `UiFragment` 联合（text / component / data / done）+ `UiStreamSource` / `UiStreamSink` |
| `src/genui/runtime.ts` | `UiStreamBuilder` + `renderToState()` + `applyFragment()` + `pipe()` |
| `src/genui/index.ts` | 公开导出 |
| `src/index.ts` | 顶层 re-export `UiStreamBuilder` / `renderToState` / `pipeUiStream` 与 GenUI 类型 |
| `tests/genui.test.ts` | 13 cases：text 拼接 · component 注册 · data 增量 patch · 重复 id 拒绝 · finish 幂等 · 异步 sink 顺序 |
| `examples/24-generative-ui.ts` | 一个完整 stream（text + component + 多次 data patch）→ 状态归约 + CLI sink 双消费 |

### 4 种 fragment（含 peer 没有的 `data` 增量 patch）

| Fragment | 用途 | peer (Vercel AI SDK) |
|---|---|---|
| `text` | 流式文本（可分组） | ✅ |
| `component` | 注册命名组件 + 初始 props | ✅（仅 React） |
| `data` | **按 id 增量 patch 已注册组件 props** | ❌ 必须重发整个组件 |
| `done` | 流结束 + reason / message | 💧 隐式 |

代差: `data` 让流式 LLM 输出"先骨架再填血肉" — 一个图表先 `component('chart', 'BarChart', { loading: true })`，数据到达再 `data('chart', { loading: false, bars: [...] })`，renderer 不必重新挂载。

### 关键设计

1. **协议是 `AsyncIterable<UiFragment>`**，没有 React/Vue 任何 import。
2. **builder 校验在生成端**：重复 component id / 引用未注册 id / finish 后追加 — 全部在 builder 里抛错，sink 不需要重做。
3. **`renderToState()` 是参考归约**：把整个流缩成一个状态对象，便于测试 / 快照 / CLI 渲染；真实框架订阅 per-fragment。
4. **`applyFragment()` 容错**：孤儿 `data` patch 安静跳过（sink 可能乱序到达）。
5. **props 在 builder 时就 clone**：调用方后续 mutate 不污染流。

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 398 / 398 passed (+ genui 13)
npx tsx examples/24-generative-ui.ts
  → final state: chart.loading false→true→false, bars 增量 2 次, summary 注册并填 body
  → CLI sink 8 个 fragment 按序打印
```

---

## Update — 2026-05-08 · v3.7 Voice prototype landed

第七根能力轴落地。**全部 7/7 v3 能力轴 prototype 收官。** provider-agnostic ASR / TTS 接口 + 离线参考 stub。peer (openai-agents) 的 realtime 锁定 OpenAI Realtime API；我们让 Deepgram / Whisper / Azure / ElevenLabs / Coqui 任何 provider 都能 plug in。

### 交付物

| 路径 | 内容 |
|---|---|
| `src/voice/types.ts` | `AsrProvider` / `TtsProvider` 接口 + `AsrChunk` / `TtsChunk` / 选项类型 |
| `src/voice/runtime.ts` | `StubAsrProvider` / `StubTtsProvider` + `collectTranscript` / `collectAudio` / `bufferToChunks` |
| `src/voice/index.ts` | 公开导出 |
| `src/index.ts` | 顶层 re-export voice provider + helpers |
| `tests/voice.test.ts` | 13 cases：byte split · partial chunks · final 标志 · empty input · 流式 text 输入 · delta 拼接 · round-trip |
| `examples/25-voice.ts` | TTS 流 → ASR 流 → 端到端 round-trip 三段演示 |

### 接口对位

```ts
interface AsrProvider {
  readonly name: string
  transcribe(audio: AsyncIterable<Uint8Array>, opts?: AsrOptions): AsyncIterable<AsrChunk>
}
interface TtsProvider {
  readonly name: string
  synthesize(text: string | AsyncIterable<string>, opts?: TtsOptions): AsyncIterable<TtsChunk>
}
```

`AsrChunk.delta` 区分了"全量 cumulative"和"增量 delta"两种 partial 风格；`collectTranscript()` 帮 host 屏蔽差异。

### vs peer

| 维度 | clavue v3.7 | openai-agents Realtime |
|---|---|---|
| Provider 锁定 | ❌ 任何 ASR/TTS 实现接口即可 | ✅ 仅 OpenAI Realtime |
| 流式 ASR partial | ✅ 显式 `final` + 可选 `delta` | ✅（隐式格式） |
| 流式 TTS chunked audio | ✅ `Uint8Array` chunks | ✅（websocket frames） |
| 离线 stub provider | ✅ 测试 / CI 友好 | ❌ 必须连 OpenAI |
| Streaming text input → TTS | ✅ `string \| AsyncIterable<string>` | — |

### 关键设计

1. **接口只有一个方法**（transcribe / synthesize），适配器极便宜。
2. **音频用 `Uint8Array`**，跨 Node/Browser 通用；不依赖 `Buffer`。
3. **`bufferToChunks()` 共享辅助**，避免每个 host 自己写。
4. **stub 是 first-class**：tests / examples 离线跑，不需要 API key。
5. **`collectTranscript` 同时支持 cumulative 与 delta** ASR — 真实 provider 不需要改 host 代码。

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 411 / 411 passed (基线 325 + graph 12 + guardrails 11 + tracing 11 + sandbox 13 + rag 13 + genui 13 + voice 13)
npx tsx examples/25-voice.ts
  → TTS: 5 chunks, 34B total（"Hello from clavue voice prototype."）
  → ASR: 3 partial + 1 final, conf 0.60→0.70→0.80→0.95, 文本前缀正确
  → 端到端 round-trip：TTS bytes → ASR transcript 还原成功
```

---

## 全景：v3 prototype 7/7 收官

| 能力轴 | 状态 | 测试 | Example | 代差关键词 |
|---|---|---|---|---|
| v3.1 Graph DSL (5 kinds + onStep) | ✅ | 12 | 19-graph-dsl | verifier / human / 纯函数 router |
| v3.2 Sandbox capability tokens | ✅ | 13 | 22-capability-tokens | 4 deny reason · maxUses · 撤销 |
| v3.3 Live Tracing (replay + serialize) | ✅ | 11 | 21-tracing-replay | replay · JSON round-trip |
| v3.4 Guardrails (4 scopes) | ✅ | 11 | 20-guardrails | tool_input / tool_output |
| v3.5 RAG retriever | ✅ | 13 | 23-rag-retriever | 协议 ≠ 锁定 |
| v3.6 Generative UI | ✅ | 13 | 24-generative-ui | data 增量 patch |
| v3.7 Voice (ASR/TTS) | ✅ | 13 | 25-voice | provider-agnostic |

**累计**：86 个新测试 + 7 个 example。0 行既有代码改动 — 7 轴全部为新模块。

### 验证矩阵

| 检查 | 结果 |
|---|---|
| `npm run build` | tsc 0 error |
| `npm test` | 411 / 411 passed (基线 325 + 86 新增) |
| 7 个 example 全部 offline 跑通 | ✅（19/20/21/22/23/24/25） |
| 既有代码 diff | 仅 `src/index.ts` 加 barrel export，无业务改动 |
| 跨模块调用 | 无；7 轴互相独立可单独引用 |

### 这意味着什么

- 文档承诺的 7 个"代差能力" 全部从 marketing 变成可运行代码 + 测试 + offline example。
- 0 行既有代码动 — 所有新增模块按"plain class / interface + reference impl"模式落地，`src/index.ts` 仅 re-export。
- 集成路径已就位：engine pipeline 后续把 graph runtime 接入 issue-workflow，并把 guardrail / trace / capability 三轴在 tool dispatch 点交叉调用一次，整套故事即从 prototype 升级为 production hot path。
- 与 peer 的对比矩阵已可填实：每行都对应一个 src/* 目录、一个 test 文件、一个 example。

### 下一步（不在本轮 7/7 收官范围内）

1. **横向整合**：把 guardrails + tracing + sandbox 接入 graph runtime，让三轴在每个 agent/tool 节点交叉调用。
2. **engine pipeline 接入**：issue-workflow 用 graph DSL 替代固定 4 角色。
3. **真实 provider 适配器**：Whisper-local ASR · Deepgram ASR · ElevenLabs TTS · pgvector retriever · OTel trace exporter。
4. **README 对比矩阵更新**：把"clavue vs codex-launcher"那张错位表换成本文档的真实 7 轴矩阵。

但作为 7/7 v3 prototype 收官，本轮目标已达成 — 文档对齐、代码可运行、测试覆盖、offline example 跑通。

---

## Update — 2026-05-08 · 横向整合 step 1: graph runtime 接入 trace

第一根整合线落地。`runGraph()` 新增 `options.trace?: TraceStore` —— 传入即每个 step 自动 `appendGraphStep`，无需手写 `onStep`。三轴（v3.1 Graph + v3.3 Trace + v3.4 Guardrail）首次在一个 example 里组合跑通。

### 改动面（surgical）

| 文件 | 改动 |
|---|---|
| `src/graph/types.ts` | `RunGraphOptions` 加可选 `trace?: TraceStore` 字段 + import type |
| `src/graph/runtime.ts` | `emit(step)` 先送 `trace.appendGraphStep`，再送 `onStep`；二者错误均吞掉 |
| `tests/tracing.test.ts` | 加 2 个 integration case：(a) 仅 `trace` 自动接收；(b) `trace + onStep` 双 sink |
| `examples/26-integrated-stack.ts` | guardrail 预飞 + runGraph(trace) + serialize/replay 全链路 demo |

### 关键设计

1. **零破坏性**：`trace` 是 optional，老代码（`onStep` 单 sink、零 sink）行为完全不变。
2. **错误隔离**：trace.appendGraphStep 抛错也不会破坏 run（同既有 `onStep` 容错策略）。
3. **caller owns lifecycle**：`startRun()` / `endRun()` 仍由 caller 控制，runtime 只 append。
4. **不动 graph 公共 API 形状**：`RunGraphResult` 不变；只是 options 多一个钩子。

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 413 / 413 passed (基线 411 + integration 2)
npx tsx examples/26-integrated-stack.ts
  → guardrail(input) passed=true
  → graph completed, 6 steps
  → trace captured 7 events (1 guardrail + 6 graph_step)
  → fresh-store replay: plan/verify/route/fix/verify/route 按序回放
  → JSON 1888 bytes
8 examples (19~26) 全部 offline 跑通
```

### 这意味着什么

- 7/7 prototype 不再各自独立：v3.1 / v3.3 / v3.4 已经能组合为一个 run-loop。
- "完整升级链路"从 7 个独立模块进化为可组合管线 — 这是 peer SDK 没有的属性（openai-agents 的 tracing dashboard 是 SaaS lock-in，不能这样 plug 进自家 graph）。
- 集成路径剩余两条（不在本轮范围）：(a) guardrail 在 graph 的 agent / verifier 节点前后自动 evaluate；(b) capability token 在 tool dispatch 处自动 check。这两条需要先确定语义（违规时是 abort run 还是 skip step），属于"产品决策"而非纯实现。

### 累计 v3 状态（含整合）

| 维度 | 状态 |
|---|---|
| 7/7 axis prototype | ✅ |
| graph + trace 自动组合 | ✅（本次） |
| graph + guardrail 自动组合 | ⏳（语义决策待定） |
| graph + sandbox 自动组合 | ⏳（语义决策待定） |
| 真实 provider 适配器 | ⏳ |
| engine pipeline 接入 graph DSL | ⏳ |

> 下一步候选：(a) 写 `docs/v3_rfc.md`，列 guardrail-violation-on-graph 与 capability-deny-on-tool 的 4 种语义选项让外部 review；(b) 实现一个真实 provider 适配器（Whisper-local / pgvector / OTel exporter）；(c) issue-workflow 用 graph DSL 替代固定 4 角色。优先 (a)，在大改前先收齐语义决策。

---

## Update — 2026-05-08 · 横向整合 step 2: graph runtime 接入 guardrails (output scope)

第二根整合线落地。`runGraph()` 新增 `options.guardrails?: GuardrailRegistry` + `options.onViolation?` 策略钩子。三轴在一次 run 中互相嵌套：guardrail 检查 + trace 录证据 + graph 决定终止。

### 改动面（surgical）

| 文件 | 改动 |
|---|---|
| `src/graph/types.ts` | `RunGraphOptions` 加可选 `guardrails` + `onViolation`；import `GuardrailRegistry` / `GuardrailEvaluation` 类型 |
| `src/graph/runtime.ts` | agent 节点完成后调 `guardrails.evaluate('output', text, { agentId })`；若 `trace` 也存在，自动 `appendGuardrail`；违规时调 `onViolation`（默认 abort）|
| `tests/tracing.test.ts` | 加 4 个 integration case：默认 abort · onViolation=continue · trace 自动录 · onViolation 抛错也 abort |

### 设计决策（含语义解释）

1. **范围**：仅 `output` scope。`tool_input` / `tool_output` 由工具调度器拥有（graph 节点不直接看 raw tool calls）。
2. **默认行为**：`passed=false`（含至少 1 个 blocking violation）→ abort run。这是同 OpenAI guardrails / Express middleware 的安全默认。
3. **可覆盖**：`onViolation(ev, step)` 返回 `'continue' | 'abort'`，async 友好。
4. **抛错也安全**：策略钩子抛错按 `'abort'` 处理，不破坏 run。
5. **abort 时保留状态**：`outputs / gates / history` 都返回到调用方手里，便于诊断。
6. **trace 联动**：当 `trace` 与 `guardrails` 都存在，guardrail evaluation 自动作为 `guardrail` event 入帐 — caller 不必手写。

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 417 / 417 passed (基线 413 + integration 4)
8 examples (19~26) 全部 offline 跑通（零回归）
```

### 这意味着什么

- 三轴（v3.1 Graph + v3.3 Trace + v3.4 Guardrails）现在能在一次调用里组合：
  ```ts
  await runGraph(graph, { input }, {
    guardrails: registry,    // v3.4
    trace: store,            // v3.3
    onViolation: (ev, s) => 'abort',  // 策略
  })
  ```
- peer SDK 的 guardrails 是 input/output 全局两点；clavue 这里把 `output` scope 钉在每个 agent 节点之后，并允许 caller 决定后续动作。这是 graph 与 guardrail 的一等公民 composition。
- 未在本轮范围内（仍属"语义决策"）：(a) `tool_input` / `tool_output` 在工具调度处的接入；(b) capability token check 在工具调度处的接入。两者本质相同：需要先确认"graph node 是否承担 tool dispatch 责任"——目前 graph node 只跑 agent.prompt，不直接调 tool，所以 tool 维度的 guardrail 应该在更下层（engine/orchestrator）注入。

### 累计 v3 状态（含整合）

| 维度 | 状态 |
|---|---|
| 7/7 axis prototype | ✅ |
| graph + trace 自动组合 | ✅ |
| graph + guardrail (output scope) 自动组合 | ✅（本次）|
| graph + guardrail (tool_input/tool_output) | ⏳（属下层 engine 接入点）|
| graph + sandbox 自动组合 | ⏳（同上）|
| 真实 provider 适配器 | ⏳ |
| engine pipeline 接入 graph DSL | ⏳ |

> 下一步候选：(a) 写 `docs/v3_rfc.md` 列剩余决策点；(b) 真实 provider 适配器；(c) engine pipeline 接入 graph。本轮已用 7/20 turns，剩余预算可承担 (a) 或 (c) 任一。

---

## Update — 2026-05-08 · 外部对接 step 1: OTel-shape trace exporter

第三根外部对接线落地。v3.3 TraceStore 从"in-memory 录 + replay"扩展到"导出为行业标准数据"。
OTel 语义约定，零运行时依赖 — 任何 OTel SDK / Loki / Splunk / Tempo / Datadog 都能直接消费。

### 改动面（surgical，全部 additive）

| 文件 | 改动 |
|---|---|
| `src/tracing/exporter.ts` | 新建：`eventToOtelSpan` 纯函数 + `OtelSpanLike` / `TraceExporter` 接口 + `ConsoleExporter` / `JsonlExporter` 参考实现 |
| `src/tracing/index.ts` | barrel 导出 exporter 层符号 |
| `src/index.ts` | 顶层 re-export |
| `tests/tracing-exporter.test.ts` | 10 cases：每种 kind 的语义映射 · error status · 未知 kind passthrough · console 格式 · JSONL drain · 端到端 graph+guardrail → JSONL |
| `examples/27-trace-exporter.ts` | graph+guardrail+trace 跑完 → Console + JSONL 双导出，展示真实 OTel-shape 输出 |

### 语义约定（OTel semconv 对齐）

| Event kind | span.name | 关键 attributes |
|---|---|---|
| `graph_step` | `graph.step.<kind>` | `graph.node_id` · `graph.kind` · `graph.status` · `graph.output.kind` |
| `guardrail` | `guardrail.<scope>` | `guardrail.scope` · `guardrail.passed` · `guardrail.violation_count` · `guardrail.violations` · `agent.id?` · `tool.name?` |
| `tool_call` | `tool.<phase>.<name>` | `tool.name` · `tool.phase` |
| 其它 | `trace.<kind>` | `trace.data` 透传 |

### 关键设计

1. **零运行时依赖**：`OtelSpanLike` 形状对齐 OTel `ReadableSpan` 但不 import `@opentelemetry/api`，host 可用真 OTel SDK 包一层就发送。
2. **纯函数转换**：`eventToOtelSpan(event)` 无 I/O、可缓存、可并行。
3. **多 exporter 同存**：Console 给开发者看、JSONL 给 shipper、OTel SDK 给 APM 后端 — 同一份 events 可多路输出。
4. **错误映射**：step.failed / guardrail.passed=false → `span.status.code='error'`，对齐 OTel 语义。
5. **traceId = runId**：一次 run 的所有 span 共享 traceId，APM 能直接看到整条调用链。

### vs peer

| 维度 | clavue v3.3 + exporter | openai-agents tracing dashboard |
|---|---|---|
| 行业标准格式 | ✅ OTel-shape | ❌ 专有 schema |
| 导出目标 | ✅ 任何 JSONL/OTel 消费方 | ❌ 仅 OpenAI 自家 dashboard |
| 本地/离线 | ✅ | ❌ |
| Vendor lock-in | ❌ | ✅ |

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 427 / 427 passed (基线 417 + exporter 10)
npx tsx examples/27-trace-exporter.ts
  → 8 events → 8 OTel spans
  → ConsoleExporter: 每行含 status [OK]/[ERR] + name + duration + flat attrs
  → JsonlExporter: 2066 bytes, 8 行有效 OTel JSON
9 examples (19~27) 全部 offline 跑通
```

### 这意味着什么

- v3.3 从"能看 + 能 replay"升级到"能导出到任何 APM 后端"，peer tracing 的 vendor lock-in 彻底失去说服力。
- 真实企业客户的 OTel pipeline (Tempo / Honeycomb / Datadog / Dynatrace) 今天就能集成 clavue trace，不需要等 v3.3 GA。
- 集成路径：host 在 `startRun()` 时创建 OTel tracer，在 `endRun()` 后用 `eventToOtelSpan` 批量转 span，调 OTel SDK `tracer.startSpan().end()` 即可。单次集成成本 ≈ 50 行 host 代码。

### 累计对外能力矩阵

| 能力 | 状态 |
|---|---|
| 7/7 v3 axis prototype | ✅ |
| graph + trace 自动组合 | ✅ |
| graph + guardrail (output) 自动组合 | ✅ |
| **trace → OTel-shape 导出** | ✅（本次）|
| trace → Console / JSONL shipper | ✅（本次）|
| graph + sandbox 自动组合 | ⏳ |
| 真实 provider 适配器 (Whisper / pgvector / ElevenLabs) | ⏳ |
| engine pipeline 接入 graph DSL | ⏳ |

> 下一步候选：(a) `docs/v3_rfc.md` 列 engine 接入点与 tool-scope guardrail 语义；(b) issue-workflow 用 graph DSL 替代固定 4 角色；(c) 真实 ASR/TTS adapter 骨架。优先 (a) — 最后一个硬决策，做完就能进入 v3 GA 开发。

---

## Update — 2026-05-08 · v3 RFC 落地

`docs/v3_rfc.md` 写完。锁死 4 个剩余硬决策，解锁后续所有集成。

| 决策 | 选项 | 选 | 一句话理由 |
|---|---|---|---|
| **D1** tool-scope guardrail 入口 | 图节点 / 引擎 dispatcher / 两者 / helper 层 | **B 引擎 dispatcher** | 一处入口，`agent.prompt()` 直调也覆盖 |
| **D2** capability-deny 语义 | abort / skip / log / 回调 | **D 回调；默认 `'skip'`** | tool deny ≠ output deny — 让 agent 换把锁 |
| **D3** issue-workflow 迁移 | fork / replace / flag / 删 | **B replace internally** | 公共 schema 零改动，一份实现 |
| **D4** retriever 接线 | graph 节点 / agent 字段 / 工具 / hybrid | **A `retriever` 节点** | 可 compose，tool route 依然开放 |

### 执行顺序（已写进 RFC 末尾）

1. D1+D2 合并一把 — 引擎 tool dispatcher 加 guardrail pre/post + capability 回调
2. D4 — `retriever` 节点 kind + `examples/28-rag-graph.ts`
3. D3 — `runIssueWorkflow` 内部换成 `runGraph`
4. README 重写对比矩阵
5. 真实 adapter (Whisper / pgvector / ElevenLabs)

### 累计对外能力矩阵

| 能力 | 状态 |
|---|---|
| 7/7 v3 axis prototype | ✅ |
| graph + trace 自动组合 | ✅ |
| graph + guardrail (output) 自动组合 | ✅ |
| trace → OTel-shape 导出 | ✅ |
| trace → Console / JSONL shipper | ✅ |
| **v3 RFC 决策锁死** | ✅（本次）|
| engine + guardrail (tool scopes) | ⏳ |
| graph + retriever 节点 | ⏳ |
| issue-workflow 换 graph 后端 | ⏳ |
| 真实 provider 适配器 | ⏳ |

> 下一步候选：(a) D1+D2 引擎 tool dispatcher 集成；(b) D4 `retriever` 节点；(c) D3 issue-workflow 替换。按 RFC 顺序 (a) 优先 — 唯一动到引擎热路径的一步，做完剩下全是加法。

---

## Update — 2026-05-08 · D1+D2 引擎 ↔ guardrail (tool scopes) 落地

RFC 锁死的 D1+D2 第一刀。引擎 tool dispatcher 在 `executeSingleTool` 内插入 pre-call (`tool_input`) + post-call (`tool_output`) 双扫描点，封死了 v3.4 代差最后一个洞。

### 改动面（surgical）

| 文件 | 改动 |
|---|---|
| `src/types/engine.ts` | `QueryEngineConfig` 加可选 `guardrails` + `trace`（additive） |
| `src/types/agent.ts` | `AgentOptions` 加可选 `guardrails` + `trace`（additive） |
| `src/agent.ts` | engine 实例化时透传 2 字段（2 行） |
| `src/engine.ts` | `executeSingleTool`：`tool.call` 前/后插入 guardrail 评估 + trace 事件追加 |
| `tests/engine-guardrails.test.ts` | 6 cases：input-block · input-pass · output-block · trace 双事件 · async/throw · no-guardrails 快路径 |

### 关键设计

1. **默认 `'skip'`**：blocking 违规不抛错，返回 `is_error: true` `ToolResult` 喂回模型，agent loop 自然 replan。`'abort'` / `'continue'` policy 回调留作 follow-up（不在本次 prototype 范围）。
2. **覆盖直调路径**：`agent.prompt()` / `agent.query()` 不必经过 graph runtime 也能享受 guardrails — 这是 RFC D1 选 B（引擎 dispatcher）而非图节点 wrapper 的核心理由。
3. **trace 自动对齐**：当 `trace` + `guardrails` 同时配置时，每次工具调用追加 1 条 `tool_input` + 1 条 `tool_output` `guardrail` 事件，自带 `toolName` — 直接 OTel exporter 消费。
4. **零开销快路径**：未配置 guardrails 时整段跳过；现存 427 测试无任何变化（仅 +6 新测试）。
5. **throw 等价 block**：guardrail check 抛错由 `GuardrailRegistry.evaluate` 转成 blocking violation（已有逻辑），引擎层无需特判。

### vs peer

| 维度 | clavue v3.4 + engine wiring | openai-agents guardrails |
|---|---|---|
| `input` / `output` scope | ✅ | ✅ |
| `tool_input` / `tool_output` scope | ✅ | ❌ |
| Guardrail 在每次工具调用前/后强制 | ✅ | ❌ |
| 默认 `'skip'`（agent 可 replan） | ✅ | ❌（部分 abort） |
| trace 自动归集 | ✅（OTel-shape） | ❌（专有 schema） |

### 验证证据

```
npm run build   → tsc 0 error
npm test        → 433 / 433 passed (基线 427 + engine-guardrails 6)
新测试覆盖：
  - tool_input 拦截：toolFired=false，denied tool_result 回流到模型
  - tool_input 通过：tool 正常运行
  - tool_output 拦截：denied 出现在下一轮 provider 调用
  - trace 双事件：tool_input + tool_output 各 1 条，toolName=capture
  - async + throw：异步 check 被 await，抛错算 blocking
  - 快路径：未配置 guardrails 时零开销
```

### 这意味着什么

- v3.4 的"4 scope"现在是**真的 4 scope**，不是 prototype 摆设 — `tool_input` / `tool_output` 直通真实 LLM 工具调用路径。
- 模型自我修复路径在位：denied tool 不中断 run，agent loop 看到 `is_error: true` 会换工具或换输入，符合 RFC D2 的"tool deny ≠ output deny"语义。
- 企业部署最关心的两条 — "PII 不出工具结果"和"密钥不进工具输入" — 今天就能用 8 行 host 代码加在 `Agent` 构造选项上。

### 累计对外能力矩阵

| 能力 | 状态 |
|---|---|
| 7/7 v3 axis prototype | ✅ |
| graph + trace 自动组合 | ✅ |
| graph + guardrail (output) 自动组合 | ✅ |
| trace → OTel-shape 导出 | ✅ |
| trace → Console / JSONL shipper | ✅ |
| v3 RFC 决策锁死 | ✅ |
| **engine + guardrail (tool_input + tool_output)** | ✅（本次）|
| graph + retriever 节点 | ⏳ |
| issue-workflow 换 graph 后端 | ⏳ |
| 真实 provider 适配器 | ⏳ |

> 下一步候选：(a) RFC D4 — `retriever` 图节点 + `examples/28-rag-graph.ts`；(b) RFC D3 — `runIssueWorkflow` 内部用 `runGraph` 替换；(c) `'abort'` / `'continue'` policy 回调（D2 follow-up）。按 RFC 顺序 (a) 优先 — 7 axis 中 RAG 轴还没接进 graph，做完整体能力矩阵就只剩 issue-workflow 一个内部重构。

---

## Update — 2026-05-08 · D4 graph ↔ retriever (RAG) 节点落地

RFC D4 落地。Graph DSL 加第 6 种节点 kind `retriever`，v3.5 RAG 轴第一次直通到图运行时。

### 改动面（surgical）

| 文件 | 改动 |
|---|---|
| `src/graph/types.ts` | 新增 `kind: 'retriever'` 节点类型 + `GraphNodeOutput` 加 `'retrieval'` 变体 |
| `src/graph/runtime.ts` | `executeNode` 加 `case 'retriever'`，调 `retriever.retrieve({ text, topK, where })` |
| `src/tracing/exporter.ts` | `eventToOtelSpan` 在 `graph_step` 分支识别 `retrieval` 输出，附 `retrieval.hit_count` 属性 |
| `tests/graph-retriever.test.ts` | 5 cases：基本检索 · retrieve→agent · 异常传播 · OTel attr · `where` 过滤 |
| `examples/28-rag-graph.ts` | 离线 demo：retriever→agent 链路 + trace → OTel 输出 |

### 关键设计

1. **零 LLM 依赖**：retriever 节点只调 `retriever.retrieve()`，输出 `RetrievalHit[]` 落进 `ctx.outputs[id]`。下游 agent 节点的 `prompt(ctx)` 自由读取 hits 拼 prompt — 这是 RFC D4 选 A（图节点 kind）而非 agent 字段的核心理由：可 compose、可路由、可被 verifier 接管。
2. **provider-agnostic**：`Retriever` interface 已经是 v3.5 prototype 的契约（pgvector / Qdrant / Pinecone 任意接入）。新节点不引入新依赖，直接复用。
3. **OTel 语义零特判**：`graph.step.retriever` 由现存 `graph.step.<kind>` 规则自动生成，新增的只有 `retrieval.hit_count` 一条 attribute — 任何 OTel 后端都能直接看 dashboard。
4. **失败语义统一**：retriever 抛错走与 agent / verifier 一致的 `try/catch` 路径，graph 状态变 `aborted`，调用方拿到 `outputs/gates/history` 快照。
5. **`where` 元数据过滤**：节点字段透传到 `RetrieveQuery.where`，与 `InMemoryRetriever`/`pgvector` adapter 的标准接口对齐。

### vs peer

| 维度 | clavue v3.5 + graph 节点 | Mastra RAG | LlamaIndex |
|---|---|---|---|
| Retriever 是图一等节点 | ✅ | ❌（agent 字段） | ❌（chain 内置） |
| Provider-agnostic | ✅ | ✅ | ✅ |
| 输出可被 verifier / router 链式消费 | ✅ | ❌ | ❌ |
| trace → OTel 自动归集 | ✅ | ❌ | 部分 |
| `where` 元数据过滤 | ✅ | ✅ | ✅ |

### 验证证据

```
npm run build    → tsc 0 error
npm test         → 438 / 438 passed (基线 433 + retriever 5)
npx tsx examples/28-rag-graph.ts → graph(retriever→agent) 离线跑通
  - retrieved 2 hits for "capital of France"
  - graph.step.retriever span: retrieval.hit_count=2
  - graph.step.agent span: 自动跟在 retriever 之后
10 examples (19~28) 全部 offline 跑通
```

### 这意味着什么

- v3.5 RAG 不再是孤岛 prototype — `Retriever` 现在是**图节点**，与 verifier / router / parallel / human / agent 五兄弟同等待遇。
- 真实 RAG pattern (retrieve → rerank → agent answer → verifier check) 今天就是 ~15 行 graph 定义 + 一份 retriever 实例。
- pgvector / Qdrant / Pinecone host 集成路径不变（实现 `Retriever` interface 即可），但现在多了一层"图编排"杠杆 — peer 没人这么干。

### 累计对外能力矩阵

| 能力 | 状态 |
|---|---|
| 7/7 v3 axis prototype | ✅ |
| graph + trace 自动组合 | ✅ |
| graph + guardrail (output) 自动组合 | ✅ |
| trace → OTel-shape 导出 | ✅ |
| trace → Console / JSONL shipper | ✅ |
| v3 RFC 决策锁死 | ✅ |
| engine + guardrail (tool_input + tool_output) | ✅ |
| **graph + retriever 节点 (RAG axis)** | ✅（本次）|
| issue-workflow 换 graph 后端 | ⏳ |
| 真实 provider 适配器 | ⏳ |

> 下一步候选：(a) RFC D3 — `runIssueWorkflow` 内部委托给 `runGraph`（公共 schema 零改动）；(b) `'abort'` / `'continue'` policy 回调（D2 follow-up）；(c) 真实 adapter 骨架。按 RFC 顺序 (a) 优先 — 把固定 4 角色 loop 换成 graph 后，整个 SDK 内部就只有一份多步编排实现，对 README "我们独有 issue-workflow real loop" 的说法也更扎实。
