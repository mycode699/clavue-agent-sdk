# Clavue Agent SDK

[![npm version](https://img.shields.io/npm/v/clavue-agent-sdk)](https://www.npmjs.com/package/clavue-agent-sdk)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)

Clavue Agent SDK runs the full agent loop **in-process** — no subprocess and no local CLI dependency. It supports both **Anthropic** and **OpenAI-compatible** APIs, so you can embed the same agent runtime in cloud services, serverless jobs, Docker containers, and CI/CD workflows.

Clavue Agent SDK 在你的应用进程内直接运行完整 agent loop，**不需要子进程，也不依赖本地 CLI**。同时支持 **Anthropic** 与 **OpenAI-compatible** API，适合直接嵌入云服务、Serverless、Docker 与 CI/CD。

Also available in **Go**: [clavue-agent-sdk-go](https://github.com/mycode699/clavue-agent-sdk-go)

## Quick start / 快速开始

### 1. Install / 安装

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

### 3. First request / 第一个请求

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
}
```

### 4. Reusable agent / 可复用 Agent

```typescript
import { createAgent } from "clavue-agent-sdk";

const agent = createAgent({ model: "claude-sonnet-4-6" });
const result = await agent.prompt("What files are in this project?");

console.log(result.text);
console.log(
  `Turns: ${result.num_turns}, Tokens: ${result.usage.input_tokens + result.usage.output_tokens}`,
);
```

### 5. OpenAI / GPT models

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

### 6. Web demo / Web 演示

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

Skills are reusable prompt templates that extend agent capabilities. Five bundled skills are included: `simplify`, `commit`, `review`, `debug`, `test`.

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

### Permissions

```typescript
import { query } from "clavue-agent-sdk";

// Trusted automation is the default; restrict tools for a read-only agent.
for await (const msg of query({
  prompt: "Review the code in src/ for best practices.",
  options: {
    allowedTools: ["Read", "Glob", "Grep"],
  },
})) {
  // ...
}
```

### Web UI

A built-in web chat interface is included for testing:

```bash
npx tsx examples/web/server.ts
# Open http://localhost:8081
```

## API reference

### Top-level functions

| Function                              | Description                                                    |
| ------------------------------------- | -------------------------------------------------------------- |
| `query({ prompt, options })`          | One-shot streaming query, returns `AsyncGenerator<SDKMessage>` |
| `createAgent(options)`                | Create a reusable agent with session persistence               |
| `tool(name, desc, schema, handler)`   | Create a tool with Zod schema validation                       |
| `createSdkMcpServer({ name, tools })` | Bundle tools into an in-process MCP server                     |
| `defineTool(config)`                  | Low-level tool definition helper                               |
| `getAllBaseTools()`                   | Get all 35+ built-in tools                                     |
| `registerSkill(definition)`           | Register a custom skill                                        |
| `getAllSkills()`                       | Get all registered skills                                      |
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
| `agent.prompt(text)`            | Blocking query, returns `Promise<QueryResult>`        |
| `agent.getMessages()`           | Get conversation history                              |
| `agent.clear()`                 | Reset session                                         |
| `agent.interrupt()`             | Abort current query                                   |
| `agent.setModel(model)`         | Change model mid-session                              |
| `agent.setPermissionMode(mode)` | Change permission mode                                |
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
| `allowedTools`       | `string[]`                              | —                      | Tool allow-list                                                      |
| `disallowedTools`    | `string[]`                              | —                      | Tool deny-list                                                       |
| `permissionMode`     | `string`                                | `trustedAutomation`    | `trustedAutomation` / `auto` / `default` / `acceptEdits` / `dontAsk` / `bypassPermissions` / `plan` |
| `canUseTool`         | `function`                              | allow all              | Custom tool guard or input modifier                                  |
| `maxTurns`           | `number`                                | `10`                   | Max agentic turns                                                    |
| `maxBudgetUsd`       | `number`                                | —                      | Spending cap                                                         |
| `thinking`           | `ThinkingConfig`                        | `{ type: 'adaptive' }` | Extended thinking                                                    |
| `effort`             | `string`                                | `high`                 | Reasoning effort: `low` / `medium` / `high` / `max`                  |
| `mcpServers`         | `Record<string, McpServerConfig>`       | —                      | MCP server connections                                               |
| `agents`             | `Record<string, AgentDefinition>`       | —                      | Subagent definitions                                                 |
| `hooks`              | `Record<string, HookCallbackMatcher[]>` | —                      | Lifecycle hooks                                                      |
| `resume`             | `string`                                | —                      | Resume session by ID                                                 |
| `continue`           | `boolean`                               | `false`                | Continue most recent session                                         |
| `persistSession`     | `boolean`                               | `true`                 | Persist session to disk                                              |
| `sessionId`          | `string`                                | auto                   | Explicit session ID                                                  |
| `outputFormat`       | `{ type: 'json_schema', schema }`       | —                      | Structured output                                                    |
| `sandbox`            | `SandboxSettings`                       | —                      | Filesystem/network sandbox                                           |
| `settingSources`     | `SettingSource[]`                       | —                      | Load AGENT.md, project settings                                      |
| `env`                | `Record<string, string>`                | —                      | Environment variables                                                |
| `abortController`    | `AbortController`                       | —                      | Cancellation controller                                              |

### Environment variables

| Variable             | Description                                              |
| -------------------- | -------------------------------------------------------- |
| `CLAVUE_AGENT_API_KEY`    | API key (required)                                       |
| `CLAVUE_AGENT_API_TYPE`   | `anthropic-messages` (default) or `openai-completions`   |
| `CLAVUE_AGENT_MODEL`      | Default model override                                   |
| `CLAVUE_AGENT_BASE_URL`   | Custom API endpoint                                      |
| `CLAVUE_AGENT_AUTH_TOKEN` | Alternative auth token                                   |

## Built-in tools

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
| **QueryEngine**       | Core agentic loop with auto-compact, retry, tool orchestration     |
| **Skill system**      | Reusable prompt templates with 5 bundled skills                    |
| **Hook system**       | 20 lifecycle events integrated into the engine                     |
| **Auto-compact**      | Summarizes conversation when context window fills up               |
| **Micro-compact**     | Truncates oversized tool results                                   |
| **Retry**             | Exponential backoff for rate limits and transient errors            |
| **Token estimation**  | Rough token counting with pricing for Claude, GPT, DeepSeek models |
| **File cache**        | LRU cache (100 entries, 25 MB) for file reads                      |
| **Session storage**   | Persist / resume / fork sessions on disk                           |
| **Context injection** | Git status + AGENT.md automatically injected into system prompt    |

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
| 10  | `examples/10-permissions.ts`          | Read-only agent with tool restrictions |
| 11  | `examples/11-custom-mcp-tools.ts`     | `tool()` + `createSdkMcpServer()`      |
| 12  | `examples/12-skills.ts`              | Skill system usage                     |
| 13  | `examples/13-hooks.ts`               | Lifecycle hooks                        |
| 14  | `examples/14-openai-compat.ts`       | OpenAI / DeepSeek models               |
| web | `examples/web/`                       | Web chat UI for testing                |

Run any example:

```bash
npx tsx examples/01-simple-query.ts
```

Start the web UI:

```bash
npx tsx examples/web/server.ts
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
