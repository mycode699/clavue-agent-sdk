# Clavue Agent SDK

[![npm version](https://img.shields.io/npm/v/clavue-agent-sdk)](https://www.npmjs.com/package/clavue-agent-sdk)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Clavue Agent SDK runs the full agent loop **in-process** for library integrations — no subprocess and no local CLI dependency. An optional `npx` CLI is also available for terminal and CI automation. It supports both **Anthropic** and **OpenAI-compatible** APIs, so you can embed the same agent runtime in cloud services, serverless jobs, Docker containers, and CI/CD workflows.

Clavue Agent SDK 作为库集成时会在你的应用进程内直接运行完整 agent loop，**不需要子进程，也不依赖本地 CLI**。同时也提供可选的 `npx` CLI，方便终端和 CI 自动化使用。它支持 **Anthropic** 与 **OpenAI-compatible** API，适合直接嵌入云服务、Serverless、Docker 与 CI/CD。

Also available in **Go**: [clavue-agent-sdk-go](https://github.com/mycode699/clavue-agent-sdk-go)

## Quick start / 快速开始

### Use directly with npx / 直接用 npx 运行

No local install is required for quick automation from a terminal or CI job.

终端或 CI 里可以直接用 `npx` 运行，不需要先安装到项目里。

```bash
export CLAVUE_AGENT_API_KEY=your-api-key
npx clavue-agent-sdk "Read package.json and summarize this project"

# Safer read-only review / 更安全的只读审查
npx clavue-agent-sdk "Review src for obvious bugs" --toolset repo-readonly

# Combine named toolsets / 组合命名工具集
npx clavue-agent-sdk "Research and review this repo" --toolset repo-readonly,research

# OpenAI-compatible model / OpenAI 兼容模型
npx clavue-agent-sdk \
  --api-type openai-completions \
  --model gpt-5.4 \
  --base-url https://api.openai.com/v1 \
  "Explain the repository structure"

# Opt-in run learning / 可选开启 run 自学习
npx clavue-agent-sdk \
  --self-improvement \
  --allow Read,Glob,Grep \
  "Review package.json for release readiness risks"

# Or enable it from CI/env / 也可以通过 CI/env 开启
CLAVUE_AGENT_SELF_IMPROVEMENT=true \
  npx clavue-agent-sdk --allow Read,Glob,Grep "Review package.json"
```

CLI options: `--prompt`, `--model`, `--api-type`, `--api-key`, `--base-url`, `--cwd`, `--max-turns`, `--allow`, `--toolset`, `--deny`, `--self-improvement`, `--json`.

Environment variables: `CLAVUE_AGENT_API_KEY`, `CLAVUE_AGENT_API_TYPE`, `CLAVUE_AGENT_MODEL`, `CLAVUE_AGENT_BASE_URL`, `CLAVUE_AGENT_AUTH_TOKEN`, `CLAVUE_AGENT_SELF_IMPROVEMENT`, `AGENT_SDK_MAX_TOOL_CONCURRENCY`.

命令行参数：`--prompt`、`--model`、`--api-type`、`--api-key`、`--base-url`、`--cwd`、`--max-turns`、`--allow`、`--toolset`、`--deny`、`--self-improvement`、`--json`。

环境变量：`CLAVUE_AGENT_API_KEY`、`CLAVUE_AGENT_API_TYPE`、`CLAVUE_AGENT_MODEL`、`CLAVUE_AGENT_BASE_URL`、`CLAVUE_AGENT_AUTH_TOKEN`、`CLAVUE_AGENT_SELF_IMPROVEMENT`、`AGENT_SDK_MAX_TOOL_CONCURRENCY`。

## Best practices / 最佳使用实践

### Pick the right integration mode / 选择合适的集成方式

- Use `npx clavue-agent-sdk ...` for quick terminal automation, CI checks, and one-off repository analysis.
- Use `run()` for backend jobs where you want one prompt in, one typed `AgentRunResult` out.
- Use `query()` for streaming UIs, logs, dashboards, and integrations that need live assistant/tool events.
- Use `createAgent()` for long-lived apps that need multi-turn state, sessions, hooks, MCP servers, custom subagents, or repeated prompts.

- 快速终端自动化、CI 检查、一次性仓库分析：使用 `npx clavue-agent-sdk ...`。
- 后端任务只需要“一次输入、一次结构化结果”：使用 `run()`。
- 前端 UI、日志面板、实时事件流：使用 `query()`。
- 长生命周期应用、多轮会话、hooks、MCP、自定义 subagent 或重复调用：使用 `createAgent()`。

### Start narrow, then expand tools / 先收窄权限，再逐步扩展工具

Prefer the smallest tool surface that can complete the task. Start with read-only tools for review and analysis, then add write or shell tools only when the workflow needs them.

优先使用能完成任务的最小工具权限。审查和分析先从只读工具开始，只有在确实需要修改文件或执行命令时再增加写入或 shell 工具。

```bash
# Read-only repository review / 只读仓库审查
npx clavue-agent-sdk "Review this repo for release risks" \
  --toolset repo-readonly \
  --max-turns 6

# Focused code change with explicit tools / 明确授权工具的定向修改
npx clavue-agent-sdk "Fix the failing package payload test" \
  --allow Read,Glob,Grep,Edit,Bash \
  --max-turns 10

# CI-friendly JSON output / 适合 CI 的 JSON 输出
npx clavue-agent-sdk "Check whether package.json is release-ready" \
  --toolset repo-readonly \
  --json
```

### Set `cwd`, model, and budgets explicitly / 显式设置 cwd、模型和预算

For automation, set `cwd`, `model`, `maxTurns`, and tool permissions explicitly so runs are reproducible and bounded.

自动化场景建议显式设置 `cwd`、`model`、`maxTurns` 和工具权限，让运行结果更可复现、成本和轮次更可控。

```typescript
import { run } from "clavue-agent-sdk";

const result = await run({
  prompt: "Review the package for publish-readiness and return concise findings.",
  options: {
    cwd: process.cwd(),
    model: "claude-sonnet-4-6",
    toolsets: ["repo-readonly"],
    maxTurns: 6,
  },
});

if (result.status !== "completed") {
  throw new Error(result.errors?.join("\n") || result.subtype);
}

console.log(result.text);
```

### Use structured outputs in automation / 自动化中使用结构化结果

In CI or services, prefer `run()` or CLI `--json` instead of scraping assistant text from stdout. Check `status`, `subtype`, `errors`, `usage`, and `total_cost_usd` before deciding whether a job passed.

在 CI 或服务端集成里，优先使用 `run()` 或 CLI `--json`，不要依赖解析普通文本输出。根据 `status`、`subtype`、`errors`、`usage` 和 `total_cost_usd` 判断任务是否成功。

### Enforce production controls / 启用生产控制能力

For production hosts, combine narrow toolsets, `permissionMode`, `qualityGatePolicy`, memory policy, `doctor()`, and `runBenchmarks()` instead of relying only on prompt instructions.

生产宿主应组合使用最小工具集、`permissionMode`、`qualityGatePolicy`、memory policy、`doctor()` 和 `runBenchmarks()`，不要只依赖 prompt 约束。

```typescript
import { doctor, run, runBenchmarks } from "clavue-agent-sdk";

const health = await doctor({
  toolsets: ["repo-readonly"],
  memory: { enabled: true },
});
if (health.status === "error") throw new Error("SDK runtime is not ready");

const result = await run({
  prompt: "Review the current package and report release blockers.",
  options: {
    toolsets: ["repo-readonly"],
    permissionMode: "default",
    memory: { enabled: true, policy: { mode: "brainFirst" } },
    quality_gates: [{ name: "release-review", status: "passed" }],
    qualityGatePolicy: { required: ["release-review"] },
    maxTurns: 6,
  },
});

if (result.subtype === "error_quality_gate_failed") {
  throw new Error(result.errors?.join("\n") || "Required quality gate failed");
}

const benchmarks = await runBenchmarks({ iterations: 3 });
console.log(benchmarks.metrics);
```

Current memory trace records policy, query, repo path, selected memory IDs, selected memory score/reason metadata, source/scope/confidence, validation state, retrieval steps, injected count, and whether retrieval happened before the first model call.

当前 memory trace 会记录 policy、query、repo path、selected memory IDs、被选记忆的分数和原因、source/scope/confidence、validation state、retrieval steps、injected count，以及是否在首次模型调用前完成检索。

The current capability upgrade program is tracked in `docs/agent-sdk-capability-upgrade-program.md`. It expands the SDK beyond coding automation into collection, organization, planning, problem solving, memory intelligence, skill creation, self-learning, reusable agents, and workflow templates.

当前能力升级计划见 `docs/agent-sdk-capability-upgrade-program.md`。它会把 SDK 从代码自动化扩展到资料收集、整理、规划、问题解决、记忆智能、技能创建、自学习、可复用 agent 和工作流模板。

### Keep prompts operational / 让 Prompt 面向执行

Good prompts specify the goal, boundaries, expected output format, and verification command. Avoid broad prompts that mix unrelated work.

好的 prompt 应包含目标、边界、期望输出格式和验证命令。避免把多个无关任务混在一个过大的 prompt 里。

```text
Good: Review src/providers/openai.ts for cancellation bugs. Do not edit files. Return findings with file:line references.
Good: Update README quick-start examples only. Run npm run build after editing.
Avoid: Make the project better.
```

### Recommended production pattern / 推荐生产集成模式

1. Store credentials in environment variables, not source code.
2. Pin `CLAVUE_AGENT_MODEL` or pass `model` in code for predictable behavior.
3. Use `allowedTools` or `toolsets` for every automated workflow.
4. Set `maxTurns` for bounded execution.
5. Log the final `AgentRunResult` metadata: `status`, `subtype`, `num_turns`, `usage`, `duration_ms`, and `total_cost_usd`.
6. Enable `selfImprovement` only for workflows where persisting run lessons is expected.
7. Close reusable agents with `await agent.close()` so sessions, MCP connections, and memory hooks flush cleanly.

1. 凭证放在环境变量中，不要写进源码。
2. 通过 `CLAVUE_AGENT_MODEL` 或代码里的 `model` 固定模型，保证行为可预测。
3. 每个自动化流程都设置 `allowedTools` 或 `toolsets`。
4. 设置 `maxTurns`，避免无界运行。
5. 记录 `AgentRunResult` 元数据：`status`、`subtype`、`num_turns`、`usage`、`duration_ms`、`total_cost_usd`。
6. 只有在确实希望持久化运行经验时才开启 `selfImprovement`。
7. 可复用 agent 使用完后调用 `await agent.close()`，确保 session、MCP 连接和 memory hooks 正常收尾。

### Common recipes / 常用方法

```bash
# Explain a repository / 解释仓库结构
npx clavue-agent-sdk "Explain this repository architecture" --toolset repo-readonly

# Review a pull-request checkout / 审查当前 PR 工作区
npx clavue-agent-sdk "Review the current diff for bugs and release risks" --toolset repo-readonly

# Generate a machine-readable report / 生成机器可读报告
npx clavue-agent-sdk "Return JSON listing package release blockers" --toolset repo-readonly --json
```

### 1. Install as a library / 作为库安装

```bash
npm install clavue-agent-sdk
```

### 2. Configure / 配置

Set the environment variables once, then start using the SDK immediately.

先设置环境变量，然后就可以直接开始调用 SDK。

```bash
export CLAVUE_AGENT_API_KEY=your-api-key
# Optional / 可选
# export CLAVUE_AGENT_MODEL=claude-sonnet-4-6
```

#### OpenAI-compatible setup / OpenAI 兼容模型配置

```bash
export CLAVUE_AGENT_API_TYPE=openai-completions
export CLAVUE_AGENT_API_KEY=sk-...
export CLAVUE_AGENT_BASE_URL=https://api.openai.com/v1
export CLAVUE_AGENT_MODEL=gpt-4o
```

#### Anthropic-compatible gateway setup / Anthropic 兼容网关配置

```bash
export CLAVUE_AGENT_BASE_URL=https://openrouter.ai/api
export CLAVUE_AGENT_API_KEY=sk-or-...
export CLAVUE_AGENT_MODEL=anthropic/claude-sonnet-4
```

### 3. Easiest integration for another program / 其他程序最简单集成方式

If another Node.js service just needs one clear call, use `run()`. It creates an agent, executes the prompt, closes the agent, and returns a complete typed artifact.

如果其他 Node.js 服务只想用最简单的一次调用，使用 `run()`。它会创建 agent、执行 prompt、关闭 agent，并返回完整的类型化结果。

```typescript
import { run } from "clavue-agent-sdk";

const result = await run({
  prompt: "Read package.json and return the name and version as JSON.",
  options: {
    cwd: process.cwd(),
    allowedTools: ["Read"],
    maxTurns: 3,
  },
});

if (result.status !== "completed") {
  throw new Error(result.errors?.join("\n") || result.subtype);
}

console.log(result.text);
```

`run()` returns `AgentRunResult`: `status`, `subtype`, final `text`, `events`, `messages`, `usage`, `num_turns`, `duration_ms`, `duration_api_ms`, `total_cost_usd`, timestamps, optional `errors`, and optional `self_improvement` artifacts when enabled.

`run()` 返回 `AgentRunResult`：包含 `status`、`subtype`、最终 `text`、`events`、`messages`、`usage`、`num_turns`、耗时、费用、时间戳、可选 `errors`，以及启用时返回的可选 `self_improvement` 结果。

### 4. Streaming events / 流式事件

Use `query()` when your program wants live events: assistant text, tool calls, tool results, and the final result.

当你的程序需要实时事件流时使用 `query()`：包括 assistant 文本、工具调用、工具结果和最终结果。

```typescript
import { query } from "clavue-agent-sdk";

for await (const message of query({
  prompt: "Read package.json and tell me the project name.",
  options: {
    allowedTools: ["Read", "Glob"],
  },
})) {
  if (message.type === "assistant") {
    for (const block of message.message.content) {
      if ("text" in block) console.log(block.text);
    }
  }

  if (message.type === "result") {
    console.log(`Done in ${message.num_turns} turns`);
  }
}
```

### 5. Reusable agent / 可复用 Agent

Use `createAgent()` when your application needs multi-turn state, session persistence, MCP connections, hooks, or repeated calls.

当你的应用需要多轮上下文、会话持久化、MCP 连接、hooks 或重复调用时，使用 `createAgent()`。

```typescript
import { createAgent } from "clavue-agent-sdk";

const agent = createAgent({ model: "claude-sonnet-4-6" });
try {
  const result = await agent.prompt("What files are in this project?");

  console.log(result.text);
  console.log(
    `Turns: ${result.num_turns}, Tokens: ${result.usage.input_tokens + result.usage.output_tokens}`,
  );
} finally {
  await agent.close();
}
```

### 6. OpenAI / GPT models

```typescript
import { createAgent } from "clavue-agent-sdk";

const agent = createAgent({
  apiType: "openai-completions",
  model: "gpt-4o",
  apiKey: "sk-...",
  baseURL: "https://api.openai.com/v1",
});

const result = await agent.prompt("What files are in this project?");
console.log(result.text);
```

The `apiType` is auto-detected from model name — models containing `gpt-`, `o1`, `o3`, `deepseek`, `qwen`, `mistral`, etc. automatically use `openai-completions`.

`apiType` 也可以根据模型名自动推断：包含 `gpt-`、`o1`、`o3`、`deepseek`、`qwen`、`mistral` 等关键字时，会自动选择 `openai-completions`。

### 7. Web demo / Web 演示

```bash
npm run web
# Open http://localhost:8081
```

Use this when you want a fast local sandbox for prompt-tool behavior and event streaming.

如果你想快速验证 prompt、tool 调用和事件流，这个本地 Web 演示是最快的入口。

## More examples / 更多示例

### Multi-turn conversation

```typescript
import { createAgent } from "clavue-agent-sdk";

const agent = createAgent({ maxTurns: 5 });

const r1 = await agent.prompt(
  'Create a file /tmp/hello.txt with "Hello World"',
);
console.log(r1.text);

const r2 = await agent.prompt("Read back the file you just created");
console.log(r2.text);

console.log(`Session messages: ${agent.getMessages().length}`);
```

### Custom tools (Zod schema)

```typescript
import { z } from "zod";
import { query, tool, createSdkMcpServer } from "clavue-agent-sdk";

const getWeather = tool(
  "get_weather",
  "Get the temperature for a city",
  { city: z.string().describe("City name") },
  async ({ city }) => ({
    content: [{ type: "text", text: `${city}: 22°C, sunny` }],
  }),
);

const server = createSdkMcpServer({ name: "weather", tools: [getWeather] });

for await (const msg of query({
  prompt: "What is the weather in Tokyo?",
  options: { mcpServers: { weather: server } },
})) {
  if (msg.type === "result")
    console.log(`Done: $${msg.total_cost_usd?.toFixed(4)}`);
}
```

### Custom tools (low-level)

```typescript
import {
  createAgent,
  getAllBaseTools,
  defineTool,
} from "clavue-agent-sdk";

const calculator = defineTool({
  name: "Calculator",
  description: "Evaluate a math expression",
  inputSchema: {
    type: "object",
    properties: { expression: { type: "string" } },
    required: ["expression"],
  },
  isReadOnly: true,
  async call(input) {
    const result = Function(`'use strict'; return (${input.expression})`)();
    return `${input.expression} = ${result}`;
  },
});

const agent = createAgent({ tools: [...getAllBaseTools(), calculator] });
const r = await agent.prompt("Calculate 2**10 * 3");
console.log(r.text);
```

### Skills

Skills are reusable executable workflows that extend agent capabilities. Bundled skills include coding/review helpers such as `simplify`, `commit`, `review`, `debug`, and `test`, plus lifecycle workflows such as `define`, `plan`, `build`, `verify`, `workflow-review`, `ship`, and `repair`.

```typescript
import {
  createAgent,
  registerSkill,
  getAllSkills,
} from "clavue-agent-sdk";

// Register a custom skill
registerSkill({
  name: "explain",
  description: "Explain a concept in simple terms",
  userInvocable: true,
  async getPrompt(args) {
    return [
      {
        type: "text",
        text: `Explain in simple terms: ${args || "Ask what to explain."}`,
      },
    ];
  },
});

console.log(`${getAllSkills().length} skills registered`);

// The model can invoke skills via the Skill tool
const agent = createAgent();
const result = await agent.prompt('Use the "explain" skill to explain git rebase');
console.log(result.text);
```

Skills can also run in a forked subagent context by setting `context: "fork"`. Forked skills create durable background AgentJobs, inherit the parent provider and permission policy, apply skill-level `model` and `allowedTools`, and preserve the subagent `trace`, `evidence`, and `quality_gates` on the final job record.

```typescript
import {
  SkillTool,
  getAgentJob,
  registerAgents,
  registerSkill,
} from "clavue-agent-sdk";

registerAgents({
  reviewer: {
    description: "Specialized review agent",
    prompt: "Review carefully and produce concise findings.",
    tools: ["Read", "Glob", "Grep"],
  },
}, { runtimeNamespace: "docs-forked-skill" });

registerSkill({
  name: "deep-review",
  description: "Run a durable background code review",
  context: "fork",
  agent: "reviewer",
  allowedTools: ["Read", "Glob", "Grep"],
  model: "gpt-5.4",
  userInvocable: true,
  async getPrompt(args) {
    return [{ type: "text", text: `Review this target: ${args}` }];
  },
}, { runtimeNamespace: "docs-forked-skill" });

const result = await SkillTool.call(
  { skill: "deep-review", args: "src/agent.ts" },
  {
    cwd: process.cwd(),
    runtimeNamespace: "docs-forked-skill",
    model: "gpt-5.4",
    provider,
  },
);

const { job_id } = JSON.parse(String(result.content));
const job = await getAgentJob(job_id, { runtimeNamespace: "docs-forked-skill" });
console.log(job?.status, job?.trace, job?.evidence, job?.quality_gates);
```

### Self-improvement memory

Enable `selfImprovement` when you want each structured run to capture reusable operational lessons for future runs. It is opt-in and stores bounded `improvement` memories after `Agent.run()` / top-level `run()` completes.

```typescript
import { createAgent, queryMemories } from "clavue-agent-sdk";

const agent = createAgent({
  cwd: process.cwd(),
  memory: {
    enabled: true,
    autoInject: true,
    repoPath: process.cwd(),
  },
  selfImprovement: {
    memory: {
      repoPath: process.cwd(),
      maxEntriesPerRun: 4,
    },
  },
});

try {
  const run = await agent.run("Verify the package release is ready.");
  console.log(run.self_improvement?.savedMemories.length ?? 0);

  const lessons = await queryMemories({
    repoPath: process.cwd(),
    type: "improvement",
    text: "package release verification",
    limit: 5,
  });
  console.log(lessons.map((lesson) => lesson.title));
} finally {
  await agent.close();
}
```

By default this captures failed tool-result signals and terminal run failures. Successful run patterns are only saved when `selfImprovement.memory.captureSuccessfulRuns` is explicitly enabled. Captured text is trimmed, common API keys and bearer tokens are redacted, and future runs must still verify current repo state before applying a remembered lesson.

默认只捕获工具失败信号和 run 终态失败；只有显式设置 `captureSuccessfulRuns` 时才会记录成功模式。记录内容会裁剪并脱敏常见 API key / bearer token，未来 run 使用这些经验前仍需要验证当前仓库状态。

You can combine run learning with the deterministic retro/eval cycle, and optionally allow a bounded retry loop guarded by verification gates:

```typescript
const run = await agent.run("Improve this SDK safely.", {
  selfImprovement: {
    memory: { repoPath: process.cwd() },
    retro: {
      enabled: true,
      targetName: "clavue-agent-sdk",
      gates: [
        { name: "build", command: "npm", args: ["run", "build"] },
        { name: "test", command: "npm", args: ["test"] },
      ],
      loop: {
        enabled: true,
        maxAttempts: 3,
        retryPrompt: "Fix the highest-priority verified issue, then stop.",
      },
    },
  },
});

console.log(run.self_improvement?.retroLoop?.summary.completedAttempts);
console.log(run.self_improvement?.retroCycle?.summary.statusLine);
```

Nested retry runs automatically disable nested `selfImprovement` capture to keep the loop bounded. `retroCycle` always points at the final cycle for compatibility; `retroLoop` contains every cycle and retry lineage when loop mode is enabled.

Exported helpers: `extractRunImprovementCandidates(run, config, options)` for dry-run extraction and `runSelfImprovement(run, config, options)` for direct persistence/retro orchestration.

### Retro / eval core

Run a deterministic engine-level evaluation loop and get structured findings, scores, and upgrade workstreams. `createDefaultRetroEvaluators()` inspects package/import/build/test/onboarding readiness across the four core dimensions:

```typescript
import {
  createDefaultRetroEvaluators,
  runRetroEvaluation,
} from "clavue-agent-sdk";

const evaluators = createDefaultRetroEvaluators();

const result = await runRetroEvaluation({
  target: { name: "my-project", cwd: process.cwd() },
  evaluators,
});

console.log(result.scores.overall.score);
console.log(result.proposed_workstreams);
```

Run the full retro cycle in one call:

```typescript
import {
  createDefaultRetroEvaluators,
  runRetroCycle,
} from "clavue-agent-sdk";

const cycle = await runRetroCycle({
  target: { name: "my-project", cwd: process.cwd() },
  evaluators: createDefaultRetroEvaluators(),
  gates: [
    { name: "build", command: "npm", args: ["run", "build"] },
    { name: "test", command: "npm", args: ["test"] },
  ],
  runId: "run-current",
  previousRunId: "run-previous",
  policy: { maxAttempts: 3 },
});

console.log(cycle.run.summary);
console.log(cycle.verification?.summary);
console.log(cycle.action.kind);
console.log(cycle.decision.disposition); // accepted | rejected | retry
console.log(cycle.summary.statusLine);
console.log(cycle.summary.text);
```

Or use the built-in defaults with just a target:

```typescript
import { runRetroCycle } from "clavue-agent-sdk";

const cycle = await runRetroCycle({
  target: { name: "my-project", cwd: process.cwd() },
});

console.log(cycle.verification?.gates.map((gate) => gate.name)); // ["build", "test"]
```

Persist a run for later comparison:

```typescript
import {
  compareRetroRuns,
  loadRetroCycle,
  loadRetroRun,
  saveRetroCycle,
  saveRetroRun,
} from "clavue-agent-sdk";

await saveRetroRun("run-2026-04-14", result);
await saveRetroCycle("cycle-2026-04-14", cycle);
const previous = await loadRetroRun("run-2026-04-13");
const previousCycle = await loadRetroCycle("cycle-2026-04-13");

if (previous) {
  const drift = compareRetroRuns(previous, result);
  console.log(drift.scoreDeltas.overall.delta);
  console.log(drift.newFindings);
}

console.log(previousCycle?.decision.disposition);
```

Run fixed quality gates before or after a retro pass:

```typescript
import { runRetroVerification } from "clavue-agent-sdk";

const verification = await runRetroVerification({
  target: { name: "my-project", cwd: process.cwd() },
  gates: [
    { name: "build", command: "npm", args: ["run", "build"] },
    { name: "test", command: "npm", args: ["test"] },
  ],
});

console.log(verification.passed);
console.log(verification.gates);
```

Decide the next machine action from retro state:

```typescript
import {
  compareRetroRuns,
  decideRetroAction,
  loadRetroRun,
  runRetroEvaluation,
  runRetroVerification,
  saveRetroRun,
} from "clavue-agent-sdk";

const verification = await runRetroVerification({
  target: { name: "my-project", cwd: process.cwd() },
});

const current = await runRetroEvaluation({
  target: { name: "my-project", cwd: process.cwd() },
  evaluators,
});

const previous = await loadRetroRun("run-previous");
const comparison = previous ? compareRetroRuns(previous, current) : undefined;
const action = decideRetroAction({
  run: current,
  verification,
  previousRun: previous ?? undefined,
  comparison,
  attemptCount: 0,
  policy: { maxAttempts: 3 },
});

await saveRetroRun("run-current", current);
console.log(verification.summary);
console.log(action.kind);
```

### Hooks (lifecycle events)

```typescript
import { createAgent, createHookRegistry } from "clavue-agent-sdk";

const hooks = createHookRegistry({
  PreToolUse: [
    {
      handler: async (input) => {
        console.log(`About to use: ${input.toolName}`);
        // Return { block: true } to prevent tool execution
      },
    },
  ],
  PostToolUse: [
    {
      handler: async (input) => {
        console.log(`Tool ${input.toolName} completed`);
      },
    },
  ],
});
```

20 lifecycle events: `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `SessionStart`, `SessionEnd`, `Stop`, `SubagentStart`, `SubagentStop`, `UserPromptSubmit`, `PermissionRequest`, `PermissionDenied`, `TaskCreated`, `TaskCompleted`, `ConfigChange`, `CwdChanged`, `FileChanged`, `Notification`, `PreCompact`, `PostCompact`, `TeammateIdle`.

### MCP server integration

```typescript
import { createAgent } from "clavue-agent-sdk";

const agent = createAgent({
  mcpServers: {
    filesystem: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    },
  },
});

const result = await agent.prompt("List files in /tmp");
console.log(result.text);
await agent.close();
```

### Subagents

```typescript
import { query } from "clavue-agent-sdk";

for await (const msg of query({
  prompt: "Use the code-reviewer agent to review src/index.ts",
  options: {
    agents: {
      "code-reviewer": {
        description: "Expert code reviewer",
        prompt: "Analyze code quality. Focus on security and performance.",
        tools: ["Read", "Glob", "Grep"],
      },
    },
  },
})) {
  if (msg.type === "result") console.log("Done");
}
```

### Durable background AgentJobs

Use `AgentTool` with `run_in_background: true` when a subagent should continue without blocking the parent turn. The tool returns a durable job envelope immediately:

```json
{
  "success": true,
  "type": "clavue.agent.job",
  "version": 1,
  "job_id": "agent_job_...",
  "status": "queued"
}
```

The job is persisted under the current runtime namespace, stores final output, trace, evidence, quality gates, errors, and heartbeat status, and can be inspected or cancelled through tools or SDK APIs.

```typescript
import {
  AgentTool,
  AgentJobListTool,
  AgentJobGetTool,
  AgentJobStopTool,
  getAgentJob,
  listAgentJobs,
} from "clavue-agent-sdk";

const context = {
  cwd: process.cwd(),
  runtimeNamespace: "docs-background-demo",
  model: "gpt-5.4",
  provider,
};

const started = await AgentTool.call({
  prompt: "Review src/ for security risks.",
  description: "security review",
  subagent_type: "Explore",
  run_in_background: true,
}, context);

const { job_id } = JSON.parse(String(started.content));
console.log(await listAgentJobs({ runtimeNamespace: context.runtimeNamespace }));
console.log(await getAgentJob(job_id, { runtimeNamespace: context.runtimeNamespace }));

await AgentJobListTool.call({}, context);
await AgentJobGetTool.call({ id: job_id }, context);
await AgentJobStopTool.call({ id: job_id, reason: "no longer needed" }, context);
```

Exported helpers include `createAgentJob()`, `getAgentJob()`, `listAgentJobs()`, `stopAgentJob()`, `clearAgentJobs()`, and the public types `AgentJobRecord`, `AgentJobStatus`, `AgentJobKind`, `AgentJobCompletion`, `AgentJobStoreOptions`, and `CreateAgentJobInput`.

`AgentJob` storage defaults to `~/.clavue-agent-sdk/agent-jobs`; set `CLAVUE_AGENT_JOBS_DIR` or pass `AgentJobStoreOptions.dir` to isolate stores in tests or multi-tenant hosts.

### Permissions and tool execution safety

```typescript
import { query } from "clavue-agent-sdk";

// Trusted automation is the default; restrict tools for a read-only agent.
for await (const msg of query({
  prompt: "Review the code in src/ for best practices.",
  options: {
    toolsets: ["repo-readonly"],
    disallowedTools: ["WebSearch"],
    canUseTool: async (tool, input) => {
      if (tool.name === "Read") return { behavior: "allow" };
      return { behavior: "allow", updatedInput: input };
    },
  },
})) {
  // ...
}
```

Tool access is controlled in layers: `toolsets` and `allowedTools` choose the available tool names, `disallowedTools` removes names last, `canUseTool` can deny or rewrite a specific tool input, and hooks can block lifecycle events. Subagents inherit the parent permission policy.

工具访问按层控制：`toolsets` 和 `allowedTools` 选择可用工具名，`disallowedTools` 最后移除工具名，`canUseTool` 可以拒绝或改写单次工具输入，hooks 可以拦截生命周期事件。Subagent 会继承父 agent 的权限策略。

`permissionMode` also has built-in semantics. `default` allows read-only tools only. `plan` freezes mutating tools while allowing planning/read tools. `acceptEdits` allows local file edits but blocks shell, network, external-state, destructive, or approval-required tools. `trustedAutomation` and `bypassPermissions` are high-trust modes; still use `allowedTools`, `disallowedTools`, and `canUseTool` for least privilege.

`permissionMode` 也有内置语义。`default` 只允许只读工具。`plan` 会冻结修改型工具，同时允许规划和读取工具。`acceptEdits` 允许本地文件编辑，但会阻止 shell、网络、外部状态、破坏性或需要审批的工具。`trustedAutomation` 和 `bypassPermissions` 是高信任模式；生产环境仍建议配合 `allowedTools`、`disallowedTools` 和 `canUseTool` 做最小权限控制。

The engine only parallelizes tool calls when a tool declares both `isReadOnly()` and `isConcurrencySafe()`. Mutating tools and read-only tools that are not concurrency-safe run serially. Set `maxToolConcurrency` per run to cap safe parallel batches; when omitted, `AGENT_SDK_MAX_TOOL_CONCURRENCY` is used as the fallback. Invalid, zero, or negative values fall back to `10` so runs do not hang. Run traces include `tool_concurrency_limit`, `tool_concurrency_source`, and the existing `concurrency_batches`.

引擎只会并行执行同时声明 `isReadOnly()` 与 `isConcurrencySafe()` 的工具调用。会修改状态的工具，以及只读但非并发安全的工具，会串行执行。可通过每次运行的 `maxToolConcurrency` 限制安全并行批次；未设置时回退使用 `AGENT_SDK_MAX_TOOL_CONCURRENCY`。无效、零或负数会回退到 `10`，避免运行卡住。运行 trace 会包含 `tool_concurrency_limit`、`tool_concurrency_source` 和已有的 `concurrency_batches`。

### Provider retries and tolerance

Provider calls automatically retry transient API and network failures with exponential backoff. Retryable conditions include rate limits, common 5xx/overload statuses, fetch/socket failures, and `Retry-After` headers; abort signals are honored during backoff.

Provider 调用会对临时 API 和网络失败自动指数退避重试。可重试场景包括限流、常见 5xx/overload 状态、fetch/socket 失败以及 `Retry-After` 响应头；退避等待期间会响应 abort signal。

For OpenAI-compatible GPT-5 models, the SDK uses the Responses API by default and falls back to Chat Completions when a gateway does not support `/responses`. Incomplete Responses output caused by output-token limits maps to `max_tokens` so the engine can continue; failed or cancelled Responses runs surface as errors instead of empty text.

对于 OpenAI 兼容的 GPT-5 模型，SDK 默认使用 Responses API；如果网关不支持 `/responses`，会回退到 Chat Completions。因输出 token 限制导致的 incomplete Responses 会映射为 `max_tokens`，方便引擎继续；failed 或 cancelled 的 Responses 会以错误暴露，而不是返回空文本。

### Web UI

A built-in web chat interface is included for testing:

```bash
npx tsx examples/web/server.ts
# Open http://localhost:8081
```

## API reference

### Which API should I use? / 应该使用哪个 API？

| Need / 需求 | Use / 使用 |
| ----------- | ---------- |
| Terminal or CI one-off task / 终端或 CI 一次性任务 | `npx clavue-agent-sdk "prompt"` |
| Simplest Node.js integration / 最简单 Node.js 集成 | `run({ prompt, options })` |
| Streaming UI or progress logs / 流式 UI 或进度日志 | `query({ prompt, options })` |
| Multi-turn service, sessions, MCP, hooks / 多轮服务、会话、MCP、hooks | `createAgent(options)` |

### Program logic / 程序逻辑

1. Your app calls `run()`, `query()`, or a reusable `agent.prompt()` / `agent.query()`.
2. The SDK builds the system context from options, repo context files, git status, tools, MCP servers, skills, hooks, and permission policy.
3. The provider layer sends normalized messages and tool schemas to Anthropic Messages or an OpenAI-compatible chat endpoint.
4. When the model requests a tool, the engine applies allow/deny filters, `canUseTool`, permission mode, and hooks, then executes the tool.
5. Tool results are appended to the conversation and the engine repeats until the provider returns a final answer or the run reaches limits.
6. The SDK returns either streaming `SDKMessage` events or a structured `AgentRunResult` artifact, reusable agents can persist sessions under `~/.clavue-agent-sdk`, and background AgentJobs persist under `~/.clavue-agent-sdk/agent-jobs`.

### Top-level functions

| Function                              | Description                                                    |
| ------------------------------------- | -------------------------------------------------------------- |
| `run({ prompt, options })`            | One-shot blocking run, returns `Promise<AgentRunResult>`       |
| `query({ prompt, options })`          | One-shot streaming query, returns `AsyncGenerator<SDKMessage>` |
| `createAgent(options)`                | Create a reusable agent with session persistence               |
| `tool(name, desc, schema, handler)`   | Create a tool with Zod schema validation                       |
| `createSdkMcpServer({ name, tools })` | Bundle tools into an in-process MCP server                     |
| `defineTool(config)`                  | Low-level tool definition helper                               |
| `doctor(options)`                     | Run structured provider, tool, skill, MCP, storage, and package checks |
| `runBenchmarks(options)`              | Run offline benchmark metrics without live model calls         |
| `getAllBaseTools()`                   | Get all 35+ built-in tools                                     |
| `registerSkill(definition)`           | Register a custom skill                                        |
| `getAllSkills()`                       | Get all registered skills                                      |
| `createAgentJob(input, opts)`         | Create a durable background agent job record                   |
| `getAgentJob(id, opts)`               | Read a durable background job by ID                            |
| `listAgentJobs(opts)`                 | List durable background jobs in a runtime namespace            |
| `stopAgentJob(id, reason, opts)`      | Cancel a queued or running background job                      |
| `clearAgentJobs(opts)`                | Clear background jobs for a runtime namespace                  |
| `runSelfImprovement(run, config, opts)` | Persist bounded improvement memories and optionally run retro/eval feedback |
| `extractRunImprovementCandidates(run, config, opts)` | Inspect which improvement memories a run would generate |
| `runRetroEvaluation(input)`           | Run deterministic retro/eval orchestration and return typed results |
| `createDefaultRetroEvaluators()`      | Inspect package/import/build/test/onboarding readiness across the core dimensions |
| `compareRetroRuns(previous, current)` | Compare two retro runs for score deltas and finding drift      |
| `decideRetroAction(input)`            | Decide the next machine action from current retro state        |
| `runRetroVerification(input)`         | Run fixed quality gates and return pass/fail command results   |
| `runRetroCycle(input)`                | Run evaluation, verification, policy, comparison, and optional persistence in one call |
| `saveRetroRun(runId, result, opts)`   | Persist a retro run result to the run ledger                   |
| `loadRetroRun(runId, opts)`           | Load a persisted retro run result from the run ledger          |
| `saveRetroCycle(cycleId, result, opts)` | Persist a full retro cycle result including decision and summary |
| `loadRetroCycle(cycleId, opts)`         | Load a persisted retro cycle result from the run ledger        |
| `normalizeFindings(findings)`         | Normalize retro findings into a stable schema                  |
| `scoreFindings(findings)`             | Compute per-dimension and overall retro scores                 |
| `planUpgrades(findings)`              | Turn retro findings into prioritized workstreams               |
| `createProvider(apiType, opts)`        | Create an LLM provider directly                                |
| `createHookRegistry(config)`          | Create a hook registry for lifecycle events                    |
| `listSessions()`                      | List persisted sessions                                        |
| `forkSession(id)`                     | Fork a session for branching                                   |

### Agent methods

| Method                          | Description                                           |
| ------------------------------- | ----------------------------------------------------- |
| `agent.query(prompt)`           | Streaming query, returns `AsyncGenerator<SDKMessage>` |
| `agent.run(text, overrides)`    | Blocking run, returns full `AgentRunResult` including `self_improvement` when enabled |
| `agent.prompt(text)`            | Blocking query, returns `Promise<QueryResult>`        |
| `agent.getMessages()`           | Get conversation history                              |
| `agent.clear()`                 | Reset session                                         |
| `agent.interrupt()`             | Abort current query                                   |
| `agent.setModel(model)`         | Change model mid-session                              |
| `agent.setPermissionMode(mode)` | Change permission mode                                |
| `agent.stopTask(id)`            | Stop a durable AgentJob by ID, then fall back to legacy task cancellation |
| `agent.getApiType()`            | Get current API type                                  |
| `agent.close()`                 | Close MCP connections, persist session                |

### Options

| Option               | Type                                    | Default                | Description                                                          |
| -------------------- | --------------------------------------- | ---------------------- | -------------------------------------------------------------------- |
| `apiType`            | `string`                                | auto-detected          | `'anthropic-messages'` or `'openai-completions'`                     |
| `model`              | `string`                                | `claude-sonnet-4-6`    | LLM model ID                                                         |
| `apiKey`             | `string`                                | `CLAVUE_AGENT_API_KEY`      | API key                                                              |
| `baseURL`            | `string`                                | —                      | Custom API endpoint                                                  |
| `cwd`                | `string`                                | `process.cwd()`        | Working directory                                                    |
| `systemPrompt`       | `string`                                | —                      | System prompt override                                               |
| `appendSystemPrompt` | `string`                                | —                      | Append to default system prompt                                      |
| `tools`              | `ToolDefinition[]`                      | All built-in           | Available tools                                                      |
| `toolsets`           | `ToolsetName[]`                         | —                      | Named built-in tool groups                                           |
| `allowedTools`       | `string[]`                              | —                      | Tool allow-list                                                      |
| `disallowedTools`    | `string[]`                              | —                      | Tool deny-list                                                       |
| `permissionMode`     | `string`                                | `trustedAutomation`    | `trustedAutomation` / `auto` / `default` / `acceptEdits` / `dontAsk` / `bypassPermissions` / `plan` |
| `canUseTool`         | `function`                              | allow all              | Custom tool guard or input modifier                                  |
| `qualityGatePolicy`  | `QualityGatePolicy`                     | —                      | Mark a successful run as failed when required quality gates fail or are missing |
| `maxTurns`           | `number`                                | `10`                   | Max agentic turns                                                    |
| `maxToolConcurrency` | `number`                                | env or `10`            | Max concurrent read-only concurrency-safe tool calls per batch       |
| `maxBudgetUsd`       | `number`                                | —                      | Spending cap                                                         |
| `thinking`           | `ThinkingConfig`                        | `{ type: 'adaptive' }` | Extended thinking                                                    |
| `effort`             | `string`                                | `high`                 | Reasoning effort: `low` / `medium` / `high` / `max`                  |
| `mcpServers`         | `Record<string, McpServerConfig>`       | —                      | MCP server connections                                               |
| `agents`             | `Record<string, AgentDefinition>`       | —                      | Subagent definitions                                                 |
| `hooks`              | `Record<string, HookCallbackMatcher[]>` | —                      | Lifecycle hooks                                                      |
| `memory`             | `MemoryConfig`                          | —                      | Structured memory injection, `off` / `autoInject` / `brainFirst` policy, and session-summary persistence |
| `selfImprovement`    | `boolean \| SelfImprovementConfig`       | `false`                | Opt-in run learning via improvement memories and optional retro cycle |
| `resume`             | `string`                                | —                      | Resume session by ID                                                 |
| `continue`           | `boolean`                               | `false`                | Continue most recent session                                         |
| `persistSession`     | `boolean`                               | `true`                 | Persist session to disk                                              |
| `sessionId`          | `string`                                | auto                   | Explicit session ID                                                  |
| `outputFormat`       | `{ type: 'json_schema', schema }`       | —                      | Structured output                                                    |
| `sandbox`            | `SandboxSettings`                       | —                      | Filesystem/network sandbox                                           |
| `settingSources`     | `SettingSource[]`                       | —                      | Load AGENT.md, project settings                                      |
| `env`                | `Record<string, string>`                | —                      | Environment variables                                                |
| `abortController`    | `AbortController`                       | —                      | Cancellation controller                                              |

### Named toolsets

Use `toolsets` in the SDK or `--toolset` in the CLI to enable named groups of built-in tools without listing every tool name. The SDK also exports `TOOLSET_NAMES`, `isToolsetName()`, and `getToolsetTools()` for validation and UI generation.

在 SDK 中使用 `toolsets`，或在 CLI 中使用 `--toolset`，可以启用命名的内置工具组，而不必逐个列出工具名。SDK 也导出 `TOOLSET_NAMES`、`isToolsetName()` 和 `getToolsetTools()`，方便做校验或生成 UI。

```typescript
import { TOOLSET_NAMES, getToolsetTools, isToolsetName, run } from "clavue-agent-sdk";

const selected = "repo-readonly";
if (!isToolsetName(selected)) throw new Error("Unknown toolset");

const result = await run({
  prompt: "Review this repository and check current docs.",
  options: {
    toolsets: [selected, "research"],
    disallowedTools: ["WebSearch"],
  },
});

console.log(TOOLSET_NAMES);
console.log(getToolsetTools([selected]));
```

| Toolset         | Tools                                                                 |
| --------------- | --------------------------------------------------------------------- |
| `repo-readonly` | `Read`, `Glob`, `Grep`                                                |
| `repo-edit`     | `Read`, `Write`, `Edit`, `Glob`, `Grep`, `NotebookEdit`               |
| `research`      | `WebFetch`, `WebSearch`                                               |
| `planning`      | `EnterPlanMode`, `ExitPlanMode`, `AskUserQuestion`, `TodoWrite`       |
| `tasks`         | `TaskCreate`, `TaskList`, `TaskUpdate`, `TaskGet`, `TaskStop`, `TaskOutput` |
| `automation`    | `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`               |
| `agents`        | `Agent`, `AgentJobList`, `AgentJobGet`, `AgentJobStop`, `SendMessage`, `TeamCreate`, `TeamDelete` |
| `mcp`           | `ListMcpResources`, `ReadMcpResource`                                 |
| `skills`        | `Skill`                                                               |

`toolsets` are merged with `allowedTools`; `disallowedTools` is applied last and can remove tools from either source. For example, `toolsets: ["repo-readonly"]` plus `allowedTools: ["WebFetch"]` enables `Read`, `Glob`, `Grep`, and `WebFetch`; adding `disallowedTools: ["Grep"]` removes `Grep`.

`toolsets` 会与 `allowedTools` 合并；`disallowedTools` 最后应用，可以从任一来源移除工具。例如，`toolsets: ["repo-readonly"]` 加 `allowedTools: ["WebFetch"]` 会启用 `Read`、`Glob`、`Grep` 和 `WebFetch`；再加 `disallowedTools: ["Grep"]` 会移除 `Grep`。

### Environment variables

| Variable             | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `CLAVUE_AGENT_API_KEY`    | API key (required)                                       |
| `CLAVUE_AGENT_API_TYPE`   | `anthropic-messages` (default) or `openai-completions`   |
| `CLAVUE_AGENT_MODEL`      | Default model override                                   |
| `CLAVUE_AGENT_BASE_URL`   | Custom API endpoint                                      |
| `CLAVUE_AGENT_AUTH_TOKEN` | Alternative auth token                                   |
| `CLAVUE_AGENT_JOBS_DIR`   | Override durable AgentJob storage directory              |
| `AGENT_SDK_MAX_TOOL_CONCURRENCY` | Max concurrent batch size for tools that are both read-only and concurrency-safe; invalid values fall back to `10` |

## Built-in tools

Filesystem tools resolve paths relative to `cwd` but may access absolute paths when the host exposes them. For least privilege, combine `cwd`, `toolsets`, `allowedTools`/`disallowedTools`, `canUseTool`, and `sandbox` settings at the application boundary.

文件系统工具会相对 `cwd` 解析路径，但当宿主环境暴露绝对路径时也可能访问绝对路径。最小权限部署时，请在应用边界组合使用 `cwd`、`toolsets`、`allowedTools`/`disallowedTools`、`canUseTool` 与 `sandbox` 设置。

Session IDs are validated before disk access so persisted transcripts cannot escape the configured session store via absolute paths, `..`, or null-byte input. For multi-tenant hosts, also isolate `session.dir`, `CLAVUE_AGENT_JOBS_DIR`, and `runtimeNamespace` per tenant.

Session ID 在访问磁盘前会进行校验，持久化 transcript 不能通过绝对路径、`..` 或空字节输入逃逸配置的 session store。多租户宿主还应为每个租户隔离 `session.dir`、`CLAVUE_AGENT_JOBS_DIR` 与 `runtimeNamespace`。

| Tool                                       | Description                                  |
| ------------------------------------------ | -------------------------------------------- |
| **Bash**                                   | Execute shell commands                       |
| **Read**                                   | Read files with line numbers                 |
| **Write**                                  | Create / overwrite files                     |
| **Edit**                                   | Precise string replacement in files          |
| **Glob**                                   | Find files by pattern                        |
| **Grep**                                   | Search file contents with regex              |
| **WebFetch**                               | Fetch and parse web content                  |
| **WebSearch**                              | Search the web                               |
| **NotebookEdit**                           | Edit Jupyter notebook cells                  |
| **Agent**                                  | Spawn subagents for parallel work            |
| **AgentJobList/Get/Stop**                  | Inspect and cancel durable background AgentJobs |
| **Skill**                                  | Invoke registered skills                     |
| **TaskCreate/List/Update/Get/Stop/Output** | Task management system                       |
| **TeamCreate/Delete**                      | Multi-agent team coordination                |
| **SendMessage**                            | Inter-agent messaging                        |
| **EnterWorktree/ExitWorktree**             | Git worktree isolation                       |
| **EnterPlanMode/ExitPlanMode**             | Structured planning workflow                 |
| **AskUserQuestion**                        | Ask the user for input                       |
| **ToolSearch**                             | Discover lazy-loaded tools                   |
| **ListMcpResources/ReadMcpResource**       | MCP resource access                          |
| **CronCreate/Delete/List**                 | Scheduled task management                    |
| **RemoteTrigger**                          | Remote agent triggers                        |
| **LSP**                                    | Language Server Protocol (code intelligence) |
| **Config**                                 | Dynamic configuration                        |
| **TodoWrite**                              | Session todo list                            |

## Bundled skills

| Skill        | Description                                                    |
| ------------ | -------------------------------------------------------------- |
| `simplify`   | Review changed code for reuse, quality, and efficiency         |
| `commit`     | Create a git commit with a well-crafted message                |
| `review`     | Review code changes for correctness, security, and performance |
| `debug`      | Systematic debugging using structured investigation            |
| `test`       | Run tests and analyze failures                                 |
| `define`     | Define goals, constraints, assumptions, and acceptance criteria |
| `plan`       | Produce an ordered implementation plan and verification strategy |
| `build`      | Implement scoped changes while preserving local patterns        |
| `verify`     | Run targeted checks and report evidence                         |
| `workflow-review` | Review lifecycle work for defects, risks, and missing evidence |
| `ship`       | Prepare a handoff or release summary with verification status   |
| `repair`     | Diagnose and fix failed workflow outcomes with recovery evidence |

Register custom skills with `registerSkill()`.

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                   Your Application                    │
│                                                       │
│   import { createAgent } from 'clavue-agent-sdk' │
└────────────────────────┬─────────────────────────────┘
                         │
              ┌──────────▼──────────┐
              │       Agent         │  Session state, tool pool,
              │  query() / prompt() │  MCP connections, hooks
              └──────────┬──────────┘
                         │
              ┌──────────▼──────────┐
              │    QueryEngine      │  Agentic loop:
              │   submitMessage()   │  API call → tools → repeat
              └──────────┬──────────┘
                         │
         ┌───────────────┼───────────────┐
         │               │               │
   ┌─────▼─────┐  ┌─────▼─────┐  ┌─────▼─────┐
   │  Provider  │  │  35 Tools │  │    MCP     │
   │ Anthropic  │  │ Bash,Read │  │  Servers   │
   │  OpenAI    │  │ Edit,...  │  │ stdio/SSE/ │
   │ DeepSeek   │  │ + Skills  │  │ HTTP/SDK   │
   └───────────┘  └───────────┘  └───────────┘
```

**Key internals:**

| Component             | Description                                                        |
| --------------------- | ------------------------------------------------------------------ |
| **Provider layer**    | Abstracts Anthropic / OpenAI API differences                       |
| **QueryEngine**       | Core agentic loop with auto-compact, retry, safe tool orchestration |
| **Skill system**      | Reusable executable workflows with bundled coding, review, test, and lifecycle skills |
| **Hook system**       | 20 lifecycle events integrated into the engine                     |
| **Auto-compact**      | Summarizes conversation when context window fills up               |
| **Micro-compact**     | Truncates oversized tool results                                   |
| **Retry**             | Exponential backoff for rate limits, transient errors, and Retry-After responses |
| **Token estimation**  | Rough token counting with pricing for Claude, GPT, DeepSeek models |
| **File cache**        | LRU cache (100 entries, 25 MB) for file reads                      |
| **Session storage**   | Persist / resume / fork sessions on disk                           |
| **AgentJob storage**  | Durable background subagent records with output, trace, evidence, quality gates, cancellation, and stale-heartbeat detection |
| **Structured memory** | Queryable user/project/reference/feedback/decision/improvement entries |
| **Self-improvement**  | Opt-in run learning from failures plus optional retro verification  |
| **Context injection** | Git status + AGENT.md automatically injected into system prompt    |

## Automation roadmap

- **Telemetry and evals:** turn run artifacts into scoreable, replayable traces without exposing secrets.
- **Policy learning:** promote repeated safe corrections into durable tool and permission policies.
- **Tool success modeling:** track which tools, arguments, and gates succeed for similar repository states.
- **Autonomous retry loops:** feed failures into bounded repair attempts guarded by verification gates.
- **Cross-project memory governance:** keep global lessons useful while requiring repo-state verification before reuse.

## Examples

| #   | File                                  | Description                            |
| --- | ------------------------------------- | -------------------------------------- |
| 01  | `examples/01-simple-query.ts`         | Streaming query with event handling    |
| 02  | `examples/02-multi-tool.ts`           | Multi-tool orchestration (Glob + Bash) |
| 03  | `examples/03-multi-turn.ts`           | Multi-turn session persistence         |
| 04  | `examples/04-prompt-api.ts`           | Blocking `prompt()` API                |
| 05  | `examples/05-custom-system-prompt.ts` | Custom system prompt                   |
| 06  | `examples/06-mcp-server.ts`           | MCP server integration                 |
| 07  | `examples/07-custom-tools.ts`         | Custom tools with `defineTool()`       |
| 08  | `examples/08-official-api-compat.ts`  | `query()` API pattern                  |
| 09  | `examples/09-subagents.ts`            | Subagent delegation                    |
| 10  | `examples/10-permissions.ts`          | Read-only agent with named toolsets    |
| 11  | `examples/11-custom-mcp-tools.ts`     | `tool()` + `createSdkMcpServer()`      |
| 12  | `examples/12-skills.ts`              | Skill system usage                     |
| 13  | `examples/13-hooks.ts`               | Lifecycle hooks                        |
| 14  | `examples/14-openai-compat.ts`       | OpenAI / DeepSeek models               |
| 15  | `examples/15-self-improvement.ts`    | Opt-in run learning and improvement memories |
| 16  | `examples/16-background-agent-jobs.ts` | Durable background AgentJob APIs       |
| web | `examples/web/`                       | Web chat UI for testing                |

Run the offline smoke-tested example:

```bash
npm run test:all
```

Run any live provider example:

```bash
npx tsx examples/01-simple-query.ts
```

Start the web UI:

```bash
npx tsx examples/web/server.ts
```

## GitHub, npm, and deployment / GitHub、npm 与部署

### Repository checklist / 仓库检查

- Keep `README.md`, `package.json`, and examples aligned when changing public APIs.
- Run `npm run build` and `npm test` before publishing or cutting a release.
- Use `npm pack --dry-run --json` to inspect the exact package payload.
- The package publishes only `dist/`; `prepack` runs `npm run build` so TypeScript output is generated before packing.

### Publish to npm / 发布到 npm

```bash
npm run build
npm test
npm pack --dry-run --json
npm publish --access public
```

The published package exposes two binaries:

```bash
npx clavue-agent-sdk "Summarize this repo"
npx clavue-agent "Summarize this repo"
```

### Deploy inside another service / 在其他服务中部署

For a server, worker, CI job, Docker image, or serverless function, install `clavue-agent-sdk`, provide `CLAVUE_AGENT_API_KEY`, restrict tools with `toolsets` or `allowedTools` when the agent only needs limited access, and call `run()` for single-shot jobs or `createAgent()` for long-lived sessions.

对于服务端、worker、CI、Docker 或 Serverless：安装 `clavue-agent-sdk`，提供 `CLAVUE_AGENT_API_KEY`；如果 agent 只需要有限能力，用 `toolsets` 或 `allowedTools` 限制工具；一次性任务用 `run()`，长会话用 `createAgent()`。

```typescript
import { run } from "clavue-agent-sdk";

export async function handleRepositorySummary(repoPath: string) {
  const result = await run({
    prompt: "Summarize this repository for onboarding.",
    options: {
      cwd: repoPath,
      toolsets: ["repo-readonly"],
      maxTurns: 5,
    },
  });

  return {
    ok: result.status === "completed",
    text: result.text,
    usage: result.usage,
  };
}
```

## Star History

<a href="https://www.star-history.com/?repos=mycode699%2Fclavue-agent-sdk&type=timeline&legend=top-left">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/image?repos=mycode699/clavue-agent-sdk&type=timeline&theme=dark&legend=top-left" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/image?repos=mycode699/clavue-agent-sdk&type=timeline&legend=top-left" />
   <img alt="Star History Chart" src="https://api.star-history.com/image?repos=mycode699/clavue-agent-sdk&type=timeline&legend=top-left" />
 </picture>
</a>

## License

MIT
