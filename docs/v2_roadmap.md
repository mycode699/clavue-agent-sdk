# Clavue Agent SDK — v2 路线图

> **版本目标**: 1.0.0（marker：从 0.x 进入稳定 major）
> **配套文档**: [v2_audit_report.md](./v2_audit_report.md) · [v2_architecture.md](./v2_architecture.md)
> **基准日期**: 2026-05-08
> **预估工期**: 8-12 周（单人全职）/ 4-6 周（双人配合 + reviewer）

---

## 里程碑总览

```
M0  发布说明草案 + 兼容层规划         (1 周)
M1  Streaming + 真实 Token 计数        (2 周)   ← 解锁所有性能优化
M2  Pipeline 重构                       (2 周)   ← 解锁可测试性
M3  Anthropic Caching + 修复死代码    (1 周)   ← 立刻见效的 ROI
M4  Issue Workflow 真实闭环            (2 周)   ← 名实相符
M5  Subpath Exports + Telemetry        (1 周)
M6  Subagent 隔离 + Middleware         (1 周)
M7  迁移文档 + benchmark + 1.0.0        (1 周)
```

每个里程碑以可独立发布的 minor version 收尾（`0.8.0` … `0.14.0` → `1.0.0`）。

---

## M0 · 发布草案与兼容层规划（第 1 周）

### 交付物

- `CHANGELOG.md` 起 1.0.0 frame
- `docs/v2_breaking_changes.md` —— 写出所有计划中的破坏性变更
- 标注 `@deprecated` 的现有 API 清单
- v1→v2 兼容层骨架（`src/v1-compat/`）

### 破坏性变更清单（草案）

| 项 | v1 | v2 | 兼容层 |
|---|---|---|---|
| `AgentOptions.jsonSchema` | 存在但无效 | 删除 | 接受输入并 warn，3 月后删 |
| `runIssueWorkflow` 签名 | `evaluateRole` 回调 | `agent` + `verifier` 必填 | 旧函数标 deprecated，保留 1 个 minor |
| SDK event types | 无 partial | 新增 partial | 新增字段，旧字段保留 |
| `AGENT_RUN_TRACE_SCHEMA_VERSION` | `1.0.0` | `2.0.0` | trace 内嵌 v1 字段做 alias |
| Provider 接口 | `createMessage` only | `stream` + `create` | `create` = `collect(stream())` 自动 |
| `IssueWorkflowJobRef` 内嵌结构 | 当前 | 新增 `agent_run_id` | 字段加可选，旧消费者无感 |

### 验收

- [ ] `docs/v2_breaking_changes.md` review by maintainer
- [ ] 兼容层目录结构创建并加 README
- [ ] 0.8.0-rc.0 发布到 npm dist-tag `next`

---

## M1 · Streaming + Token Counter（第 2-3 周）

### 子任务

1. **新 Provider 接口** (`src/providers/types.ts`)
   - 增加 `stream(params): AsyncIterable<StreamChunk>` 必选
   - `create(params)` 默认实现 = `collectStream(stream(params))`
   - 现有 Anthropic / OpenAI provider 实现 stream
2. **Anthropic streaming**
   - 用 `client.messages.stream(...)`
   - 把 `MessageStreamEvent` 转换为内部 `StreamChunk`
   - 处理 `tool_use` 增量 JSON 拼装
3. **OpenAI streaming**
   - SSE parser
   - 复用现有 `/responses` capability gate
4. **Engine 消费 partial**
   - `engine.ts` 在 `submitMessage` 中 emit `SDKPartialAssistantMessage`
   - 受 `AgentOptions.includePartialMessages` 控制（默认 `true`，破坏性，需 changelog）
5. **Token Counter**
   - `src/core/tokens/counter.ts`
   - `ApiBackedCounter`（Anthropic `client.messages.countTokens`）
   - `HeuristicCounter` with EMA 校准
   - `TiktokenCounter` 作为可选 peer dep（懒加载）
6. **替换 estimateTokens 调用**
   - `compact.ts`、`tokens.ts` 改用 counter 实例
   - 移除硬编码 `AUTOCOMPACT_BUFFER_TOKENS`，改为模型特征派生

### 验证

- 新增 `tests/v2/streaming/` 套件
- benchmark：TTFT p50 从 ~3000ms 降到 <500ms（依赖网络）
- 手测 `examples/01-simple-query.ts` 应能看到逐字输出

### 风险

- 第三方 base URL（OpenRouter 等）SSE 行为不一致 → capability gate 增加 `streaming` 探测
- countTokens 在某些代理上 404 → 回退 HeuristicCounter

### 验收

- [ ] tests:v2 全绿
- [ ] benchmark 报告附在 PR
- [ ] 0.9.0 release

---

## M2 · Pipeline 重构（第 4-5 周）

### 子任务

1. **创建 stage 接口**（`src/core/pipeline/types.ts`）
2. **拆 7 个 stage**:
   - `Guard`（abort + budget + maxTurns）
   - `Compact`（auto + micro）
   - `Render`（system prompt + memory inject）
   - `Call`（ResilientCall: retry + fallback + overflow）
   - `Stream`（emit partials + collect）
   - `Tools`（ToolRouter: batch + execute + permission）
   - `Decide`（next/retry/finish）
3. **Pipeline 编排器**（60-80 行）
4. **保留 legacy engine**（`src/engine.legacy.ts`），通过 `AgentOptions._engine: 'v1' | 'v2'` 切换，默认 `v2`，下个 minor 删 v1
5. **每个 stage 单测覆盖率 ≥85%**
6. **trace schema 升级到 2.0.0**（stages 替代 inline turns）

### 验证

- 所有现有 examples 在 v2 引擎跑通
- `tests/compat/` 断言行为等价
- 线性测试：单测 stage 不需要真 provider

### 风险

- 行为微差（emit 顺序、错误格式）→ compat tests 暴露后逐项对齐
- 性能回退（stage 切换有开销）→ benchmark 守门 `<2ms` 总开销

### 验收

- [ ] 0.10.0 release
- [ ] engine LoC 从 1537 降到 <500（hot path）

---

## M3 · Anthropic Caching + 死代码修复（第 6 周）

### 子任务

1. **Anthropic prompt caching**
   - System prompt 末段加 `cache_control: { type: 'ephemeral' }`
   - Tools 数组末项 cache_control
   - 第二条 user message（早期上下文）cache breakpoint
   - 自动管理最多 4 个 breakpoints
2. **OpenAI prompt caching**
   - GPT-4o 自动 caching（无需显式标记），但要确保 prompt 前缀稳定
3. **`jsonSchema` 实装或删除**（决策：实装）
   - Anthropic: 用 `tool_choice: { type: 'tool', name: ... }` + Zod
   - OpenAI: 用 `response_format: { type: 'json_schema' }`
   - 引入 `outputSchema: z.ZodSchema`（兼容 jsonSchema 字段）
4. **`shouldUseFallbackModel` 一致性修复**（审计逻辑疑点 A）
5. **Skill `forked` 状态完整支持**（审计逻辑疑点 B）

### 验证

- benchmark：10-turn run 成本从 1.0× 降到 <0.30×
- jsonSchema 测试用 5 种 schema 形态（object/array/union/optional/nested）

### 验收

- [ ] 0.11.0 release
- [ ] cost benchmark 报告

---

## M4 · Issue Workflow 真实闭环（第 7-8 周）

### 子任务

1. **新签名 `runIssueWorkflow`**（v2_architecture.md 第 4 节）
2. **`Verifier` 接口 + 默认实现**
   - `CommandVerifier`（pnpm test、pnpm lint 等）
   - `RetroVerifier`（接现有 retro 系统）
3. **真实 Builder/Reviewer/Fixer prompts**（写入 bundled skills）
4. **end-to-end example**: `examples/17-issue-workflow.ts`
   - 给一个 inline issue
   - 用 mock test runner 模拟 verifier
   - 跑 3 轮直到 passing
5. **v1 函数标 `@deprecated`**

### 验证

- e2e test 用 `tests/v2/workflow/issue-real.test.ts`
- 跑真实 LLM（cost ~$0.50/run）做一次 manual smoke test

### 风险

- LLM 改代码引入语法错误 → builder 后立刻 typecheck，失败回滚
- 无限 fix 循环 → 强制 `maxIterations` 默认 3

### 验收

- [ ] 0.12.0 release
- [ ] issue-workflow 文档重写

---

## M5 · Subpath Exports + Telemetry（第 9 周）

### 子任务

1. **`package.json#exports`** 子路径
2. **重组目录**:
   ```
   src/core/      ← Agent, run, query, pipeline
   src/tools/     ← 现有 tools（按主题分子文件）
   src/contracts/ ← 公开类型
   src/workflow/  ← issue-workflow, workflow-contract
   src/retro/     ← 现有 retro
   src/testing/   ← 测试辅助（mock provider 等）
   ```
3. **Telemetry 接口** + no-op 默认 + OTel adapter（peer dep）
4. **每个 stage、tool、provider call 开 span**

### 风险

- 重组目录可能触发下游 import 路径破坏 → 主入口 re-export 全部，不破坏

### 验收

- [ ] 0.13.0 release
- [ ] OTel adapter 用 jaeger 跑通 demo

---

## M6 · Subagent 隔离 + Middleware（第 10 周）

### 子任务

1. **Subagent runtime 选项**: `inprocess` / `worker_thread`
2. **工具继承收窄**（默认 destructive=true 不继承）
3. **Budget 传递**（subagent.maxUsd ≤ parent 剩余预算）
4. **Middleware 层** + 内置 3 个：
   - `rateLimit`
   - `audit`
   - `piiScrubber`
5. **examples**: `examples/18-subagent-isolation.ts`、`examples/19-middleware.ts`

### 验收

- [ ] 0.14.0 release
- [ ] worker_thread subagent 在 abort 时 <500ms 停止

---

## M7 · 迁移文档 + Benchmark + 1.0.0（第 11-12 周）

### 子任务

1. **迁移指南**: `docs/v1-to-v2-migration.md`
2. **基准报告**: `docs/v2_benchmark_report.md`（v1 vs v2 实测数字）
3. **README 重写**（拆成主题页）
4. **examples/web 升级**（用流式 + 中间件 demo）
5. **删除所有标 @deprecated 满 90 天的 API**
6. **1.0.0 release**

### 1.0.0 验收清单

- [ ] 全部测试绿（v1 compat + v2 unit + integration）
- [ ] benchmark 数字达成（见下表）
- [ ] 至少 3 个外部 design partner 的 dogfood 反馈
- [ ] CHANGELOG 完整
- [ ] semver 标记，npm 发布

---

## Benchmark SLO（1.0.0 必须达成）

| 指标 | v1 (0.7.5) | v2 1.0.0 目标 | 测量方法 |
|---|---|---|---|
| TTFT p50 | ~3000ms | **<500ms** | 流式首 chunk 时间 |
| TTFT p95 | ~6000ms | **<1500ms** | |
| 10-turn cost ratio | 1.0× | **<0.30×** | Anthropic caching |
| Token estimate error | ±35% | **±5%** | vs response.usage |
| Engine hot-path LoC | 1537 | **<500** | wc -l on submitMessage 等价物 |
| Stage 单测覆盖 | 0% | **>85%** | nyc/c8 |
| Tool dispatch overhead | ~未测 | **<2ms** | router 调度 1000 次平均 |
| Subagent abort latency | ~未测 | **<500ms** | abort 到完全停止 |
| `npm run test` wall time | ~未测 | **<60s** | CI 平均 |

---

## 风险与对冲

| 风险 | 概率 | 影响 | 对冲 |
|---|---|---|---|
| Anthropic streaming API 变化 | 低 | 高 | capability gate 探测；fallback create() |
| OpenAI Responses API gateway 不支持 | 中 | 中 | fallback /chat/completions（已有） |
| tiktoken peer dep 装机率低 | 中 | 低 | HeuristicCounter 默认即可 |
| 下游依赖 v1 死代码（jsonSchema） | 低 | 中 | 兼容层 + warn 1 个 minor 再删 |
| Pipeline 性能回退 | 低 | 高 | benchmark gate；stage 内联热路径 |
| 工期延误（实际 >12 周） | 中 | 中 | M3 (caching) 优先合并，单独发 0.x.0 |
| Issue workflow 真实化导致用户成本激增 | 中 | 中 | 默认 maxIterations=3，verifier 必须显式注入 |

---

## 优先级与并行化

```
关键路径 (顺序)：
  M0 → M1 → M2 → M3 → M4 → M7

可并行：
  M5 (子路径导出)     与 M2 后期并行
  M6 (subagent + mw)  与 M4 并行（不同模块）
```

如果只能做 3 件事，按 ROI 排序：
1. **M3 Anthropic caching** —— 1 周工作，立即省 70% 成本
2. **M1 streaming** —— 用户体感最强
3. **M4 真实 issue workflow** —— 解决"名实不符"的 P0 问题

---

## 沟通与发布

每个 minor release：
- npm publish 到 `next` tag → 7 天观察 → promote 到 `latest`
- GitHub release notes 包含：变更、breaking、迁移片段、benchmark
- 主要变更同步到 README "What's new in 0.x" 段

1.0.0 前 4 周开 beta：
- `npm install clavue-agent-sdk@beta`
- 招募 3-5 个外部 dogfood 用户
- 每周 review 反馈，必要时调整路线

---

## 决策待定（需要 maintainer 输入）

> 在 M0 完成前必须决定：

1. **`jsonSchema` 是实装还是删除？**
   - 实装：M3 +3 天工作量，但解决名实不符
   - 删除：标 deprecated，简化代码
   - **建议**：实装。"顶级 SDK" 必须支持结构化输出。

2. **是否引入 `tiktoken` 作为 peer dep？**
   - 引入：OpenAI token 估算精确，安装体积 +2MB
   - 不引入：维持零依赖，估算用 EMA 自动校准
   - **建议**：peer dep + 懒加载。零依赖原则不破坏，但用户可以 `npm i tiktoken` 升级精度。

3. **Pipeline v1 引擎保留多久？**
   - 保留 1 个 minor：用户有 4-6 周时间反馈
   - 立刻删除：减少维护负担
   - **建议**：保留 1 个 minor，next minor 删除。

4. **是否引入 `worker_threads` 隔离？**
   - 引入：真实隔离，但运行环境要求高（Node 18+ 已有）
   - 不引入：保持 inprocess，文档 caveat
   - **建议**：引入但设为 opt-in（默认 inprocess）。

---

## 一句话总结

**v2 不是"加 N 个新功能"，而是把现有 30+ 功能从"能跑"变成"能证明"。** 修完 17 个审计问题后，"clavue-agent-sdk" 才真正配得上 README 上自称的"production-oriented"。

实施顺序按 ROI：M3 (caching) → M1 (streaming) → M4 (real workflow) → 其余。
