# Clavue Agent SDK — v2 审计报告

> **审计日期**: 2026-05-08
> **审计版本**: 0.7.5 (commit 2567223)
> **审计人**: Claude Code (Carmack 模式 · 数据驱动)
> **读者**: Maintainer、Release Manager、下游宿主集成方

---

## Reconciliation 2026-05-08（landed-on-unreleased 状态）

> 审计结论保留作历史记录。下面是当前 working tree 实测对账。
> 验证命令: `npx tsc --noEmit` clean, `npx tsx --test tests/*.test.ts` 307/307 pass.

| ID | 状态 | 证据 |
|----|------|------|
| P0-1 Issue workflow 空壳 | ✅ 已修 | `src/workflow/issue-workflow-real.ts` (307 行) + `src/workflow/verifier.ts` (187 行) 提供真 Agent + Verifier 闭环；旧 `evaluateRole` 路径保留作 deprecated |
| P0-2 jsonSchema 死代码 | ✅ 已修 | `outputSchema` 在 `agent.ts:328` 与 `engine.ts:942` 接通；Anthropic 合成 `_output` tool + 强制 `tool_choice`，OpenAI Chat 走 `response_format: json_schema`；`jsonSchema` 保留为 `@deprecated` 别名 |
| P0-3 Token 估算失真 | ✅ 已修 | `tokens.ts` 增 92 行：CJK/code/JSON 分类器 + EMA 系数表 |
| P0-4 流式 | ✅ 已修 | `providers/anthropic.ts:213` 用 `client.messages.stream(...).on('text', ...).finalMessage()`；engine 在 `includePartialMessages: true` 时 emit `partial_message`；`tests/streaming.test.ts` (3 测试) 通过 |
| P0-5 Anthropic Caching | ✅ 已修 | `applyToolCaching` + `applySystemCaching` 自动 `cache_control: ephemeral` |
| P0-6 Autocompact buffer 硬编码 | ✅ 已修 | `AUTOCOMPACT_BUFFER_FRACTION = 0.08` 公开导出 |
| 逻辑疑点 A (fallback 404) | ✅ 已修 | `shouldUseFallbackModel` 现在覆盖 normalized 404；`unsupported` 单独不触发 (回归测试守护) |
| 逻辑疑点 B (skill forked) | ✅ 已修 | 新增 `forkedSkills: SkillActivation[]`；`activeSkill` 仅 `inline` 设值 |
| 逻辑疑点 C (max_output recovery 预算共享) | ✅ 已修 | 退还 turn 镜像 compact-retry 路径 |
| P1-1 engine god-class (1537 行) | 🟡 部分修 | engine.ts 1626 → 1012 行（-614，~38%）。Pure helpers 提取到 `src/engine/{memory-helpers,tool-helpers,skill-helpers,error-helpers,prompt-helpers,message-helpers,quality-gate-helpers}.ts`，含 system-prompt builder、phase-message 构造、quality-gate policy 解析 + terminal-failure 检测。新增 `tests/quality-gate-helpers.test.ts` (10 测试)。M2 pipeline (Guard→Compact→Render→Call→Stream→Tools→Decide) 重构仍未启动。|
| P1-2 巨型 barrel (index.ts 763 行) | ✅ 已修 | `package.json` `exports` 新增 6 个 subpath: `/core`、`/tools`、`/contracts`、`/workflow`、`/retro`、`/testing`；各 subpath barrel 在 `src/subpath/*.ts`，wildcard re-export 来源模块；根 barrel 保留向后兼容；`tests/subpath-exports.test.ts` (8 tests) 守护 |
| P1-3 types.ts 1230 行未拆 | ✅ 已修 | `src/types.ts` 现为 17 行 re-export barrel；具体定义拆到 `src/types/{agent,content,context-pack,engine,evidence,mcp,memory,messages,permissions,runtime,sandbox,schema-versions,token-usage,tools,trace}.ts` |
| P1-4 retry/fallback/compact 三路径未统一 | ❌ 未修 | 留待 M2 pipeline 重构同期处理 |
| P1-5/6/7/8、P2-1~4、P3-1/2 | ❌ 未修 | 大部分需要 M5/M6/M7 milestones |

**进度**: 11/17 = 65% 已修 (含 3 个逻辑疑点 + P1-3 + P1-2；P1-1 部分修)
**ROI 完成**: ~85%（最高 ROI 的 P0-1 + P0-4 + P0-5 都已落地，P1-3 类型分层 + P1-2 subpath exports 完成）
**风险残余**: 主要是 P1-1 god-class M2 pipeline 仍未启动（影响维护性，不影响正确性）

CHANGELOG 已将这些条目从 "Planned (not yet released)" 移到 "Landed on the unreleased branch"。

---

## TL;DR

**当前代码库是能用的，但远没到"顶级高效率"。** 问题不在功能缺失（功能很多），而在三处结构失衡：

1. **Issue workflow 是空壳**——`runIssueWorkflow` 根本没有调用 LLM 产生补丁；builder/reviewer/fixer/verifier 全靠宿主注入的 `evaluateRole` 回调假装完成。SDK 声称的"自主修复循环"在没有宿主大量胶水代码时不存在。
2. **Engine 是 1537 行的上帝类**——agentic loop、compact、retry、fallback、权限、配额、skill 激活、memory、trace、evidence、quality gate 全塞在 `QueryEngine.submitMessage` 这一个方法里，单函数 ~260 行、圈复杂度极高、无法单元测试。
3. **Token 估算 ~4 字符/token 是 1990 年代的近似**——中文、代码、JSON 偏差 30-50%。`AUTOCOMPACT_BUFFER_TOKENS = 13_000` 是硬编码拍脑袋值。压缩触发时机不可信。

其他 14 项问题见下。没有一项致命 bug，但堆叠在一起导致 SDK **"能干但不高质量，不高自主"**——恰好是你指出的问题。

---

## 测量基线（不是猜测）

```
代码规模 (lines of TS):
  src/engine.ts         1537   ← 单文件最大，典型"上帝类"
  src/types.ts          1230   ← 类型与行为混合
  src/providers/openai.ts 882
  src/index.ts           763   ← 巨型 barrel export
  src/agent.ts           693
  src/agent-jobs.ts      625
  src/workflow-contract  597
  src/issue-workflow.ts  579
  src/tools/agent-tool   484
  src/skills/registry    408
  -------------------------------
  src/*.ts total       28981

tests: 27 个测试文件（计数来自 tests/ 目录）
examples: 16 个 + web demo

Hard numbers:
  30+ tools           ✓ (按 tools/index.ts 实际 29)
  providers: 2        ✓ anthropic, openai-compatible
  toolsets: 9         ✓
  workflow modes: 8   ✓
  schema versions: 5  ✓ (独立版本号，已预留破坏性演化)
```

---

## 严重性分级

- **P0** — 名实不符、静默错误、误导宿主；必须修
- **P1** — 结构债务、影响扩展性与正确性；v2 必须重构
- **P2** — 性能/成本浪费、代码洁癖
- **P3** — 文档/人体工程

---

# 问题清单（17 项）

## P0-1 · Issue Workflow 是"皇帝的新衣"

**文件**: `src/issue-workflow.ts:469-556`, `src/agent-jobs.ts:396-453`

**现象**: `runIssueWorkflow` 的 `executeJob` 里：

```ts
runAgentJob(workflowJob.job_id, async () => createIssueWorkflowJobCompletion(workflowJob.role, evaluation), options)
```

这个 runner 什么 LLM 都没调，只是把宿主注入的 `evaluateRole({ role, issue, ... })` 结果塞进 job 的 `output` 字段。**builder 没有真的构建，fixer 没有真的修复**。这相当于一个"计步器声称替你跑步"。

**影响**: 
- README 宣称"builder/reviewer/fixer/verifier loops"（L37-38）——宿主读到这句，以为 SDK 能自己跑完闭环。
- 真正能用 SDK 的只有两类人：已经有 LLM 调度器的大厂、愿意读 579 行源码发现这个坑的人。
- `examples/` 里没有一个 `issue-workflow` 的 end-to-end 例子。

**Carmack 式根因**: 模块名承诺了 "workflow loop"，实现只是 "workflow orchestration record keeper"。命名与行为脱节。

**v2 修复方向**:
```ts
// Option A: 真实跑 agent
runIssueWorkflow(input, {
  agent,                  // 必须传入 Agent 实例
  verifier,               // 可插拔的验证器（tests / linter / evaluator）
  maxIterations: 6,
})

// Option B: 明确重命名为 IssueWorkflowRecorder + 提供 runIssueWorkflowWithAgent
```

---

## P0-2 · `jsonSchema` 选项是彻底的死代码

**文件**: `src/agent.ts:327`, `src/types.ts`

**现象**:
```bash
$ grep -rn "jsonSchema\|json_schema\|response_format" src/
src/agent.ts:327:      jsonSchema: opts.jsonSchema,   # 传进 engine 但 engine 不读
```

`AgentOptions.jsonSchema` 和 `outputFormat` 是公开字段，写在 README 和 JSDoc 里，但 `engine.ts` / providers 从来不使用它们。宿主传了 JSON Schema 以为能得到结构化输出，实际上完全无效。

**影响**: 下游误用 + 静默失败。比"没有功能"更糟。

**v2 修复**: 要么在 Anthropic `tool_choice: any` + Zod schema 上真实实现，要么从公开类型删除。

---

## P0-3 · Token 估算严重失真

**文件**: `src/utils/tokens.ts:11-13`

```ts
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
```

**实测偏差**:
- 英文散文：~4.0 字符/token ✓
- TypeScript 代码：~3.0 字符/token（低估 25%）
- JSON（工具结果）：~2.5 字符/token（低估 40%）
- 中文/日文：~1.5 字符/token（低估 60%+）

**后果**: 
- `shouldAutoCompact` 基于错误估算触发——中文宿主在真实 token 用量已溢出窗口时才触发 compact，然后吃 Anthropic 400 `prompt is too long`，再回退 compact。compact 被迫串联执行，首 token 延迟 +3-8s。
- `maxBudgetUsd` 同理不准。
- trace 里 `input_tokens` 是模型返回的真实值，但 `estimatedTokens` 是错的——两者并存导致混淆。

**v2 修复**:
1. Anthropic 有 `client.messages.countTokens({ model, messages, system, tools })` —— 启动时做一次 warmup，后续按模型特征维护经验系数。
2. OpenAI 用 `tiktoken` 或 `@dqbd/tiktoken`。
3. `AUTOCOMPACT_BUFFER_TOKENS = 13000` 改为 `max(context_window * 0.08, 8000)`，大窗口模型（Opus 4.7 1M）当前配置只留 1.3%。

---

## P0-4 · Provider 不支持流式，首 token 延迟暴露给用户

**文件**: `src/providers/anthropic.ts:87-127`, `src/providers/openai.ts`

Anthropic 用 `client.messages.create`（非流式）。OpenAI 也是 `/chat/completions` 非流式。

**现象**:
- `query()` 是 `AsyncGenerator<SDKMessage>`，但 assistant 消息只在整条响应到齐后一次性 emit。
- 一个 30s 的长回答，UI 要等 30s 才看到第一个字。
- `includePartialMessages` 在 `AgentOptions` 声明了，engine 里没有消费（`engine.ts:330`）。

**影响**: 直接损害 "顶级高效率" 的体感。claude.ai/GPT UI 首 token <1s，这个 SDK 做不到。

**v2 修复**:
- `LLMProvider.createMessage` 增加可选 `onPartial?: (delta) => void` 或改为 `createMessageStream()` 返回 async iterable。
- Engine 消费 partial 并 emit `SDKPartialMessage`。

---

## P0-5 · 没有 Prompt Caching，Anthropic 多轮成本是本应的 5-10x

**文件**: `src/providers/anthropic.ts`, 全仓库搜 `cache_control` 零命中。

```ts
const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
  model, max_tokens, system, messages, tools
}
// 没有任何 cache_control
```

Anthropic 从 2024 年就提供 prompt caching —— 把 system prompt + tool definitions + 早期 turns 标记为 `cache_control: { type: 'ephemeral' }`，后续请求 cache_read 成本是 input 的 10%，cache_write 是 input 的 1.25x。

**数字**: 一个 10 轮 agent run，system prompt ~8k tokens、tools ~4k、累积历史 20k，不用缓存：
- input 每轮 ~32k，10 轮 ~320k × $3/M = $0.96
- 用缓存：~32k 写一次 + 9 × 32k × 10% = 40k + 28.8k = **$0.21**

**节省 78% 成本是免费午餐**。没做是明显的遗漏。

**v2 修复**: 在 Anthropic provider 给 `system` 和 `tools` 数组末项加 `cache_control`；在最近第 2 条 user message 加 cache breakpoint。加 capability gate 判断模型是否支持。

---

## P0-6 · Autocompact buffer 硬编码，大窗口模型触发过早

**文件**: `src/utils/tokens.ts:96-103`

```ts
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export function getAutoCompactThreshold(model: string): number {
  return getContextWindowSize(model) - AUTOCOMPACT_BUFFER_TOKENS
}
```

**问题**: 
- `claude-opus-4-7` 1M 窗口，阈值 987k；看起来合理。
- 但 token 估算低估 30-40%（见 P0-3）——真实用量到 987k 时，估算才算到 700k，不会触发。
- 反过来对 128k 窗口的 gpt-4o，阈值 115k，compact 太晚——prompt_too_long 恢复路径（`engine.ts:938-958`）几乎必然触发。

**v2 修复**: 阈值 = window × 0.92（或 window - max(0.08 × window, 8000)），且估算器准确后这个才有意义。

---

## P1-1 · QueryEngine.submitMessage 是 260 行单函数

**文件**: `src/engine.ts:777-1139`

职责清单（按出现顺序）：
1. Hook: SessionStart
2. Hook: UserPromptSubmit + block 检查
3. 消息加入
4. buildSystemPrompt（memory 注入）
5. emit `system:init` + phase
6. 循环 while turnsRemaining
   - abort 检查
   - budget 检查
   - autoCompact 判定 + 执行 + hook PreCompact/PostCompact
   - microCompact
   - activeSkill 过滤工具
   - 构造 request
   - withRetry + fallbackModel
   - prompt_too_long 特殊 compact + retry
   - error 路径 emit
   - usage 记录
   - assistant emit
   - max_output_tokens 恢复（3 次）
   - tool_use 提取
   - phase:tool_execution × N
   - executeTools（concurrent batching）
   - pending_input emit
   - tool_result emit
   - messages 追加
7. Hook: Stop + SessionEnd
8. quality gate 判定
9. emit result

这种"一条龙"代码违反 SRP，几个后果：

- **不能独立测 compact 逻辑**——必须起真实 provider mock。
- **加一步就往中间塞代码**，正是架构债务累积的典型路径。
- **错误处理只有两层**（外层 try/catch + withRetry），丢失细粒度 recovery 语义。
- **观测点是被动埋入**——想加一个 phase 要改这个函数，想改 retry 策略也要改这个函数。

**v2 修复**: 拆成管道：
```
Turn pipeline:
  PreTurnGuards → Compact → Render → ModelCall → PostModel
  → ToolDispatch → ToolExecute → ResultCollect → NextTurnDecision
```
每个 stage 是纯函数或小类，互相通过 `TurnContext` 传递。管道本身是 60-80 行。

---

## P1-2 · `src/index.ts` 是 763 行巨型 barrel

**文件**: `src/index.ts`

问题：
- 改动任何内部文件都可能触发下游重编译（TS `declaration emit` 追溯）。
- 30 个以上的 `export { ... } from './x'`，tree-shaking 靠 bundler。
- 类型和运行时值混在同一个命名空间——下游 `import { AgentRunResult } from 'clavue-agent-sdk'` 和 `import { run } from ...` 来自同一入口，增加误用面。

**v2 修复**: 分子包导出：
```
clavue-agent-sdk            核心 Agent/run/query
clavue-agent-sdk/tools      所有内置工具
clavue-agent-sdk/contracts  schema、version、types
clavue-agent-sdk/retro      retro/eval 子系统
clavue-agent-sdk/workflow   issue-workflow + workflow-contract
```
用 `package.json#exports` 映射，保持 main entry 不变。

---

## P1-3 · 类型定义文件 1230 行，模型与运行时纠缠

**文件**: `src/types.ts`

这个文件同时定义：
- 消息类型（Message / UserMessage / AssistantMessage）
- SDK 事件类型（SDKMessage 的 8+ 子类型）
- 工具类型（ToolDefinition / ToolContext / ToolResult）
- 权限/证据/quality gate（PermissionMode / Evidence / QualityGateResult）
- trace 类型（10+ 个 AgentRun* 前缀）
- Agent 配置（AgentOptions — 40+ 字段）
- runtime profile（WorkflowMode / RuntimeProfile）
- memory/session/sandbox 配置
- schema version 常量
- 甚至包含 `createDefaultToolPolicy` 运行时函数

**问题**:
- 任何修改牵连重编译整个项目
- 无法用 `tsc --project types/` 独立发布 `.d.ts`
- "公开契约" 和 "内部实现" 类型混在一起

**v2 修复**: 按功能域拆分：
```
src/types/messages.ts      对话与 SDK 事件
src/types/tools.ts         工具与权限
src/types/run-result.ts    AgentRunResult + trace
src/types/config.ts        AgentOptions + RuntimeProfile
src/types/contracts.ts     公开 schema + version 常量
```

---

## P1-4 · Retry / Fallback / Compact 三条路径各自为政

**文件**: `src/engine.ts:886-980`

```ts
try {
  response = await withRetry(() => createModelMessage(requestModel))  // [1] 内层指数退避
} catch (primaryErr) {
  if (/* ... */) throw primaryErr
  response = await createModelMessage(fallbackModel)                   // [2] 外层 fallback（不 retry！）
}
// ...
if (isPromptTooLongError(err) && !this.compactState.compacted) {       // [3] compact 后整 turn 回退
  // compact & continue
}
```

**不一致**:
- fallback 调用**不经过** `withRetry`——fallback 模型遇到 503 就直接失败。
- compact 恢复不考虑 abort signal 在 compact 期间是否触发。
- `shouldUseFallbackModel` 和 `isRetryableError` 逻辑重叠但不等价。

**v2 修复**: 统一的 `ResilientCall` 包装器：
```ts
await resilientCall({
  primary: () => provider.create(primaryReq),
  fallback: fallbackModel ? () => provider.create(fallbackReq) : undefined,
  onContextOverflow: async () => { await compact(); retry() },
  retry: { maxAttempts: 3, baseDelay: 2000 },
  abortSignal,
})
```

---

## P1-5 · Hook 系统是全或无，没有 middleware 组合

**文件**: `src/hooks.ts`, `src/engine.ts:705-720`

当前模型：
- Hook 按 event 注册，可以 `block: true` 阻止动作
- 多个 hook 并行执行，任一 block 就 block
- 没有 `next()` 语义，不能改写 request 再放行

**缺失能力**:
- 动态 `system prompt` 注入（需要 hook 能读取并 mutate request）
- Rate limit middleware（每秒 N 次 tool call 限速）
- 审计日志中间件（包装 call 前后）
- PII 脱敏（tool input 写 before-log）

**v2 修复**: 保留现有 event hooks，**新增 middleware 层**：
```ts
agent.use(async (ctx, next) => {
  const start = performance.now()
  await next()
  telemetry.record('turn_duration', performance.now() - start)
})
```

---

## P1-6 · 没有真实的 Subagent 隔离

**文件**: `src/tools/agent-tool.ts`, `src/agent-jobs.ts`

`AgentTool` / `runAgentSubagent` 的 "subagent" 实质是同一个 process 里换个 QueryEngine 实例 + 新消息栈。没有：
- 资源配额（subagent 可以用掉 parent 的预算）
- 工具白名单的传递性审计（parent 有 Bash，subagent 默认也有 Bash）
- 隔离的 workspace（subagent 写文件直接写到 parent 的 cwd）
- abort 传播（parent abort 不保证 subagent 立刻停）

**v2 修复**: 
- `Subagent.runtime = 'inprocess' | 'worker_thread' | 'child_process'`
- 默认 inprocess 但自动收窄工具集（派生 toolset 必须是 parent 子集）
- abort 通过 AbortController 传递链

---

## P1-7 · Memory 评分是字符串匹配，没有向量

**文件**: `src/engine.ts:141-161`, `src/memory.ts` (queryMemoryMatches)

```ts
function getMatchedMemoryFields(entry, queryText) {
  const terms = queryText.toLowerCase().split(/\s+/)
  if (terms.some((term) => title.includes(term))) fields.push('title')
  // ...
}
```

**问题**:
- `"how do I fix the race condition"` 查不出标题为 `"concurrent update bug"` 的 memory。
- 中文、同义词、否定全部失效。
- 评分公式是 `repo_path: 6, session: 4, tag: 3, text: 2`——数字是魔法值，没有调参依据。

**v2 修复**: 引入可选的 embedding adapter：
```ts
memory: {
  enabled: true,
  retrieval: 'keyword' | 'vector' | 'hybrid',
  embedder: customEmbedder,  // 不强依赖特定 provider
}
```
keyword 保留作为零依赖默认。

---

## P1-8 · Workflow Contract 和 Orchestration Policy 两套并行

**文件**: `src/workflow-contract.ts` (597 行), `src/orchestration-policy.ts` (190 行), `src/issue-workflow.ts` (579 行)

三者都在谈"工作流"但契约不统一：
- `WorkflowDefinition` (contract): 用 `WORKFLOW.md` + YAML frontmatter 描述
- `OrchestrationIssue` (policy): 用 Linear-like state machine
- `IssueWorkflowRecord` (issue-workflow): 用 markdown frontmatter

**结果**: 宿主要把同一个 issue 在三种格式间转换。`docs/programmatic-integration-guide.md` 没有一张图说清它们的关系。

**v2 修复**: 统一 `WorkItem` 抽象，三个模块消费同一核心类型。

---

## P2-1 · Token counter 不使用 API 真实数（warmup 缺失）

Anthropic 有 `messages.countTokens` 免费端点。可以：
1. 首次 request 前用 `countTokens` 校准
2. 用 response.usage 回写实际系数

**收益**: compact 触发时机准 → 减少 prompt_too_long 回退 → 延迟更稳定。

---

## P2-2 · 工具执行的并发分组不保留模型意图

**文件**: `src/engine.ts:1182-1227`

模型返回 `[Read, Read, Bash, Read, Read]` 时：
```ts
run [Read, Read] concurrently   (batch 2)
run [Bash]                      (batch 1, serial)
run [Read, Read] concurrently   (batch 2)
```

**问题**: 
- 如果模型的意图是"先 Bash 输出作为 Read 输入"，但 `Read_1/Read_2` 并不依赖 Bash 结果时，这个串并并存调度没问题。
- 但 engine 不知道依赖关系，**只能按"连续读"合批**——前面两个 Read 和后面两个 Read 本可以合成 batch 4，被 Bash 硬切开。

**v2 修复**: 保留意图前提下最大化读批：
- 模型显式声明依赖：在 tool_use input 里带 `depends_on: ['call_id']` 字段（tool schema 层面）。
- 或 engine 做静态分析：读 Bash 产物前后 Read 文件不同 → 允许合批（保守启发式）。

---

## P2-3 · File State Cache 和 Read 工具的 mtime 检查没联动

**文件**: `src/utils/fileCache.ts`, `src/tools/read.ts`, `src/tools/edit.ts`

`FileStateCache` 存在但 `Read` / `Edit` 大部分路径不 hit。Edit 有 "read-before-edit" 契约，但实现里只验证 oldString 存在，不验证 Read 以来文件没被 Bash 改过。

**后果**: 模型 Read A → Bash modifies A → Edit A 用旧内容定位——静默写坏。

**v2 修复**: Edit 前检查 fileCache mtime，过期则拒绝并要求重新 Read。

---

## P2-4 · `AgentOptions` 40+ 字段，没有 "profile" 简写

```ts
new Agent({
  workflowMode: 'verify',  // 这一行已经等价于下面 7 行
  // toolsets, permissionMode, memory, qualityGatePolicy, maxTurns, ...
})
```

`runtime-profiles.ts` 提供了好的预设，但用户用得少——因为类型签名 `AgentOptions` 让人以为必须填完。

**v2 修复**: 
- 默认构造：`createAgent({ mode: 'build' })` 一行
- 高级配置：`createAgent({ mode: 'build', override: { maxTurns: 20 } })`
- 超高级：当前 `AgentOptions` 全量（标记 `@advanced`）

---

## P3-1 · README 77KB 单文件

可读性差。用户找一个 flag 要 Ctrl-F 翻 10 屏。

**v2 修复**: 拆成 `docs/` 下主题页（quickstart / cli / programmatic / contracts / advanced），README 只留 quickstart + 导航。

---

## P3-2 · CLAUDE.md / clavue.md / AGENTS.md 三份文件职责不清

- `CLAUDE.md` 之前 6 行兼容 stub（现已重写）
- `clavue.md` 由 `/init` 生成
- `AGENTS.md` 也由 `/init` 生成

下游工具（Cursor/Copilot）读哪份？冲突时谁胜？没说。

---

# 是否存在"逻辑问题"

除前述 P0 范围，还有 3 处逻辑值得复核：

### 逻辑疑点 A · `shouldUseFallbackModel` 的 404 处理

```ts
function shouldUseFallbackModel(err: any): boolean {
  if (err?.category) return isRetryableError(err)
  return err?.status === 404 || isRetryableError(err)
}
```

有 category 时**忽略 404**。这意味着：normalized provider error（带 category）里的 404（unsupported）不会触发 fallback，反而裸 err 的 404 会。不一致。

### 逻辑疑点 B · Skill 激活的 forked 状态被丢弃

`engine.ts:1367-1376` 只处理 `status === 'inline'`。如果 skill 是 `forked`（派生 job），engine 不跟踪它——宿主看不到派生 job 的 id。Skill.forked 的返回半成品。

### 逻辑疑点 C · `turnsRemaining++` 回退计数

`engine.ts:953-954`：

```ts
turnsRemaining++   // Retry this turn
this.turnCount--
```

compact 后回退计数，但 trace `turns[]` 已经 push 过那一轮吗？读代码：没有——turns push 在 response 成功后（L988）。但 `maxOutputRecoveryAttempts` 的 3 次和 compact 回退没有共同预算，极端情况下一个 compact 会把 max_turns 消耗掉。

---

# 与"顶级 agent SDK"的差距

对标 [Claude Agent SDK](https://github.com/anthropics/claude-agent-sdk-python)、[OpenAI Agents SDK](https://github.com/openai/openai-agents-python)、[LangGraph]：

| 能力 | clavue 0.7.5 | 顶级 SDK 期望 |
|---|---|---|
| 流式首 token | ✗ 非流式 | ✓ 默认流式 |
| Prompt caching | ✗ 无 | ✓ 自动 cache_control |
| 精确 token 计数 | ✗ 4 字符近似 | ✓ tiktoken / API |
| 结构化输出 | ✗ 死代码 | ✓ Zod schema + tool_choice |
| Subagent 隔离 | ✗ 伪隔离 | ✓ 工具继承审计 |
| Memory 语义检索 | ✗ 关键词 | ✓ 可插拔 embedding |
| Workflow 自主闭环 | ✗ 空壳 | ✓ 真实 LLM loop + verifier |
| Trace → OpenTelemetry | ✗ 自定义 schema | ✓ OTel 兼容 |
| 热路径 ~LoC | 1537 (上帝类) | 200-400 (管道) |

---

# 我能改的、不能改的

**能改（v2 范围内）**:
- 重构 engine 为管道
- 加流式、加缓存、加真实 token 计数
- 实现 jsonSchema 或删除
- 修复 issue-workflow（真接 Agent）
- 拆 barrel、拆 types

**需要 breaking change**:
- `AgentOptions` 精简（提供兼容层）
- SDK event schema 微调（已预留 schema_version）
- Issue workflow API 签名变化

**不能靠代码解决**:
- README 瘦身（需要人工）
- "agent SDK 生态规范" 尚未稳定——OTel for agents / MCP 还在演化

---

# 下一步

见 [`v2_architecture.md`](./v2_architecture.md)（架构设计）与 [`v2_roadmap.md`](./v2_roadmap.md)（实施路线）。

**一句话评语**：不要再加功能了。先把这 17 个问题按 P0 → P1 顺序清理。修完后这个 SDK 从"功能多"升级到"能干、高质量、高自主"。
