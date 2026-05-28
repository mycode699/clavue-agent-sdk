# 动态合成圆桌 — 能力风险分层路由

> Dynamic Synthesis Roundtable — capability risk-tier routing
>
> 日期: 2026-05-29
> 状态: 已实现（骨架闭环），可被其它 agent 接力扩展

## 来源

源于一条 grok CLI 对话的设计意图（grok 撞 credit limit 后由 Clavue 接手实现）。
用户的核心比喻：

> "多种思路混合起来，类似圆桌、类似鱼与水、锤子和钉子 —— 只有组合起来才能达到完美的效果。"

翻译到本仓库的现有资产上，不是凭空造新系统，而是把这个比喻映射成
**一个纯函数风险路由层**，复用引擎已有的 `ToolSafetyAnnotations` 元数据。

## 三个比喻 → 三个机制

| 比喻 | 机制 |
|---|---|
| **圆桌** | 三个合成入口并存（不是三选一）：系统主动 / LLM 请求 / 审批后暴露 |
| **鱼与水** | 每个合成入口复用引擎权限门同一份 `safety` 元数据 → 合成与验证天然共生，不漂移 |
| **锤子和钉子** | 合成的主动性按"被合成能力的风险等级"路由，不是单一开关 |

## 三层定义（`SynthesisRiskTier`）

| Tier | 含义 | 主动性 |
|---|---|---|
| `system_initiated` | 纯只读、无副作用 | 运行时可自动合成/路由，无需提示 |
| `llm_requested` | 本地写 / 网络读 / 非破坏外部副作用 | LLM 主动请求；引擎权限门处理 |
| `approval_required` | 可执行 shell，或对外部状态有破坏性操作 | 必须过显式门才暴露 |

## 推断规则（纯函数，零配置）

### 工具 — `inferSynthesisRiskTier(tool)`

读 `ToolSafetyAnnotations` + `isReadOnly()`，无需改任何工具定义：

```
shell                         → approval_required
destructive && externalState  → approval_required
read && !write && !network && !externalState && !destructive
                              → system_initiated
否则                          → llm_requested
```

关键决策：本地 `destructive`（Edit/Write）留在 `llm_requested` —— 引擎的
`acceptEdits` 权限模式本就是为这条路径设计的，不重复收紧。

### 技能 — `inferSkillRiskTier(skill)`

技能没有 `ToolSafetyAnnotations`，用技能自己的风险信号：

```
context === 'fork'                  → approval_required  (启动子代理)
permissions.requiresApproval        → approval_required  (host 显式标注)
qualityGates 非空                   → llm_requested      (需过门)
否则 (inline 无门)                  → system_initiated
```

## 接入点（已实现）

| 入口 | 位置 | 暴露形式 |
|---|---|---|
| 工具发现 | `src/tools/tool-search.ts` | 搜索结果每行 `[tier: <tier>]` |
| 系统提示 | `src/skills/registry.ts` `formatSkillsForPrompt` | 每行 ` TIER: <tier>` |
| Host 健康检查 | `src/doctor.ts` `tools.registry` + `skills.registry` | `details.riskTierCounts` |
| 编排预分组 | `src/orchestration-policy.ts` `routeSynthesisCandidates` | 三个 bucket 数组 |

## 实测分布（`getAllBaseTools()` + bundled skills，2026-05-29）

```
TOOLS  { system_initiated: 4,  llm_requested: 24, approval_required: 10 }  (38 total)
SKILLS { system_initiated: 5,  llm_requested: 4,  approval_required: 3 }   (12 total)
```

## 公共 API（`src/index.ts` 导出）

```ts
type SynthesisRiskTier = 'system_initiated' | 'llm_requested' | 'approval_required'
interface SynthesisRoutingBuckets<T extends ToolDefinition>

function inferSynthesisRiskTier(tool: ToolDefinition): SynthesisRiskTier
function inferSkillRiskTier(skill: SkillDefinition): SynthesisRiskTier
function routeSynthesisCandidates<T extends ToolDefinition>(tools: T[]): SynthesisRoutingBuckets<T>
```

## 设计边界（明确不做的事）

- **不碰 schema version** — tier 是纯运行时分类，不进 `AGENT_RUN_RESULT_SCHEMA_VERSION` 等。
- **不碰 `engine.ts`** — 不在引擎循环里做 tier 强制。引擎权限门（`canUseTool` +
  workspace-path containment）已经是真正的执行门；tier 是其上的*可见化*与*路由*层。
- **不改任何工具/技能定义** — 推断函数从现有元数据读取，新工具/技能自动归类。
- **本地破坏性 ≠ 高危** — Edit/Write 留在中层，避免与 `acceptEdits` 模式重复。

## 可接力的下一步（未做）

1. 让 `approval_required` 工具在 `engine.ts` 里可选触发 `AskUserQuestion`
   —— 需谨慎，可能扰动 `acceptEdits` / `bypassPermissions` 模式，要先想清交互。
2. `selectDispatchCandidates` 支持 `max_concurrent_by_tier`（高危层并发收紧）。
3. tier 写入 trace 事件，供 retro/eval 按层统计合成行为。

## 测试

- `tests/synthesis-risk-tier.test.ts` — 9 cases，工具推断 + 分组
- `tests/skill-risk-tier.test.ts` — 6 cases，技能推断 + prompt 标签
- `tests/tool-search-tier.test.ts` — 4 cases，ToolSearch 标签
- `tests/doctor-risk-tier.test.ts` — 2 cases，doctor 工具层计数
- `tests/doctor-skill-tier.test.ts` — 1 case，doctor 技能层计数
