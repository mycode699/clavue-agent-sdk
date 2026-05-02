# Clavue Agent SDK Programmatic Integration Guide

This guide is for teams embedding `clavue-agent-sdk` into another program: API servers, CI jobs, background workers, internal developer platforms, desktop apps, and automation services.

The safest default is:

```typescript
import { run } from "clavue-agent-sdk";

const result = await run({
  prompt: "Review this repository for release blockers. Return concise findings.",
  options: {
    cwd: process.cwd(),
    workflowMode: "review",
    toolsets: ["repo-readonly"],
    permissionMode: "default",
    maxTurns: 6,
  },
});

if (result.status !== "completed") {
  throw new Error(result.errors?.join("\n") || result.subtype);
}

console.log(result.text);
```

## 1. Install And Configure

```bash
npm install clavue-agent-sdk
```

Use environment variables in deployment. Do not put provider keys in source code.

```bash
export CLAVUE_AGENT_API_KEY=your-api-key
export CLAVUE_AGENT_MODEL=claude-sonnet-4-6
```

OpenAI-compatible setup:

```bash
export CLAVUE_AGENT_API_TYPE=openai-completions
export CLAVUE_AGENT_API_KEY=sk-...
export CLAVUE_AGENT_BASE_URL=https://api.openai.com/v1
export CLAVUE_AGENT_MODEL=gpt-5.4
```

You can also pass provider configuration directly:

```typescript
import { createAgent } from "clavue-agent-sdk";

const agent = createAgent({
  apiType: "openai-completions",
  model: "gpt-5.4",
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: "https://api.openai.com/v1",
});

try {
  const result = await agent.run("Explain the current package.");
  console.log(result.text);
} finally {
  await agent.close();
}
```

## 2. Choose The Right API

| Need | Use |
| --- | --- |
| One prompt in, one typed result out | `run({ prompt, options })` |
| Streaming UI, logs, progress events | `query({ prompt, options })` |
| Multi-turn service with sessions, MCP, memory, hooks | `createAgent(options)` |
| Terminal or CI one-off usage | `npx clavue-agent-sdk "prompt"` |

## 3. Use `run()` For Backend Jobs

`run()` creates an agent, executes one task, closes resources, and returns an `AgentRunResult`.

```typescript
import { run } from "clavue-agent-sdk";

export async function reviewRepo(repoPath: string) {
  const result = await run({
    prompt: "Review the repository for correctness, security, and release risks.",
    options: {
      cwd: repoPath,
      workflowMode: "review",
      toolsets: ["repo-readonly"],
      permissionMode: "default",
      maxTurns: 8,
      maxBudgetUsd: 1.0,
    },
  });

  return {
    ok: result.status === "completed",
    text: result.text,
    subtype: result.subtype,
    usage: result.usage,
    costUsd: result.total_cost_usd,
    trace: result.trace,
    errors: result.errors ?? [],
  };
}
```

Production checks:

- Check `result.status` and `result.subtype`.
- Store `result.id`, `result.session_id`, `result.duration_ms`, `result.usage`, and `result.total_cost_usd`.
- Log `result.trace?.policy_decisions` for safety audits.
- Treat `result.text` as model output. Use your own downstream validation for business-critical actions.

## 4. Use `query()` For Streaming UIs

`query()` yields typed events. Use it for web sockets, server-sent events, terminal progress, and dashboards.

```typescript
import { query } from "clavue-agent-sdk";

for await (const event of query({
  prompt: "Inspect src and explain the main runtime flow.",
  options: {
    cwd: process.cwd(),
    toolsets: ["repo-readonly"],
    permissionMode: "default",
    maxTurns: 6,
  },
})) {
  if (event.type === "system" && event.subtype === "phase") {
    console.log(`[phase] ${event.phase}`);
  }

  if (event.type === "assistant") {
    for (const block of event.message.content) {
      if (block.type === "text") process.stdout.write(block.text);
      if (block.type === "tool_use") console.error(`[tool] ${block.name}`);
    }
  }

  if (event.type === "tool_result") {
    console.error(`[tool-result] ${event.result.tool_name}`);
  }

  if (event.type === "system" && event.subtype === "pending_input") {
    console.error(`[needs-input] ${event.question.prompt}`);
  }

  if (event.type === "result") {
    console.log("\nstatus:", event.subtype);
    console.log("turns:", event.num_turns);
    console.log("cost:", event.total_cost_usd);
  }
}
```

Streaming events are useful for visibility, but the final `result` event is the one to use for terminal status, quality gates, usage, cost, and trace data.

## 5. Use `createAgent()` For Long-Lived Services

Use `createAgent()` when you need multi-turn state, reusable configuration, session persistence, MCP connections, hooks, memory, or repeated prompts.

```typescript
import { createAgent } from "clavue-agent-sdk";

const agent = createAgent({
  cwd: process.cwd(),
  model: "claude-sonnet-4-6",
  session: { dir: ".clavue-agent-sessions" },
  persistSession: true,
  runtimeNamespace: "main-service",
  toolsets: ["repo-readonly"],
  permissionMode: "default",
});

try {
  const first = await agent.run("Summarize this repository.");
  const second = await agent.run("Now list the highest-risk files.");

  console.log(first.text);
  console.log(second.text);
} finally {
  await agent.close();
}
```

Always call `await agent.close()` in a `finally` block. It closes MCP connections and flushes session state.

## 6. Recommended Production Options

| Option | Recommendation |
| --- | --- |
| `cwd` | Always set it explicitly. |
| `model` | Pin a known model for reproducible behavior. |
| `workflowMode` | Prefer `review`, `verify`, `build`, `plan`, or `solve` over ad hoc option bundles. |
| `toolsets` | Start with `repo-readonly`; add broader toolsets only when needed. |
| `permissionMode` | Use `default` for read-only, `acceptEdits` for local edits, `trustedAutomation` only for trusted automation. |
| `autonomyMode` | Use `autonomous` only after the user or host has authorized implementation work. |
| `maxTurns` | Set a small bound for every automated workflow. |
| `maxBudgetUsd` | Set for hosted or multi-tenant workflows. |
| `runtimeNamespace` | Set per tenant, project, or job family to isolate process-local state. |
| `session.dir` | Set per tenant or service. |
| `memory.dir` | Set per tenant or service when memory is enabled. |

Example:

```typescript
const productionOptions = {
  cwd: repoPath,
  model: "gpt-5.4",
  apiType: "openai-completions" as const,
  workflowMode: "verify" as const,
  toolsets: ["repo-readonly"] as const,
  permissionMode: "default" as const,
  maxTurns: 6,
  maxBudgetUsd: 0.75,
  runtimeNamespace: `repo-${repoId}`,
  session: { dir: `/var/lib/clavue/sessions/${repoId}` },
  memory: {
    enabled: true,
    dir: `/var/lib/clavue/memory/${repoId}`,
    repoPath,
    policy: { mode: "brainFirst" as const },
    maxInjectedEntries: 6,
  },
};
```

## 7. Toolsets, Permissions, And Autonomy

Tool access is controlled in layers:

1. `toolsets` and `allowedTools` decide which tools exist in the run.
2. `disallowedTools` removes tools after allow-list expansion.
3. `permissionMode` applies built-in safety rules.
4. `canUseTool` can allow, deny, or rewrite a specific tool input.
5. Hooks can block lifecycle events.

Common modes:

| Scenario | Options |
| --- | --- |
| Read-only review | `toolsets: ["repo-readonly"]`, `permissionMode: "default"` |
| Local docs/code edits without shell/network | `toolsets: ["repo-edit"]`, `permissionMode: "acceptEdits"`, `autonomyMode: "autonomous"` |
| Trusted implementation with shell | `toolsets: ["repo-edit"]`, `allowedTools: ["Bash"]`, `permissionMode: "trustedAutomation"`, `autonomyMode: "autonomous"` |
| Planning only | `workflowMode: "plan"` or `permissionMode: "plan"` |

Example host policy:

```typescript
import { run } from "clavue-agent-sdk";

const result = await run({
  prompt: "Update README examples only. Do not touch source files.",
  options: {
    cwd: process.cwd(),
    toolsets: ["repo-edit"],
    permissionMode: "acceptEdits",
    autonomyMode: "autonomous",
    maxTurns: 8,
    canUseTool: async (tool, input) => {
      if (tool.name === "Write" || tool.name === "Edit") {
        const path = typeof input === "object" && input && "file_path" in input
          ? String((input as { file_path: unknown }).file_path)
          : "";
        if (!path.endsWith("README.md")) {
          return { behavior: "deny", message: "This workflow may only edit README.md." };
        }
      }
      return { behavior: "allow" };
    },
  },
});

console.log(result.trace?.policy_decisions);
```

`autonomyMode` changes initiative and question-asking behavior. It does not bypass `permissionMode`, tool filters, host policy, or hooks.

## 8. Workflow Modes

`workflowMode` expands a high-level intent into defaults for toolsets, permission mode, memory policy, autonomy, prompt guidance, and quality-gate behavior.

```typescript
import { getAllRuntimeProfiles, run } from "clavue-agent-sdk";

console.log(getAllRuntimeProfiles().map((profile) => profile.name));

await run({
  prompt: "Verify this package is ready to publish.",
  options: {
    cwd: process.cwd(),
    workflowMode: "verify",
    maxTurns: 6,
  },
});
```

Available modes: `collect`, `organize`, `plan`, `solve`, `build`, `verify`, `review`, `ship`.

Use workflow modes when building a product UI. Let users choose intent; let the SDK expand intent into safer runtime defaults.

## 9. Provider Configuration And Fallbacks

Anthropic default:

```typescript
const result = await run({
  prompt: "Review the current diff.",
  options: {
    model: "claude-sonnet-4-6",
    apiType: "anthropic-messages",
    apiKey: process.env.ANTHROPIC_API_KEY,
    toolsets: ["repo-readonly"],
  },
});
```

OpenAI-compatible:

```typescript
const result = await run({
  prompt: "Explain the package architecture.",
  options: {
    model: "gpt-5.4",
    apiType: "openai-completions",
    apiKey: process.env.OPENAI_API_KEY,
    baseURL: "https://api.openai.com/v1",
    toolsets: ["repo-readonly"],
  },
});
```

Fallback model after retryable provider errors:

```typescript
const result = await run({
  prompt: "Review the repository for release blockers.",
  options: {
    model: "gpt-5.4",
    fallbackModel: "gpt-5.4-mini",
    apiType: "openai-completions",
    toolsets: ["repo-readonly"],
    maxTurns: 6,
  },
});
```

The provider layer normalizes common failures into stable categories such as `authentication`, `rate_limit`, `timeout`, `network`, `unsupported_capability`, `content_filter`, `context_overflow`, `tool_protocol_error`, and `provider_conversion_error`.

## 10. Custom Tools

Use `tool()` for Zod-backed tools. Mark read-only tools with annotations so the engine can safely parallelize them.

```typescript
import { createSdkMcpServer, run, tool } from "clavue-agent-sdk";
import { z } from "zod";

const lookupBuild = tool(
  "lookup_build",
  "Read build metadata for a package version.",
  {
    packageName: z.string(),
    version: z.string(),
  },
  async ({ packageName, version }) => ({
    content: [
      {
        type: "text",
        text: `${packageName}@${version}: build metadata unavailable in demo`,
      },
    ],
  }),
  { annotations: { readOnlyHint: true, idempotentHint: true } },
);

const metadataServer = createSdkMcpServer({
  name: "metadata",
  tools: [lookupBuild],
});

const result = await run({
  prompt: "Use metadata lookup and summarize package status.",
  options: {
    mcpServers: { metadata: metadataServer },
    allowedTools: ["mcp__metadata__lookup_build"],
    permissionMode: "default",
  },
});

console.log(result.text);
```

For lower-level tools, implement `ToolDefinition` directly:

```typescript
import type { ToolDefinition } from "clavue-agent-sdk";

const CurrentUserTool: ToolDefinition = {
  name: "CurrentUser",
  description: "Return the current application user id.",
  inputSchema: { type: "object", properties: {}, required: [] },
  safety: { read: true, idempotent: true },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async call() {
    return {
      type: "tool_result",
      tool_use_id: "",
      content: "user_123",
    };
  },
};
```

Tool tips:

- Keep tool outputs small and structured.
- Avoid returning secrets in tool output.
- Set `safety` annotations accurately.
- Set `isReadOnly()` and `isConcurrencySafe()` only when repeated parallel calls are safe.
- Use `quality_gates` and `evidence` in tool results when a tool performs verification.

## 11. MCP Integration

External MCP server:

```typescript
import { createAgent } from "clavue-agent-sdk";

const agent = createAgent({
  cwd: process.cwd(),
  mcpServers: {
    filesystem: {
      type: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", process.cwd()],
    },
  },
  toolsets: ["mcp"],
  permissionMode: "default",
});

try {
  const result = await agent.run("List available MCP resources.");
  console.log(result.text);
} finally {
  await agent.close();
}
```

MCP safety tips:

- Treat external MCP tools as untrusted until you classify them.
- Prefer narrow MCP server roots and per-tenant configuration.
- Avoid exposing broad filesystem, shell, browser, or network MCP servers to high-autonomy runs.
- Use `allowedTools` and `disallowedTools` to limit MCP tool names.

## 12. Memory And Self-Improvement

Memory is optional. Use it when previous decisions, repo-specific conventions, or operational lessons should influence future runs.

```typescript
import { createAgent, queryMemories } from "clavue-agent-sdk";

const agent = createAgent({
  cwd: process.cwd(),
  memory: {
    enabled: true,
    repoPath: process.cwd(),
    policy: { mode: "brainFirst" },
    maxInjectedEntries: 6,
  },
  selfImprovement: {
    memory: {
      repoPath: process.cwd(),
      maxEntriesPerRun: 4,
    },
  },
});

try {
  const result = await agent.run("Fix the release checklist and verify.");
  console.log(result.self_improvement?.savedMemories.length ?? 0);

  const memories = await queryMemories({
    repoPath: process.cwd(),
    type: "improvement",
    text: "release checklist",
    limit: 5,
  });

  console.log(memories.map((memory) => memory.title));
} finally {
  await agent.close();
}
```

Memory tips:

- Use `brainFirst` when prior context matters before the first model call.
- Keep `repoPath` stable so repo-specific memories rank correctly.
- Do not use memory as an authority source. Future runs must verify current repo state.
- Isolate `memory.dir` per tenant in hosted systems.
- Enable `selfImprovement` only when persisting operational lessons is expected.

## 13. Quality Gates And Evidence

Quality gates let hosts turn verification status into a terminal run failure.

```typescript
import { run } from "clavue-agent-sdk";

const result = await run({
  prompt: "Review release readiness using the provided verification result.",
  options: {
    cwd: process.cwd(),
    toolsets: ["repo-readonly"],
    quality_gates: [
      {
        name: "tests",
        status: "passed",
        summary: "npm test passed before this run",
        evidence: [
          {
            type: "test",
            source: "external",
            summary: "246 tests passed",
          },
        ],
      },
    ],
    qualityGatePolicy: {
      required: ["tests"],
      failStatuses: ["failed", "pending"],
    },
  },
});

if (result.status !== "completed") {
  throw new Error(result.errors?.join("\n") || result.subtype);
}
```

Tools can also return `evidence` and `quality_gates`. Those values propagate to tool events, final result events, and `AgentRunResult`.

## 14. Local Issue Workflow

Use the issue workflow to run a bounded builder, reviewer, fixer, and verifier loop around a concrete issue.

```typescript
import { normalizeIssueInput, runIssueWorkflow } from "clavue-agent-sdk";

const workflow = await runIssueWorkflow({
  cwd: process.cwd(),
  issue: normalizeIssueInput(`
# Fix provider retry behavior

429 responses should retry with Retry-After and preserve provider metadata.
`),
  maxIterations: 3,
  passingScore: 90,
  requiredGates: ["tests"],
});

console.log(workflow.status);
console.log(workflow.finalScore);
console.log(workflow.unresolvedFindings);
console.log(workflow.proof_of_work.status);
console.log(workflow.proof_of_work.verification);
```

CLI equivalent:

```bash
npx clavue-agent-sdk issue execute .clavue/issues/p0-provider-retry.md \
  --max-iterations 3 \
  --passing-score 90 \
  --require-gate tests \
  --json
```

Use this when your product needs deterministic records for P0-P3 issue repair, rather than a single unstructured prompt. `runIssueWorkflow()` also returns `proof_of_work`, so hosts get the same handoff artifact shape used by standalone `createProofOfWork()`.

## 15. Workflow Contracts

Use workflow contracts when your host wants a repository-owned execution policy before adding task-board or daemon orchestration. A `WORKFLOW.md` file can hold YAML front matter for runtime settings and a strict Markdown prompt template for each issue or task.

```md
---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: agents
workspace:
  root: ./workspaces
agent:
  max_concurrent_agents: 4
  max_turns: 12
codex:
  command: codex app-server
---

You are working on {{ issue.identifier }}.

Title: {{ issue.title }}
Body: {{ issue.description }}
```

Programmatic usage:

```typescript
import {
  loadWorkflowDefinition,
  renderWorkflowPrompt,
  resolveWorkflowServiceConfig,
  validateWorkflowDispatchConfig,
} from "clavue-agent-sdk";

const definition = await loadWorkflowDefinition({ cwd: repoPath });
const config = resolveWorkflowServiceConfig(definition);
const issues = validateWorkflowDispatchConfig(config, { requireTracker: true });

if (issues.length > 0) {
  throw new Error(issues.map((issue) => `${issue.path}: ${issue.message}`).join("\n"));
}

const prompt = renderWorkflowPrompt(definition, {
  issue: {
    identifier: "SDK-42",
    title: "Fix autonomous workflow handoff",
    description: "Produce a tested implementation and proof of work.",
    labels: ["p1", "agentops"],
  },
});
```

Template rendering is strict: unknown variables and unknown filters fail with `WorkflowContractError` instead of silently producing an incomplete prompt. This is the recommended foundation for hosts that want Symphony-style isolated autonomous runs without coupling the SDK to Linear, GitHub Issues, Jira, or a daemon process.

## 16. Proof Of Work

Use proof-of-work artifacts when your host needs a standard handoff record after an agent run, background job, or issue workflow. The SDK does not create GitHub PRs, run your CI provider, or update external trackers by default. Instead, it normalizes evidence, gates, costs, references, risks, and handoff readiness so your application can attach those external links when available.

```typescript
import { createProofOfWork, run } from "clavue-agent-sdk";

const result = await run({
  prompt: "Fix the issue and run focused verification.",
  options: {
    cwd: repoPath,
    workflowMode: "build",
    permissionMode: "trustedAutomation",
    autonomyMode: "autonomous",
    qualityGatePolicy: { required: ["tests"] },
  },
});

const proof = createProofOfWork({
  target: {
    kind: "issue",
    id: "SDK-42",
    title: "Fix autonomous workflow handoff",
  },
  run: result,
  required_gates: ["tests"],
  references: [
    { type: "issue", label: "Tracker issue", url: "https://tracker.example/SDK-42" },
    { type: "ci", label: "CI run", url: "https://ci.example/run/123", status: "passed" },
  ],
  risks: result.status === "completed" ? [] : ["Agent run did not complete successfully."],
});

console.log(proof.status);
console.log(proof.verification);
console.log(proof.handoff);
```

The artifact status is derived from reported run/job/workflow status and quality gates:

- `passed`: required gates passed and no failing signal was reported.
- `failed`: a run, job, workflow, or gate failed.
- `blocked`: work was cancelled, stale, or blocked by policy.
- `in_progress`: work is still queued or running.
- `needs_review`: no hard failure was reported, but required proof is missing.
- `unknown`: there is not enough evidence to classify the result.

This is the SDK-level way to absorb Symphony's proof-of-work practice without exceeding SDK scope.

## 17. Orchestration Policy

Use orchestration policy helpers when your host owns the task source and worker process, but wants deterministic SDK-level scheduling decisions. The SDK does not poll Linear, GitHub Issues, Jira, or any other tracker by default. It can, however, decide which normalized issues are eligible to dispatch.

```typescript
import {
  calculateRetryDelayMs,
  resolveWorkflowServiceConfig,
  selectDispatchCandidates,
  shouldReleaseIssueForState,
} from "clavue-agent-sdk";

const config = resolveWorkflowServiceConfig(definition, {
  env: process.env,
  cwd: repoPath,
});

const selection = selectDispatchCandidates({
  config,
  runtime: {
    claimed: ["issue-already-claimed"],
    running: {
      "issue-running": {
        issue_id: "issue-running",
        issue_identifier: "SDK-9",
        state: "In Progress",
      },
    },
  },
  issues: [
    {
      id: "issue-42",
      identifier: "SDK-42",
      title: "Fix autonomous workflow handoff",
      state: "Todo",
      priority: 1,
      created_at: "2026-05-02T00:00:00.000Z",
    },
  ],
});

for (const issue of selection.selected) {
  // Host-owned step: create workspace, start worker, call run(), update tracker, etc.
  console.log("dispatch", issue.identifier);
}

const retryDelayMs = calculateRetryDelayMs({
  attempt: 3,
  max_retry_backoff_ms: config.agent.max_retry_backoff_ms,
});

const release = shouldReleaseIssueForState("Done", config);
```

This gives SDK consumers the reusable policy spine from Symphony without requiring the SDK to become a tracker client, job daemon, repository host integration, or CI system.

## 18. Durable Background AgentJobs

Use AgentJobs when long-running specialist work should be inspectable and cancellable. There are two levels:

- `AgentTool` with `run_in_background: true` starts a subagent and executes it in the background.
- `createAgentJobBatch()` creates durable job records for external orchestration; your host or worker is responsible for execution.

Background subagent from a host tool context:

```typescript
import {
  AgentTool,
  AgentJobGetTool,
  AgentJobListTool,
} from "clavue-agent-sdk";

const context = {
  cwd: process.cwd(),
  runtimeNamespace: "release-review",
  model: "gpt-5.4",
  provider,
};

const started = await AgentTool.call({
  prompt: "Review README.md for release-readiness issues.",
  description: "readme review",
  subagent_type: "Explore",
  run_in_background: true,
}, context);

const { job_id } = JSON.parse(String(started.content));
const job = await AgentJobGetTool.call({ id: job_id }, context);
const list = await AgentJobListTool.call({}, context);

console.log(String(job.content));
console.log(String(list.content));
```

Durable job records for an external orchestrator:

```typescript
import {
  createAgentJobBatch,
  getAgentJob,
  summarizeAgentJobs,
} from "clavue-agent-sdk";

const batch = await createAgentJobBatch({
  correlation_id: "release-review-2026-05-02",
  tasks: [
    {
      prompt: "Review src/providers for retry and fallback bugs.",
      description: "provider review",
      subagent_type: "reviewer",
    },
    {
      prompt: "Review src/tools for unsafe filesystem behavior.",
      description: "tool safety review",
      subagent_type: "reviewer",
    },
  ],
}, {
  runtimeNamespace: "release-review",
});

console.log(batch.summary);

const first = await getAgentJob(batch.jobs[0]!.id, {
  runtimeNamespace: "release-review",
});

console.log(first?.status);
console.log(await summarizeAgentJobs({ runtimeNamespace: "release-review" }));
```

Job storage defaults to `~/.clavue-agent-sdk/agent-jobs`. Set `CLAVUE_AGENT_JOBS_DIR` or pass store options for tests, CI, or multi-tenant services.

## 19. Hooks For Observability And Control

Hooks can log, block, or annotate lifecycle events.

```typescript
import { createAgent } from "clavue-agent-sdk";

const agent = createAgent({
  cwd: process.cwd(),
  toolsets: ["repo-readonly"],
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [
          async (input) => {
            console.log("tool starting", input.toolName);
          },
        ],
      },
    ],
    PostToolUseFailure: [
      {
        matcher: "*",
        hooks: [
          async (input) => {
            console.error("tool failed", input.toolName);
          },
        ],
      },
    ],
  },
});

try {
  await agent.run("Review package metadata.");
} finally {
  await agent.close();
}
```

Use hooks for logs and policy integration, but keep authorization in `permissionMode`, `allowedTools`, `disallowedTools`, and `canUseTool`.

## 17. Doctor And Benchmarks

Run `doctor()` before accepting hosted jobs. Run `runBenchmarks()` in CI or diagnostics to detect runtime regressions.

```typescript
import { doctor, runBenchmarks } from "clavue-agent-sdk";

const report = await doctor({
  cwd: process.cwd(),
  workflowMode: "verify",
  toolsets: ["repo-readonly"],
  memory: { enabled: true },
  checkPackageEntrypoints: true,
});

if (report.status === "error") {
  throw new Error(JSON.stringify(report.summary));
}

const benchmarks = await runBenchmarks({
  cwd: process.cwd(),
  iterations: 3,
});

console.log(benchmarks.metrics);
```

## 18. CI Integration

```typescript
import { run } from "clavue-agent-sdk";

const result = await run({
  prompt: [
    "Review this checkout for release blockers.",
    "Return only actionable findings.",
    "Do not edit files.",
  ].join("\n"),
  options: {
    cwd: process.cwd(),
    workflowMode: "review",
    toolsets: ["repo-readonly"],
    permissionMode: "default",
    maxTurns: 6,
    maxBudgetUsd: 0.5,
  },
});

console.log(result.text);
console.error(JSON.stringify({
  status: result.status,
  subtype: result.subtype,
  turns: result.num_turns,
  usage: result.usage,
  costUsd: result.total_cost_usd,
}, null, 2));

process.exitCode = result.status === "completed" ? 0 : 1;
```

For CLI-only CI:

```bash
CLAVUE_AGENT_API_KEY="$CLAVUE_AGENT_API_KEY" \
npx clavue-agent-sdk "Review this checkout for release blockers" \
  --toolset repo-readonly \
  --permission-mode default \
  --max-turns 6 \
  --json
```

## 19. Hosted Service Pattern

```typescript
import { run } from "clavue-agent-sdk";

export async function handleAgentRequest(input: {
  tenantId: string;
  repoPath: string;
  prompt: string;
}) {
  const result = await run({
    prompt: input.prompt,
    options: {
      cwd: input.repoPath,
      workflowMode: "solve",
      toolsets: ["repo-readonly"],
      permissionMode: "default",
      maxTurns: 8,
      maxBudgetUsd: 1.0,
      runtimeNamespace: `tenant-${input.tenantId}`,
      session: { dir: `/var/lib/clavue/${input.tenantId}/sessions` },
      memory: {
        enabled: true,
        dir: `/var/lib/clavue/${input.tenantId}/memory`,
        repoPath: input.repoPath,
        policy: { mode: "brainFirst" },
      },
    },
  });

  return {
    id: result.id,
    ok: result.status === "completed",
    text: result.text,
    subtype: result.subtype,
    usage: result.usage,
    costUsd: result.total_cost_usd,
    errors: result.errors ?? [],
  };
}
```

Hosted service requirements:

- Isolate `runtimeNamespace`, `session.dir`, memory storage, and job storage per tenant.
- Use `cwd` and host-level sandboxing.
- Use conservative `toolsets` and `permissionMode`.
- Enforce request size, turn count, cost, and wall-clock limits.
- Redact logs before storing prompts, tool output, traces, and errors.

## 20. Security Checklist

- Do not commit API keys.
- Do not expose shell, network, browser, or broad MCP tools to untrusted users.
- Use `permissionMode: "default"` for read-only work.
- Use `permissionMode: "acceptEdits"` for local file edits without shell/network.
- Use `trustedAutomation` only for trusted repositories and approved tasks.
- Set `allowedTools` and `disallowedTools` explicitly for automated workflows.
- Use `canUseTool` for path-level, tenant-level, or business-specific authorization.
- Keep `maxTurns` and `maxBudgetUsd` bounded.
- Log policy decisions and quality gates.
- Review `result.errors`, `result.trace`, and `result.quality_gates` before accepting output.

## 21. Practical Prompt Patterns

Good prompts:

```text
Review src/providers/openai.ts for cancellation and retry bugs. Do not edit files. Return findings with file references and severity.
```

```text
Update README usage examples only. Do not modify source files. After editing, run npm run build and report the result.
```

```text
Resolve the P0-P3 todo list in docs/version-upgrade-todolist.md. Work autonomously within the repo. Run npm test before final output.
```

Avoid:

```text
Make it better.
```

Prompt tips:

- State the target files or subsystem.
- State whether edits are allowed.
- State verification commands.
- State output format.
- State stop conditions.
- Do not mix unrelated tasks in one prompt.

## 22. Release And npm Docs

GitHub shows the repository `README.md` immediately after pushing. npm shows the package README and metadata from the latest published version.

To update npm-facing documentation:

```bash
npm run build
npm test
npm pack --dry-run
npm version patch --no-git-tag-version
git add README.md docs package.json package-lock.json
git commit -m "docs: update integration guide"
git tag vX.Y.Z
git push origin main
git push origin vX.Y.Z
npm publish
```

The package currently publishes `dist/` and `docs/`, so this guide is available to npm consumers after install.
