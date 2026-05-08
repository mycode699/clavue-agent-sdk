# Clavue Agent SDK — v2 收尾 实现切片清单（scope-worker 拆分）

> 撰写日期：2026-05-08
> 作者：scope-worker（mao 监督下，仅 docs/ 写权限）
> 基线：`84a9940 chore(release): v0.8.0`，working tree 已 ship `e74a88b feat(v3): seven-axis capability layer landed` + `25bc5b6 docs(v3): RFC + upgrade chain`
> 测试基线：472/472，`tsc --noEmit` clean
> 关联：[v2_audit_report.md](./v2_audit_report.md) · [v2_roadmap.md](./v2_roadmap.md) · [v3_rfc.md](./v3_rfc.md) · [v2_v3_v4_upgrade_chain.md](./v2_v3_v4_upgrade_chain.md)

## 文档目的

为 8 个并发 worker 火力全开多线程开发提供**最小可独立落地切片**。每个切片：

- **owned files** 清晰，不与其他 worker 重叠；
- 有可验证的 acceptance（命令 + 期望输出）；
- 标注依赖与风险，避免冲突合并。

mao 监督下 scope-worker 只能 read/analyze/document；本文不修改 src/。具体 src 修改由其他 worker 在自己 worktree 里执行。

---

## 当前未完成的 P1/P2/P3 项目（来自 v2_audit_report.md 对账表）

| ID | 状态 | 影响域 | scope-worker 切片建议 |
|----|------|--------|---------------------|
| P1-1 M2 pipeline 拆分 | 🟡 部分修（helpers 已抽出，dispatcher 未拆） | `src/engine.ts` | 切片 A |
| P1-4 retry/fallback/compact 三路径未统一 | ❌ 未修 | `src/engine.ts:307-435` | 切片 B |
| P1-5 hook 系统无 middleware 组合 | ❌ 未修 | `src/hooks.ts` `src/engine.ts:705-720` | 切片 C |
| P1-6 subagent 无真实隔离 | ❌ 未修 | `src/tools/agent-tool.ts` `src/agent-jobs.ts` | 切片 D |
| P1-7 memory 评分无向量 | ❌ 未修 | `src/memory.ts` `src/engine.ts:141-161` | 切片 E |
| P1-8 workflow 三套契约并行 | ❌ 未修 | `src/workflow-contract.ts` `src/orchestration-policy.ts` `src/issue-workflow.ts` | 切片 F |
| P2-1 token counter 无 API warmup | ❌ 未修 | `src/engine.ts` token 路径 | 切片 G |
| P2-2 工具并发分组未保留模型意图 | ❌ 未修 | `src/engine.ts:679-` `executeTools` | 切片 H |
| P2-3 file state cache 与 Read 工具未联动 | ❌ 未修 | `src/tools/file-*.ts` | 切片 I |
| P2-4 AgentOptions 40+ 字段无 profile 简写 | ❌ 未修 | `src/types/agent.ts` `src/runtime-profiles.ts` | 切片 J |
| P3-1 README 77KB 单文件 | ❌ 未修 | `README.md` | 切片 K（docs-only，scope-worker 自己可做） |
| P3-2 CLAUDE.md/clavue.md/AGENTS.md 职责重复 | ❌ 未修 | 三份根目录 md | 切片 L（docs-only） |

---

## 切片 A · M2 Pipeline 拆分（owner: 任一 engine-worker）

### 目标

把 `QueryEngine.submitMessage`（当前 `src/engine.ts:1163` 行总长，submitMessage ~260 行）拆成纯 stage 函数的管道，使每个 stage 可单独 mock 测试。

### Stage 设计

```
TurnContext = {
  turn: number,
  messages: Message[],
  budget: BudgetTracker,
  compactState, skillState, toolEnv, abortSignal
}

Pipeline:
  PreTurnGuards(ctx)        // abort + budget + permission_mode 检查
  ↓
  CompactDecision(ctx)      // autoCompact + microCompact 判定+执行
  ↓
  Render(ctx)               // buildSystemPrompt + tool 列表 + 消息渲染
  ↓
  ModelCall(ctx, request)   // withRetry → fallback → max_output_tokens 恢复
  ↓
  PostModel(ctx, response)  // usage 累计 + emit assistant
  ↓
  ToolDispatch(ctx)         // 提取 tool_use → 并发分组 → 执行
  ↓
  ResultCollect(ctx, results)
  ↓
  NextTurnDecision(ctx) → 'continue' | 'stop' | 'error'
```

### Owned files

新增（worker 写）：
- `src/engine/pipeline/turn-context.ts`
- `src/engine/pipeline/pre-turn-guards.ts`
- `src/engine/pipeline/compact-decision.ts`
- `src/engine/pipeline/render.ts`
- `src/engine/pipeline/model-call.ts`
- `src/engine/pipeline/post-model.ts`
- `src/engine/pipeline/tool-dispatch.ts`
- `src/engine/pipeline/result-collect.ts`
- `src/engine/pipeline/next-turn-decision.ts`
- `tests/engine-pipeline.test.ts`（每 stage 至少 1 个单测）

修改：
- `src/engine.ts` —— `submitMessage` 改为 60-80 行的管道编排，引用 stage 函数。

### Acceptance

- `npx tsc --noEmit` 通过；
- 472 测试全部仍 pass；新增 stage 单测 ≥ 9；
- `wc -l src/engine.ts` 从 1163 降至 ≤ 700；
- `src/engine/pipeline/*.ts` 每文件 ≤ 200 行；
- 行为一致：`tests/streaming.test.ts` `tests/permissions.test.ts` `tests/quality-gate-helpers.test.ts` 全绿。

### 风险

- 高。`submitMessage` 是热路径；任何 emit 顺序或 hook 时机偏移都可能改变下游 SDKMessage 流。
- 需要先固定 phase emit 顺序为 invariant，并以快照测试守护。

### 依赖

无前置；但**与切片 B、C 强冲突**——这三个都改 `src/engine.ts:300-1000`，必须串行或在同一个 worktree 执行。

---

## 切片 B · 统一 ResilientCall（owner: 任一 engine-worker）

### 目标

把 `withRetry`（内层退避）、fallback 调用（外层、不 retry）、prompt_too_long compact 恢复（最外层）三段逻辑收拢到单一 `resilientCall` 函数。

### 当前调用点（已定位）

```
src/engine.ts:369  response = await withRetry(() => createModelMessage(requestModel))
src/engine.ts:378  if (!fallbackModel || isAbortError(primaryErr) || abortSignal?.aborted) throw
src/engine.ts:381  if (isPromptTooLongError(primaryErr)) throw
src/engine.ts:384  if (!shouldUseFallbackModel(primaryErr)) throw
src/engine.ts:388  response = await createModelMessage(fallbackModel)   // ← 不经过 retry
src/engine.ts:423  if (isPromptTooLongError(err) && !compactState.compacted) compact + restart turn
```

### Owned files

新增：
- `src/engine/resilient-call.ts`（单文件，~120 行）
- `tests/resilient-call.test.ts`

修改：
- `src/engine.ts:309-435` —— 替换三层 try/catch 为单次 `resilientCall({ primary, fallback, onContextOverflow, retry })` 调用。
- `src/engine/error-helpers.ts` —— 把 `isRetryableError` `shouldUseFallbackModel` 的语义重叠收敛为**一个**判定函数 + 路由表。

### Acceptance

- `tests/retry.test.ts` `tests/model-fallback.test.ts` 仍绿；
- 新增测试覆盖 4 个矩阵：(primary 503 + fallback 缺失) (primary 503 + fallback 503) (primary prompt_too_long + compact 已触发过) (abort 在 fallback 过程触发)；
- `src/engine.ts` 调用点从 ~60 行降至 ~10 行。

### 风险

中。修改了 retry 行为，可能改变长任务在临时网络抖动下的成功率；需 ` benchmark.test.ts` 守护。

### 依赖

**与切片 A 强冲突**（同改 engine.ts 中段）。建议合并到一个 worker。

---

## 切片 C · Hook Middleware 层（owner: 独立 hooks-worker，与 A/B 冲突低）

### 目标

在不破坏现有 7 个 event hooks 的前提下，新增 `agent.use(middleware)` API，提供 koa 风格 `(ctx, next) => Promise<void>` 中间件链。

### Owned files

新增：
- `src/middleware/types.ts`
- `src/middleware/runtime.ts`（compose + dispatch，~80 行）
- `tests/middleware.test.ts`

修改：
- `src/agent.ts` —— 增加 `use(mw)` 方法，把 mw chain 在 `submitMessage` 入口/出口包裹。
- `src/types/agent.ts` —— 暴露 `Middleware` `MiddlewareContext` 类型。

### Acceptance

- 提供 3 个 example middleware：rate-limit、audit-log、PII-redact；
- 5 个测试：register 顺序、early return、错误传播、与现有 hook 共存、async 资源清理。

### 风险

低。新 API、新文件，不动 hook 逻辑。

### 依赖

无；可与 A/B/D 并行。但若与 A 同一时间合并，`agent.ts` 入口需要 rebase。

---

## 切片 D · Subagent 隔离 runtime 字段（owner: subagent-worker）

### 目标

为 `Subagent` / `runAgentSubagent` 增加 `runtime: 'inprocess' | 'worker_thread'` 字段，默认仍 inprocess，但**自动收窄工具集**为 parent 子集，并通过 `AbortController` 链传播 abort。

### Owned files

修改：
- `src/tools/agent-tool.ts` —— 派生 toolset 验证：`subagentTools ⊆ parentTools`；不满足报错或自动取交集（按 option 控制）。
- `src/agent-jobs.ts` —— 在 spawn subagent 时 fork AbortController，parent abort → child abort。
- `src/types/agent.ts` —— 增加 `Subagent.runtime` 字段。

新增：
- `src/runtime/worker-thread-subagent.ts`（worker_thread runtime 实现，可阶段 1 仅留 stub + throw `not implemented`，阶段 2 真实落地）
- `tests/subagent-isolation.test.ts`

### Acceptance

阶段 1（本切片）：
- 工具白名单传递性：subagent 显式声明 `Bash` 而 parent 没有 → 抛错；
- abort 传播：parent abort 后 100ms 内 child 的 in-flight tool 收到 signal；
- runtime: 'worker_thread' 抛 `NotImplementedError`，但类型签名稳定。

阶段 2（本切片**不**含）：worker_thread 真实落地。

### 风险

中。abort 传播改 abort 路径，要回归 `tests/runtime-isolation.test.ts`。

### 依赖

无；可与 A/B/C 并行。

---

## 切片 E · Memory 向量检索可选 adapter（owner: memory-worker）

### 目标

`MemoryConfig` 新增 `retrieval: 'keyword' | 'vector' | 'hybrid'` 与 `embedder: EmbedderLike`，keyword 仍是默认零依赖。

### Owned files

修改：
- `src/memory.ts` —— `queryMemoryMatches` 接受 strategy 参数。
- `src/types/memory.ts` —— `MemoryConfig` 加 retrieval/embedder 字段；`EmbedderLike` 接口。
- `src/engine.ts:141-161` —— 把 `getMatchedMemoryFields` 改为 strategy-aware（保持 keyword 默认行为不变）。

新增：
- `src/memory/embedder-adapter.ts`（结构化注入接口，零依赖）
- `tests/memory-vector.test.ts`（mock embedder）

### Acceptance

- 默认 keyword 行为 0 改变（`tests/memory.test.ts` `tests/memory-integration.test.ts` 不动）；
- `retrieval: 'vector'` + mock embedder 能查出 keyword 找不到的同义词案例；
- `retrieval: 'hybrid'` 在两路评分下取并集 top-k。

### 风险

低。零依赖默认路径不变。

### 依赖

可与所有切片并行。

---

## 切片 F · 统一 WorkItem 抽象（owner: workflow-worker）

### 目标

`WorkflowContract` / `OrchestrationIssue` / `IssueWorkflowRecord` 三套数据共用一个 `WorkItem` 核心结构（id / title / acceptance / status / evidence / links），原有结构作为 view 层向后兼容。

### Owned files

新增：
- `src/workflow/work-item.ts`（核心类型 + 转换器）
- `tests/work-item.test.ts`

修改（小幅、保留旧 export）：
- `src/workflow-contract.ts` —— `parseWorkflow` 返回 `{ contract, asWorkItem }`
- `src/orchestration-policy.ts` —— `OrchestrationIssue` 加 `toWorkItem()` 方法
- `src/issue-workflow.ts` —— `IssueWorkflowRecord` 加 `toWorkItem()` 方法

### Acceptance

- 三个模块的现有测试 0 改动全绿；
- 新测试：同一 WorkItem 在三种 view 间往返一致。

### 风险

低-中。旧 API 保留；只是增加新一致性层。但若有宿主依赖 `WorkflowDefinition` 字段顺序，需 changelog 标注新字段。

### 依赖

无；可与所有切片并行。

---

## 切片 G · Token Counter API Warmup（owner: token-worker）

### 目标

`tokens.ts` 已经有 CJK/code/JSON 启发式（P0-3 修过）；本切片增加可选的 `ApiBackedCounter`：首次调用时拉一次 `client.messages.countTokens` 校准 EMA 系数表。

### Owned files

修改：
- `src/engine.ts` 的 token 路径（`countMessageTokens` 等调用点）注入 counter 实例。
- `src/types/token-usage.ts` —— `TokenCounter` 接口（如未存在）。

新增：
- `src/tokens/api-counter.ts`
- `src/tokens/heuristic-counter.ts`（从现有 tokens.ts 抽出，保持函数 API）
- `tests/token-counter.test.ts`

### Acceptance

- 默认仍是 heuristic，零依赖；
- `counter: new ApiBackedCounter(client)` 在示例中 warmup 后偏差 < 5%。

### 风险

低。Provider 接口已暴露 `countTokens`。

### 依赖

无。

---

## 切片 H · 工具并发保留模型意图（owner: tools-worker）

### 目标

`executeTools` 当前把所有 read-only 一并并发，把 mutation 串行。问题：模型如果想"先查 A 再决定查 B" 的因果链，会被并发打散。修复：尊重 tool_use 出现顺序，只在**连续 read-only**段并发。

### Owned files

修改：
- `src/engine.ts:679-` `executeTools`
- `tests/tools.test.ts` 增加因果顺序测试。

### Acceptance

- 现有测试全绿；
- 新测试：交替 read/write 序列产生 N 个分组而非 2 个。

### 风险

低-中。可能让原本快的并发变慢；需要 benchmark 守护。

### 依赖

**与切片 A 弱冲突**（都在 engine.ts，但 A 改 submitMessage、本切片改 executeTools）。可分别 PR。

---

## 切片 I · File State Cache 与 Read 工具联动（owner: tools-worker）

### 目标

Edit 工具校验 mtime 时使用 cache；Read 工具更新 cache。当前两者各自维护副本。

### Owned files

修改：
- `src/tools/file-read.ts` `src/tools/file-edit.ts`（具体路径以 `src/tools/` 实际文件为准）
- `tests/tools.test.ts`

### Acceptance

- mtime 校验失败时 Edit 拒绝并提示用户重新 Read；
- 现有测试全绿。

### 风险

低。

### 依赖

无。

---

## 切片 J · Runtime Profiles 简写（owner: api-worker）

### 目标

`AgentOptions` 40+ 字段太散；把常见组合包装成 profile：`'autonomous' | 'interactive' | 'sandboxed' | 'minimal'`。

### Owned files

修改：
- `src/runtime-profiles.ts` 增加 4 个预设
- `src/agent.ts` 在 `createAgent` 入口接受 `profile` 字段，与具体字段做 merge（具体字段优先）

### Acceptance

- `createAgent({ profile: 'minimal' })` 等价于禁用 memory/skills/hooks 的等长配置；
- 5 个测试覆盖 4 profile + 1 override。

### 风险

低。

### 依赖

无。

---

## 切片 K · README 拆分（owner: scope-worker，**docs-only，可立即落地**）

### 目标

`README.md` 当前 82920 字节、单文件。拆为：
- `README.md`（quickstart + 3 个例子 + 链接，≤ 300 行）
- `docs/usage/configuration.md`
- `docs/usage/tools-and-mcp.md`
- `docs/usage/skills-and-hooks.md`
- `docs/usage/workflows.md`
- `docs/usage/memory-and-rag.md`
- `docs/usage/voice-and-genui.md`

### Owned files

仅 `README.md` + `docs/usage/*.md`（全部在 mao 监督允许的 docs/ 下）。

### Acceptance

- `wc -l README.md` ≤ 300；
- 每个 usage doc 自包含可运行例子；
- 顶层 README 链接到所有 usage doc，不丢任何现有内容。

### 风险

低。纯文档。

### 依赖

无。**这是 scope-worker 唯一可以自己执行的切片**。

---

## 切片 L · 三份 root md 职责澄清（owner: scope-worker，**docs-only**）

### 目标

`CLAUDE.md` `clavue.md` `AGENTS.md` 三份职责重叠。建议：

- `clavue.md`：Clavue `/init` 自动重写，**不要手写**长期内容；
- `AGENTS.md`：通用 agent 协议入口，简短；
- `CLAUDE.md`：Claude Code-specific 注意事项；
- 真正的长期工程指南放 `docs/CLAUDE-NOTES.md`（用户全局规则已建议）。

### Owned files

- `clavue.md` `AGENTS.md` `CLAUDE.md` 头部加 1 段 "本文件用途" 标注；
- 新增 `docs/CLAUDE-NOTES.md`（如不存在）汇总长期内容。

### 风险

最低。

### 依赖

无。

---

## 并行调度建议（火力全开 8 worker）

| Worker # | 切片 | 冲突域 | 备注 |
|---------|------|--------|------|
| W1 | A + B | `src/engine.ts` 中段 | A、B 必须同 worktree |
| W2 | C | `src/agent.ts` 入口 + 新文件 | 与 W1 弱冲突，需要 rebase |
| W3 | D | `src/tools/agent-tool.ts` `src/agent-jobs.ts` | 独立 |
| W4 | E | `src/memory.ts` `src/types/memory.ts` | 独立 |
| W5 | F | 三个 workflow 模块（小幅修改 + 新文件） | 独立 |
| W6 | G + H | 都涉及 `src/engine.ts`，G 是 token 路径，H 是 tool 路径 | 与 W1 中度冲突，建议 W1 先合并 |
| W7 | I + J | `src/tools/file-*.ts` + `src/runtime-profiles.ts` | 独立 |
| W8（scope-worker） | K + L | docs/, README.md, root md | 不动 src，零冲突 |

### 顺序约束

```
W1 (A+B) ─┐
W2 (C)    ├─→ rebase ──→ merge wave 1
W3 (D)    │
W4 (E)    │
W5 (F)    │
W6 (G+H)  ─→ wait W1 merge → rebase → merge wave 2
W7 (I+J)  ┘ 独立 → merge wave 1
W8 (K+L)  独立 docs，可立即合并
```

### 验证 gate（每个 worker 完成时）

```bash
npx tsc --noEmit
npx tsx --test tests/*.test.ts
```

合并前还需：

- 472 → 472+N 测试全绿；
- `pnpm typecheck` `pnpm lint` `pnpm test:run` 三项 clean（如使用 pnpm baseline）；
- changelog 增量条目。

---

## 风险登记

| 风险 | 触发 | 缓解 |
|------|------|------|
| W1 (A+B) 改 engine.ts 中段，与 W6 H/G 大量冲突 | 同一文件中段交叉编辑 | 强制 W1 先 land；W6 在 W1 合并后开 PR |
| Subagent abort 传播改变现有行为 | W3 D | 新 API 默认 inprocess + 旧字段保留；feature flag |
| Memory vector 引入大依赖 | W4 E | 强制零依赖默认；embedder 通过结构化注入（同 RAG 设计） |
| WorkItem 字段顺序破坏宿主消费者 | W5 F | 旧字段 0 改动；只增加 toWorkItem() 方法；changelog 标注 |

---

## scope-worker 承诺

本文档**不修改 src/**。本文档建议的切片 K 与 L 我会在另一次 docs 工作中执行（仍在 docs/** 范围）。
其他 9 个切片由 sibling worker 在自己的 worktree 中实现，按本文 owned-files 边界并发不冲突。

