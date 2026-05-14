# USAGE — Clavue Agent SDK 1.0.3 详细用法

> 本文档面向**实际使用 SDK 的开发者**。每节回答四个问题：
> 1. **是什么** — 这个能力解决什么问题
> 2. **何时用** — 适用场景 + 不适用场景
> 3. **怎么用** — 最小可运行代码
> 4. **要小心什么** — 易踩坑

如果你只是想 5 分钟跑通，看 [README.md](../README.md) 头屏的 quickstart。

---

## 目录

**Core**
1. [`createAgent` / `run` / `query`](#1-agent-的三种用法)
2. [流式输出（Streaming）](#2-流式输出-streaming)
3. [结构化输出（`outputSchema`）](#3-结构化输出-outputschema)
4. [Anthropic Prompt Caching](#4-anthropic-prompt-caching)
5. [工具与 toolset](#5-工具与-toolset)
6. [权限模式与 autonomy](#6-权限模式与-autonomy)
7. [Hooks 与 Middleware](#7-hooks-与-middleware)

**Subagents & Isolation**

8. [`runtime: 'worker_thread'` 真隔离子代理](#8-worker_thread-真隔离子代理)

**v3 七轴能力**

9. [Multi-agent Graph DSL](#9-multi-agent-graph-dsl)
10. [4-Scope Guardrails](#10-4-scope-guardrails)
11. [Live Tracing + OTel](#11-live-tracing--otel)
12. [Capability-Token Sandbox](#12-capability-token-sandbox)
13. [RAG（`InMemoryRetriever` / `PgvectorRetriever`）](#13-rag)
14. [Generative UI（框架无关）](#14-generative-ui-框架无关)
15. [Voice 适配器（ASR + TTS）](#15-voice-适配器)

**Workflow & 长任务**

16. [`runIssueWorkflowWithAgent` 真闭环](#16-runissueworkflowwithagent-真闭环)
17. [Background AgentJobs](#17-background-agentjobs)

**生产化**

18. [Quality Gates + Proof-of-Work](#18-quality-gates--proof-of-work)
19. [Memory（结构化 + 向量检索）](#19-memory)
20. [Schema Versions 与 Trace](#20-schema-versions-与-trace)
21. [List caches & invalidation hatches](#21-list-caches--invalidation-hatches)

---

## 1. Agent 的三种用法

**是什么**：SDK 提供三个公开入口，对应三种集成场景。

| API | 返回 | 何时用 |
|---|---|---|
| `run({ prompt, options })` | `Promise<AgentRunResult>` | 后端任务、CI 检查、一次性结果 |
| `query({ prompt, options })` | `AsyncGenerator<SDKMessage>` | UI / 日志面板需要事件流 |
| `createAgent(options)` | `Agent` 实例 | 多轮会话、hooks、MCP、subagent |

**何时用**

- ✅ 后端 cron / Webhook / queue worker → `run()`
- ✅ 前端 SSE / WebSocket 推送 → `query()`
- ✅ 长生命周期对话 / 复用 hooks 配置 → `createAgent()`
- ❌ 不要在每次请求都新建 Agent（MCP 连接昂贵），用一个 `createAgent()` 复用

**怎么用**

```ts
// run() — 一次输入、一次结构化结果
import { run } from 'clavue-agent-sdk'

const result = await run({
  prompt: 'Summarize package.json',
  options: { cwd: process.cwd(), maxTurns: 6, toolsets: ['repo-readonly'] },
})
if (result.status !== 'completed') throw new Error(result.errors?.join('\n'))
console.log(result.text)
console.log('cost:', result.total_cost_usd)
```

```ts
// query() — 流式事件
import { query } from 'clavue-agent-sdk'

for await (const ev of query({
  prompt: '...',
  options: { includePartialMessages: true },
})) {
  if (ev.type === 'partial_message') process.stdout.write(ev.partial.text)
  if (ev.type === 'tool_result') console.log('[tool]', ev.result.tool_name)
  if (ev.type === 'result') console.log('done:', ev.subtype)
}
```

```ts
// createAgent() — 复用配置 + 多轮
import { createAgent } from 'clavue-agent-sdk'

const agent = createAgent({
  model: 'claude-sonnet-4-6',
  toolsets: ['repo-readonly', 'research'],
  hooks: {
    PreToolUse: [{ hooks: [(input, _id, ctx) => audit(input)] }],
  },
})
await agent.run('first task')
await agent.run('follow-up using prior context')
await agent.close()  // 持久化 session（如果开启了）
```

**要小心什么**

- `Agent` 持有 MCP 连接和 ambient 状态——记得 `await agent.close()`
- 信号量：默认每次 `run()` 用同一 sessionId；要全新会话用 `agent.clear()`
- 跨进程共享 ambient 状态用 `runtimeNamespace` 隔离

---

## 2. 流式输出 (Streaming)

**是什么**：开启 `includePartialMessages: true` 后，engine 把模型的 token delta 通过 `partial_message` 事件实时 emit，UI 不必等整段响应到齐。

**何时用**

- ✅ Web UI 需要 ChatGPT 那样的逐字效果
- ✅ 长响应（>3s）的体感优化
- ❌ 后端"一次输入一次结果"场景没必要开（多耗一点 CPU 序列化 chunk）
- ❌ 工具结果不会走 partial — 只有模型的 text 会

**怎么用**

```ts
import { query } from 'clavue-agent-sdk'

for await (const ev of query({
  prompt: 'Write a 200-word essay on agent SDKs.',
  options: { includePartialMessages: true },
})) {
  if (ev.type === 'partial_message' && ev.partial.type === 'text') {
    process.stdout.write(ev.partial.text)
  }
  if (ev.type === 'assistant') {
    // 完整 assistant 消息（partial 收尾后）
  }
  if (ev.type === 'result') {
    console.log('\n[done]', ev.subtype)
  }
}
```

**要小心什么**

- Anthropic 走 `client.messages.stream(...)`；OpenAI Chat 走 SSE。第三方网关如果不支持 SSE，会自动 fallback 到非流式
- 工具调用前先收齐完整 assistant 消息——partial 流中途中断时，messages history 仍保持一致
- 测试见 `tests/streaming.test.ts`

---

## 3. 结构化输出 (`outputSchema`)

**是什么**：让模型严格按 JSON schema 输出，避免 prompt+regex parse。

**何时用**

- ✅ 数据抽取（"提取 PR 标题、风险等级、复现步骤"）
- ✅ 任务规划（输出 `{ steps: [...] }`）
- ✅ Agent 之间传递结构化中间结果
- ❌ 创意写作/对话——会限制模型表达
- ❌ 可以容忍后处理 parse 失败的场景——增加一层校验反而更脆

**怎么用**

```ts
import { run } from 'clavue-agent-sdk'

const PlanSchema = {
  type: 'object',
  required: ['title', 'steps'],
  properties: {
    title: { type: 'string' },
    steps: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'description'],
        properties: {
          id: { type: 'string' },
          description: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}

const result = await run({
  prompt: 'Plan a small refactor for src/utils/retry.ts',
  options: {
    outputSchema: {
      name: 'plan',                          // 工具名/字段名（默认 _output）
      description: 'A short refactor plan',
      schema: PlanSchema,
    },
  },
})
const plan = JSON.parse(result.text)
console.log(plan.steps[0].description)
```

**要小心什么**

- 0.7.x 的 `jsonSchema` 字段是死代码（被忽略）；1.0.1 接受 `jsonSchema` 但**已弃用**，1.1.0 会删——直接用 `outputSchema`
- Anthropic 走"合成 `_output` 工具 + `tool_choice`"路径，OpenAI Chat 走 `response_format: json_schema`，OpenAI Responses 走 `text.format`。三种实现你都不需要关心
- 工具配合：模型可能选择"先调工具再产出结构化输出"——schema 只在最后 assistant 消息上生效

---

## 4. Anthropic Prompt Caching

**是什么**：Anthropic 在 system prompt + tool list 末尾加 `cache_control: ephemeral`，第二轮起这两段免费 cache_read（成本 ~10% 原价）。1.0.1 默认开启，无需配置。

**何时用**

- ✅ 多轮对话（≥2 轮就有收益）
- ✅ Tools 列表稳定的长 run
- ✅ System prompt 较大（>1k tokens）
- ❌ 单 turn run 完即销毁——cache 写入是 1.25× 成本，没有第二次读
- ❌ Tools 每轮都不同——prefix 不稳定，cache miss

**怎么用**

不需要写代码。验证它生效：

```ts
const result = await run({ prompt: '...', options: { /* ... */ } })
console.log({
  cache_creation: result.usage.cache_creation_input_tokens,  // 第一轮非 0
  cache_read: result.usage.cache_read_input_tokens,           // 第二轮起非 0
})
```

**要小心什么**

- 模型必须支持（claude-3 系列及以上）。`claude-2.x` / `claude-instant` 自动跳过
- 如果 system prompt 每次都不同（含时间戳、随机 ID），cache_read 永远是 0——把动态部分搬到 user message
- breakpoint 限制：Anthropic 最多 4 个 cache_control。我们用了 system + tools 共 2 个，留 2 个给宿主

---

## 5. 工具与 toolset

**是什么**：30+ 内置工具 + 9 个命名 toolset 预设。可以混合 + allow/deny 二次过滤。

**Toolsets**

| toolset | 包含工具 |
|---|---|
| `repo-readonly` | Read, Glob, Grep |
| `repo-edit` | Read, Write, Edit, Glob, Grep, NotebookEdit |
| `research` | WebFetch, WebSearch |
| `planning` | EnterPlanMode, ExitPlanMode, AskUserQuestion, TodoWrite |
| `tasks` | Task* (6 个) |
| `automation` | Cron* + RemoteTrigger |
| `agents` | Agent, AgentJob*, SendMessage, Team* |
| `mcp` | ListMcpResources, ReadMcpResource |
| `skills` | Skill |

**怎么用**

```ts
import { run, defineTool } from 'clavue-agent-sdk'

// (1) 用预设
await run({ prompt: '...', options: { toolsets: ['repo-readonly', 'research'] } })

// (2) allow-list 收窄
await run({
  prompt: '...',
  options: {
    toolsets: ['repo-edit'],
    allowedTools: ['Read', 'Edit'],   // Write/Glob/Grep 被排除
  },
})

// (3) 自定义工具（Zod schema）
import { z } from 'zod'
const myTool = defineTool({
  name: 'add',
  description: 'Add two numbers',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  call: async ({ a, b }) => ({ data: String(a + b) }),
  isReadOnly: true,
  isConcurrencySafe: true,
})
await run({ prompt: 'add 1 and 2', options: { tools: [myTool] } })

// (4) 内置 + 自定义混合
import { getAllBaseTools } from 'clavue-agent-sdk'
const tools = [...getAllBaseTools(), myTool]
await run({ prompt: '...', options: { tools } })
```

**要小心什么**

- 文件工具有 **workspace 路径围栏**：默认拒绝 `..` 越界；想绕过要 `permissionMode: 'bypassPermissions'`
- Bash 工具会**拦截**显式破坏命令（`rm -rf` 等）；要执行需要 host 注入 `canUseTool`
- 并发：标了 `isConcurrencySafe: true` 的连续工具会 Promise.all 批量执行（默认上限 10，`AGENT_SDK_MAX_TOOL_CONCURRENCY` 调整）

---

## 6. 权限模式与 autonomy

**是什么**：两个**正交**的轴。

- `permissionMode` —— **能不能跑**这个工具
- `autonomyMode` —— **多频繁向用户确认**

| `permissionMode` | 行为 |
|---|---|
| `default` | host 的 `canUseTool` 决定 |
| `acceptEdits` | 文件编辑直接放行，shell 等仍要确认 |
| `trustedAutomation` | 全部放行，但 README 仍标榜不应跑发布/删库 |
| `bypassPermissions` | 真·全放行（含 workspace 围栏）|
| `plan` | 只允许 plan 工具，不实际执行 |

| `autonomyMode` | 行为 |
|---|---|
| `supervised` | 多确认；分支决策必问 |
| `proactive` | 默认；遇歧义先做再说 |
| `autonomous` | 不确认 P0-P3 的标准修复；只在不可逆动作前停 |

**怎么用**

```ts
// 高自主，但只许本地编辑
await run({
  prompt: 'Fix the failing test',
  options: {
    permissionMode: 'acceptEdits',
    autonomyMode: 'autonomous',
    maxTurns: 12,
  },
})
```

**要小心什么**

- `trustedAutomation` ≠ "可以发布到 npm"。授权范围按你的请求，不是无界
- CLI 不读 dotfiles——env vars 必须显式设
- 绝不要在 server 入口处用 `bypassPermissions` 接受用户输入——直接 RCE

---

## 7. Hooks 与 Middleware

**两套机制并存**：

- **Hook** = "告诉我发生了 X"（事件订阅，可 block）
- **Middleware** = "我想包装 X 的执行"（koa 风格 `next()`）

**Hook events**: `SessionStart` · `UserPromptSubmit` · `PreCompact` · `PostCompact` · `PreToolUse` · `PostToolUse` · `PostToolUseFailure` · `Stop` · `SessionEnd`

**怎么用**

```ts
const agent = createAgent({
  hooks: {
    PreToolUse: [{
      matcher: 'Bash',          // 可选，按工具名过滤
      hooks: [async (input, toolUseId) => {
        await audit(input)
        if (await isDangerous(input.toolInput)) {
          return { block: true, message: 'Bash blocked by audit' }
        }
        return undefined
      }],
    }],
  },
})

// Middleware（koa-style）
agent.use(async (ctx, next) => {
  const t0 = Date.now()
  await next()
  metrics.record('turn_duration_ms', Date.now() - t0)
})
```

**要小心什么**

- Hook 的 `block: true` 会变成 ToolResult 的 is_error，模型继续推理；如果想终止整 run，throw 一个 Error 给 middleware
- Hook 之间默认并行，任一 block 就 block——不要假设顺序
- Middleware 在 **整个 query 周期** 包一次（不是每 turn 一次）

---

## 8. `worker_thread` 真隔离子代理

**是什么**：把 subagent 跑在独立 V8 isolate 里，硬隔离。1.0.1 phase 2 实装（之前是 `NotImplementedError` stub）。

**何时用**

- ✅ 长跑或不可信任务（爬虫 / 跑用户输入的代码）
- ✅ 需要保证 subagent crash 不影响 parent
- ✅ 防止 task/team 注册表泄露到 parent
- ✅ 需要硬 abort（parent.abort → worker.terminate）
- ❌ 短任务（spawn 成本 ~56ms，划不来）
- ❌ 需要共享父进程内存的重对象

**怎么用**

```ts
import { runAgentSubagent } from 'clavue-agent-sdk/tools'

const completion = await runAgentSubagent({
  input: { prompt: 'Summarize ./package.json', description: 'pkg summary' },
  context: parentToolContext,
  runtime: 'worker_thread',
  allowedTools: ['Read', 'Glob'],
  strictToolSubset: true,    // subagent 工具必须是 parent 的子集，否则抛错
  abortSignal: ctrl.signal,
  // timeoutMs: 60_000,      // 默认 5 分钟
})
console.log(completion.output)
```

**要小心什么**

- Worker 启动 ~56ms 是固定成本（含 tsx loader 转发）
- env 是**白名单转发**：只 `CLAVUE_AGENT_*` + `ANTHROPIC_*` + `OPENAI_*`，不会泄露 parent 全部 env
- `abort()` 后 promise 会立即 reject，但 V8 isolate 真销毁是异步的（毫秒级）
- 见 `examples/31-worker-thread-subagent.ts`

---

## 9. Multi-agent Graph DSL

**是什么**：声明式定义多 agent 工作流。6 种节点：`agent` / `verifier` / `router` / `parallel` / `human` / `retriever`。

**何时用**

- ✅ "先 plan → 并行 build×N → verify → 通过则 ship，失败则 fix" 这类 pipeline
- ✅ Agent 之间需要 typed handoff
- ✅ 想可视化执行链路
- ❌ 单 agent 简单任务——直接 `run()` 更轻
- ❌ 需要任意循环——graph DSL 是 DAG，循环要靠 router 节点回跳

**怎么用**

```ts
import { defineGraph, runGraph } from 'clavue-agent-sdk/graph'

const graph = defineGraph({
  entry: 'plan',
  nodes: [
    { kind: 'agent',    id: 'plan',  agent: planAgent },
    { kind: 'parallel', id: 'build', branches: ['fe', 'be'], join: 'all' },
    { kind: 'agent',    id: 'fe',    agent: feAgent },
    { kind: 'agent',    id: 'be',    agent: beAgent },
    { kind: 'verifier', id: 'verify', verifier: testVerifier },
    { kind: 'router',   id: 'gate',  route: (ctx) =>
        ctx.lastGates.every(g => g.status === 'passed') ? 'ship' : 'fix' },
    { kind: 'agent',    id: 'fix',   agent: fixAgent },
    { kind: 'agent',    id: 'ship',  agent: shipAgent },
  ],
  edges: [
    { from: 'plan',  to: 'build' },
    { from: 'build', to: 'verify' },
    { from: 'verify', to: 'gate' },
    { from: 'fix',   to: 'verify' },     // 回跳
  ],
})

const result = await runGraph(graph, { input: 'Build feature X' })
```

**要小心什么**

- 见 `examples/19-graph-dsl.ts` 完整可跑样例
- `parallel.join: 'all' | 'race' | 'majority'`——race 模式只等最快的，剩下的要么取消要么继续
- `human` 节点会 block 等用户输入，配合超时使用避免死锁

---

## 10. 4-Scope Guardrails

**是什么**：在 `input` / `output` / `tool_input` / `tool_output` 四处插入校验器。每个失败决策可选 `'abort' | 'skip' | 'continue'`。

**何时用**

- ✅ 防 PII / secrets 泄露
- ✅ 强制 tool input 符合 schema
- ✅ 审核 tool output（如禁止某些命令的输出）
- ❌ 一般业务校验——直接在 tool 内部做更便宜

**怎么用**

```ts
import { defineGuardrails } from 'clavue-agent-sdk/guardrails'

const guardrails = defineGuardrails([
  {
    scope: 'tool_input',
    name: 'no-secrets',
    check: async (input, ctx) => {
      const text = JSON.stringify(input)
      const found = /AKIA[A-Z0-9]{16}/.exec(text)
      return found
        ? { passed: false, severity: 'high', message: `AWS key in ${ctx.toolName}` }
        : { passed: true }
    },
  },
])

const agent = createAgent({
  guardrails,
  onToolViolation: (ev, ctx) => {
    if (ev.violations.some(v => v.severity === 'high')) return 'abort'
    return 'skip'   // 默认：跳过这个工具调用，模型看到一个 is_error
  },
})
```

**要小心什么**

- `'continue'` = 审计模式（记录但放行）；`'skip'` = 给模型一个 deny 结果；`'abort'` = 整 run 终止
- 默认 = `'skip'`。要 hard fail 必须显式 `'abort'`
- 见 `examples/20-guardrails.ts`

---

## 11. Live Tracing + OTel

**是什么**：每个 agent run 产出一份 `AgentRunTrace`（已 schema-versioned）。新增 1.0.1 加：traceStore 持久化 + replay + OpenTelemetry exporter shim。

**何时用**

- ✅ debug 单 run 哪步失败
- ✅ 跨 run 性能对比
- ✅ 接入 Jaeger/Honeycomb/Datadog
- ❌ 生产高 QPS 不要每 run 都全量 trace——用采样

**怎么用**

```ts
// (1) 默认就有 trace —— result.trace 直接用
const r = await run({ prompt: '...', options: {} })
console.log(r.trace.turns.length)  // 几轮
console.log(r.trace.tools.length)  // 几次工具调用

// (2) 持久化
import { createTraceStore, attachTraceStore } from 'clavue-agent-sdk/tracing'
const store = createTraceStore({ dir: '~/.cache/clavue-traces' })
attachTraceStore(agent, store)

// (3) replay 之前的 run
const past = await store.load('run_xxx')
console.log(past.events.length)

// (4) 接 OTel
import { OtelTraceExporter } from 'clavue-agent-sdk/tracing'
const exporter = new OtelTraceExporter(otelTracer)
agent.useTracing(exporter)
```

**要小心什么**

- `AGENT_RUN_TRACE_SCHEMA_VERSION = '1.0.0'`——升级时检查 host 的 trace consumer
- OTel shim 是结构化注入，不强依赖 `@opentelemetry/sdk-node`——你传什么 tracer 它用什么
- 见 `examples/21-tracing-replay.ts` / `27-trace-exporter.ts` / `29-otel-shim.ts`

---

## 12. Capability-Token Sandbox

**是什么**：基于 capability token 的访问控制。Subagent / sandbox 拿到 token 才能用某能力，不是按 OS 权限。

**何时用**

- ✅ Multi-tenant：每个租户拿一组 token
- ✅ 审计：每次 token 使用都有 trace
- ✅ 收窄：subagent 只拿父亲的子集
- ❌ 无 host policy 的快速原型——直接用 `permissionMode` 更简单

**怎么用**

```ts
import { createCapabilityToken } from 'clavue-agent-sdk/sandbox'

const token = createCapabilityToken({
  name: 'repo-read',
  scope: { read: ['./src/**'], write: [], shell: [] },
  ttlMs: 60_000,
})

await runAgentSubagent({
  input: { prompt: '...' },
  context: { ...parentContext, capabilityTokens: [token] },
  runtime: 'worker_thread',
})
```

**要小心什么**

- v1 仍然是 SDK-internal capability check；想配 OS-level（seccomp/landlock）要自己包一层
- Token 有 TTL，过期后调用直接 deny
- 见 `examples/22-capability-tokens.ts`

---

## 13. RAG

**是什么**：`RetrieverInterface` + 两个内置实现（`InMemoryRetriever` / `PgvectorRetriever`）+ graph DSL 里的 `retriever` 节点。

**何时用**

- ✅ 文档问答 / codebase navigation
- ✅ 长期 memory 之外的"动态语料"
- ❌ 几十条 fact 的小知识库——`memory` 模块（结构化 memory + keyword）已够

**怎么用**

```ts
import { InMemoryRetriever } from 'clavue-agent-sdk/rag'

const retriever = new InMemoryRetriever()
await retriever.upsert([
  { id: 'doc1', text: '...', vector: embed('...'), metadata: { source: 'docs/api.md' } },
  // ...
])

// 单独检索
const hits = await retriever.search({ vector: embed('how to use X'), topK: 5 })

// 在 graph 里当节点用
const graph = defineGraph({
  entry: 'retrieve',
  nodes: [
    { kind: 'retriever', id: 'retrieve', retriever, query: (ctx) => ctx.input },
    { kind: 'agent',     id: 'answer',   agent: answerAgent },
  ],
  edges: [{ from: 'retrieve', to: 'answer' }],
})
```

```ts
// pgvector 版本
import { PgvectorRetriever } from 'clavue-agent-sdk/rag'

const r = new PgvectorRetriever({
  client: pgClient,                  // pg.Client 或兼容
  table: 'docs_embeddings',
  vectorColumn: 'embedding',
  textColumn: 'text',
})
```

**要小心什么**

- SDK 不内置 embedding——你传向量进来。配 OpenAI / Cohere / 本地模型自由
- pgvector 走结构化注入（`PgClientLike`），不锁死 `pg`——可以用 `postgres-js` / `drizzle`
- 见 `examples/23-rag-retriever.ts` / `28-rag-graph.ts`

---

## 14. Generative UI（框架无关）

**是什么**：通过 `UiStreamSink`/`UiStreamSource` 把 agent 产出的 UI 描述符流式推到客户端。**不绑 React**——客户端可以是 Vue/Svelte/Solid/原生 DOM。

**何时用**

- ✅ Agent 输出富组件（图表、表单、卡片）
- ✅ 跨框架团队（前后端框架不同）
- ❌ 纯文本对话——`partial_message` 已够

**怎么用**

```ts
import { createUiStreamSink, createUiStreamSource } from 'clavue-agent-sdk/genui'

// agent / 服务端：声明组件 + 推送
const sink = createUiStreamSink()
sink.emit({ component: 'BarChart', props: { data: [1, 2, 3] } })
sink.emit({ component: 'Card', props: { title: 'Result', body: 'OK' } })
sink.close()

// 客户端：消费
const source = createUiStreamSource(transport)
for await (const desc of source) {
  myFrameworkRender(desc.component, desc.props)
}
```

**要小心什么**

- transport 你自己接（WebSocket / SSE / Server-Sent Events）——SDK 只定义协议
- 组件名/props 的 JSON-serializable 是约定——别塞函数引用
- 见 `examples/24-generative-ui.ts`

---

## 15. Voice 适配器

**是什么**：`VoiceRuntime` 抽象 + 三个 stub 适配器（Deepgram / OpenAI Whisper / ElevenLabs）。**provider 无关**，不锁死 OpenAI Realtime。

**何时用**

- ✅ Voice agent / 语音助手
- ✅ 想换 ASR 或 TTS 服务商
- ❌ 真正低延迟的实时语音（<200ms 端到端）——目前 stub 适配器是 HTTP 级，不是 WebSocket Live。生产用要自己实现 streaming WebSocket

**怎么用**

```ts
import { createVoiceRuntime } from 'clavue-agent-sdk/voice'
import { createDeepgramAsrAdapter, createElevenLabsTtsAdapter } from 'clavue-agent-sdk/voice'

const voice = createVoiceRuntime({
  asr: createDeepgramAsrAdapter({ apiKey: process.env.DEEPGRAM_KEY }),
  tts: createElevenLabsTtsAdapter({ apiKey: process.env.ELEVENLABS_KEY }),
})

const transcript = await voice.asr.transcribe(audioBuffer)
const audio = await voice.tts.synthesize(agentText)
```

**要小心什么**

- Stub 适配器走 `FetchLike` 注入——可以替换成 Deepgram Live / OpenAI Realtime WS（**但需要你自己实现**）
- 不在 1.0.1 范围：本地 `whisper.cpp` 二进制运行
- 见 `examples/25-voice.ts` / `30-voice-adapters.ts`

---

## 16. `runIssueWorkflowWithAgent` 真闭环

**是什么**：build → verify → review → fix 真实 LLM 闭环。0.7.x 的 `runIssueWorkflow` 只是空壳（host 注入 callback），1.0.1 引入新签名 `runIssueWorkflowWithAgent` 才真调用 Agent。

**何时用**

- ✅ "把这个 P0 bug 修了"——给 issue 文本 + verifier，loop 自动跑
- ✅ CI 集成：失败的 PR 自动开 fix run
- ❌ 复杂多模块 issue——graph DSL 更合适
- ❌ 不想跑 LLM 的纯协调——用旧 `runIssueWorkflow` 还在

**怎么用**

```ts
import { runIssueWorkflowWithAgent, CommandVerifier } from 'clavue-agent-sdk/workflow'
import { createAgent } from 'clavue-agent-sdk'

const agent = createAgent({ permissionMode: 'acceptEdits' })

const verifier = new CommandVerifier([
  { name: 'tests',     cmd: 'npm test',        timeoutMs: 120_000 },
  { name: 'typecheck', cmd: 'npx tsc --noEmit', timeoutMs: 60_000 },
])

const result = await runIssueWorkflowWithAgent({
  issue: {
    id: 'bug-42',
    title: 'sum(arr) returns NaN for empty array',
    body: 'Expected 0, got NaN. Reproduce: ...',
  },
  cwd: process.cwd(),
  agent,
  verifier,
  maxIterations: 3,
  requiredGates: ['tests', 'typecheck'],
})

console.log(result.status)              // 'completed' | 'failed_gate' | 'max_iterations'
console.log(result.proof_of_work)       // 完整 artifact
```

**要小心什么**

- 0.7.x 的 `runIssueWorkflow` 仍然存在但 `@deprecated`，1.1.0 删除
- `maxIterations` 默认 3，硬上限 10（防成本失控）
- 失败 verifier 输出会喂给下一轮 build prompt——所以**输出要是诊断性的**（exit code + 关键错误行），不要噪声
- 见 `examples/17-issue-workflow-real.ts`

---

## 17. Background AgentJobs

**是什么**：把 agent run 持久化为 AgentJob 记录，进程崩了能 replay。

**何时用**

- ✅ 长任务（>5 分钟）
- ✅ 跨 process restart 的 idempotent 操作
- ✅ Batch 调度
- ❌ 短同步任务——直接 `run()`

**怎么用**

```ts
import { createAgentJob, runAgentJob, getAgentJob } from 'clavue-agent-sdk'

// 创建（持久化到 ~/.clavue-agent-sdk/jobs/）
const job = await createAgentJob({
  kind: 'subagent',
  prompt: 'Long task ...',
  description: 'nightly summary',
})

// 在另一进程 / 重启后取回 + 跑
runAgentJob(job.id, async (signal) => {
  const r = await agent.run('Long task ...', { abortSignal: signal })
  return { output: r.text, trace: r.trace }
})

const updated = await getAgentJob(job.id)
console.log(updated.status)  // queued / running / completed / failed / stale
```

**要小心什么**

- `runtimeNamespace` 隔离不同租户的 job 存储
- Heartbeat 默认 10 秒，超时进 `stale` 状态
- `replayAgentJob(id, runner)` 可以重跑 stale/failed/cancelled

---

## 18. Quality Gates + Proof-of-Work

**是什么**：标准化的"质量证明" artifact，可以挂在 run / job / issue workflow 上。

**何时用**

- ✅ Compliance / 审计
- ✅ 给下游 reviewer / 签发流程消费
- ✅ Self-improvement loop 评估输入

**怎么用**

```ts
const result = await run({
  prompt: '...',
  options: {
    quality_gates: [{ name: 'tests', status: 'pending' }],
    qualityGatePolicy: { required: ['tests'], failStatuses: ['failed', 'pending'] },
  },
})
// 工具调用过程中可以注入 evidence / quality_gates
console.log(result.quality_gates)
```

```ts
import { createProofOfWork } from 'clavue-agent-sdk'

const artifact = createProofOfWork({
  target: { kind: 'run', id: result.id, title: 'Build feature X' },
  required_gates: ['tests', 'typecheck'],
  evidence: result.evidence,
  quality_gates: result.quality_gates,
})
// 写到任意 storage：CI artifact / S3 / DB
```

**要小心什么**

- `PROOF_OF_WORK_SCHEMA_VERSION = '1.0.0'`——public surface
- Required gate 缺失/未达 status 会让 run 标记 `error_quality_gate_failed`

---

## 19. Memory

**是什么**：结构化 memory（key-value + tags + repoPath/sessionId 索引）+ 1.0.1 加的向量检索 adapter。

**何时用**

- ✅ "这个项目用 ESM"、"用户偏好 TypeScript strict" 这类长期 fact
- ✅ Self-improvement 沉淀
- ❌ 大规模文档问答——用 RAG（§13）

**怎么用**

```ts
import { saveMemory, queryMemories } from 'clavue-agent-sdk'

await saveMemory({
  id: 'pref-1',
  type: 'project',
  scope: 'session',
  title: 'Use ESM imports',
  content: 'All relative imports use .js extension under NodeNext.',
  tags: ['typescript', 'esm'],
  confidence: 'high',
})

const hits = await queryMemories({ text: 'how to import?', tags: ['typescript'] })

// 让 Agent 自动注入相关 memory
const agent = createAgent({
  memory: {
    enabled: true,
    policy: { mode: 'autoInject' },     // 或 'brainFirst'（更激进）
  },
})
```

**要小心什么**

- 默认按 keyword + repo/session 过滤，不是语义检索——用向量需要传 `embedder`
- `autoInject` 会消耗 token 预算——监控 `usage`

---

## 20. Schema Versions 与 Trace

**是什么**：5 + 2 个 schema version 常量。public surface，下游消费者要监控。

```ts
import {
  SDK_EVENT_SCHEMA_VERSION,
  AGENT_RUN_RESULT_SCHEMA_VERSION,
  AGENT_RUN_TRACE_SCHEMA_VERSION,
  AGENT_JOB_RECORD_SCHEMA_VERSION,
  MEMORY_TRACE_SCHEMA_VERSION,
  PROOF_OF_WORK_SCHEMA_VERSION,
  CONTROLLED_EXECUTION_CONTRACT_VERSION,
} from 'clavue-agent-sdk/contracts'
```

1.0.1 全部仍是 `'1.0.0'`——添加可选字段不算 bump，只有破坏性才 bump。

**何时用**

- 在你的 trace consumer / artifact storage 里硬编码版本检查
- 升级 SDK 后比对，schema bump 就跟随升级 reader

---

## 21. List caches & invalidation hatches

**是什么**：四个 list 类型的持久化读路径都有 in-memory cache，写路径自动 invalidate，外部写者用 `invalidateXxxCache(dir?)` 公开导出。详见 [`tier-a-summary.md`](./tier-a-summary.md)。

| Layer | List API | Public escape hatch |
|---|---|---|
| Memory | `listMemories` / `queryMemoryMatches` | `invalidateMemoryCache(dir?)` |
| AgentJobs | `listAgentJobs` / `summarizeAgentJobs` | `invalidateAgentJobsCache(dir?)` |
| Sessions | `listSessions` | `invalidateSessionCache(dir?)` |
| IssueWorkflow runs | `listIssueWorkflowRuns` | `invalidateIssueWorkflowRunsCache(dir?)` |

**何时用**

- ✅ 默认零成本——SDK 写路径会自动 invalidate
- ✅ Sibling 进程也写同一 dir → 调对应 hatch 同步 view
- ✅ 维护脚本批量 raw-write 后调 `invalidateXxxCache()`（无 arg = 清所有 dir）

**怎么用**

```ts
import {
  invalidateMemoryCache,
  invalidateAgentJobsCache,
  invalidateSessionCache,
  invalidateIssueWorkflowRunsCache,
} from 'clavue-agent-sdk'

// Sibling 进程对 memory dir 做了 raw 写：
invalidateMemoryCache('/path/to/.clavue-agent-sdk/memory')

// 清所有进程内 cache（测试 setup / 全局热重载）：
invalidateMemoryCache()
invalidateAgentJobsCache()
invalidateSessionCache()
invalidateIssueWorkflowRunsCache()
```

**要小心什么**

- Cache 是 module-scoped，跨 worker_thread 不共享——每个 V8 isolate 独立
- 返回值通过 `slice()` / `map(clone)` 隔离，caller 可以放心 mutate
- AgentJobs 的 stale-refresh 仍每次跑，cache 只 saves disk I/O 不 saves status check

---

## 还没覆盖到的 / FAQ

- **MCP servers**：`mcpServers` 选项 + `createSdkMcpServer` 见 `examples/06-mcp-server.ts` / `11-custom-mcp-tools.ts`
- **Skills**：bundled skills + 自定义见 `examples/12-skills.ts` 与 `src/skills/`
- **CLI**：`npx clavue-agent-sdk --help` 或见 README quickstart
- **Web demo**：`npm run web` 起本地 demo server

如果某个能力没在本文档覆盖到，先看 `examples/` 编号最相近的那个；找不到就开 issue，会被纳入下个 minor 的文档。
