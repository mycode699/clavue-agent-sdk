# Migration guide: 0.7.x → 0.9.x (path to 1.0.0)

> **TL;DR**: most code keeps working unchanged. The breaking changes are
> opt-in (you upgrade by adopting them; the old code paths still work).
> The four deprecations below have ≥ 90 days of overlap before removal.

This guide is for hosts already running `clavue-agent-sdk@0.7.x` who want
to adopt the v2 capabilities without surprises. It does **not** cover the
full v3 capability layer (graph DSL, RAG, tracing UI, sandbox, voice,
GenUI, guardrails) — those are pure additions and live behind subpath
imports; you adopt them when you need them.

---

## What kept working unchanged

Every public 0.7.x API listed in the README still works in 0.9.x:

- `createAgent`, `query`, `run`, `Agent` class
- `defineTool`, `createSdkMcpServer`, `tool`
- The 30+ built-in tools and named toolsets
- All hooks (`PreToolUse`, `PostToolUse`, …)
- `runtimeNamespace`-keyed durable AgentJobs
- Issue workflow, workflow contract, proof-of-work, orchestration policy
- Sessions, structured memory, retro/eval helpers
- Schema-versioned events (`SDK_EVENT_SCHEMA_VERSION`, etc.)

If you only care about "my 0.7.5 code keeps running," stop reading and
upgrade — the rest of this doc is opt-in improvements.

---

## Recommended adoptions (no breaking changes)

### 1. Streaming (audit P0-4)

If you're rendering an agent's response in a UI, set:

```ts
const agent = createAgent({
  // ...
  includePartialMessages: true,
})

for await (const ev of agent.query(prompt)) {
  if (ev.type === 'partial_message' && ev.partial.type === 'text') {
    process.stdout.write(ev.partial.text)   // first-token latency drops
  }
}
```

This is wired against `client.messages.stream(...)` for Anthropic and
SSE for OpenAI Chat. With `includePartialMessages: false` (the default)
the engine takes the non-streaming path — same as 0.7.x.

### 2. Anthropic prompt caching (audit P0-5)

Already on by default in 0.9.x for any model that supports it. Nothing to
configure. Verify it's working by inspecting:

```ts
const result = await agent.run('...')
console.log(result.usage.cache_creation_input_tokens)  // first turn
console.log(result.usage.cache_read_input_tokens)      // subsequent turns
```

If both are `0`, the model probably doesn't support caching (e.g.
legacy Claude 2.x).

### 3. Better token estimation (audit P0-3)

The `estimateTokens` heuristic now classifies content (English / code /
JSON / CJK) instead of using a flat 4-chars/token rule. No code change
required — the same call returns more accurate numbers, which means
`shouldAutoCompact` triggers at the right time on Chinese / JSON-heavy
runs instead of waiting for `prompt_too_long` to bounce back.

### 4. Sub-path imports (audit P1-2)

For better tree-shaking and clearer module boundaries:

```ts
// 0.7.x — still works:
import { createAgent, FileReadTool, AgentRunResult } from 'clavue-agent-sdk'

// 0.9.x — recommended:
import { createAgent } from 'clavue-agent-sdk/core'
import { FileReadTool } from 'clavue-agent-sdk/tools'
import type { AgentRunResult } from 'clavue-agent-sdk/contracts'
```

Both styles are supported; the root export remains a barrel that
re-exports everything.

### 5. v3 capability layer (subpath, opt-in)

These are entirely new — nothing in 0.7.x to migrate from:

```ts
import { defineGraph, runGraph } from 'clavue-agent-sdk/graph'
import { CommandVerifier } from 'clavue-agent-sdk/workflow'
import { createInMemoryRagStore } from 'clavue-agent-sdk/rag'
import { createTraceCollector } from 'clavue-agent-sdk/tracing'
import { defineGuardrails } from 'clavue-agent-sdk/guardrails'
import { createCapabilityToken } from 'clavue-agent-sdk/sandbox'
import { defineComponent } from 'clavue-agent-sdk/genui'
import { createVoiceAdapter } from 'clavue-agent-sdk/voice'
```

See `examples/19-graph-dsl.ts` through `30-voice-adapters.ts` for usage.

---

## Deprecations (still working, scheduled for removal)

| Symbol | Replacement | Removed in |
|---|---|---|
| `runIssueWorkflow` | `runIssueWorkflowWithAgent` | 1.1.0 |
| `AgentOptions.jsonSchema` | `AgentOptions.outputSchema` | 1.1.0 |
| `AgentOptions.maxThinkingTokens` | `AgentOptions.thinking.budgetTokens` | 1.1.0 |
| `cost` field on result events | `total_cost_usd` (already present) | 1.2.0 |

### `runIssueWorkflow` → `runIssueWorkflowWithAgent`

The original function only kept records of an externally-driven workflow
(it never invoked an LLM — see audit P0-1). The phase-2 replacement
actually drives the build → verify → review → fix loop with an Agent
instance:

```ts
// 0.7.x (still works, but the loop never calls an LLM):
import { runIssueWorkflow } from 'clavue-agent-sdk'
const result = await runIssueWorkflow({
  issue,
  cwd,
  evaluateRole: async ({ role, issue }) => {
    // host had to do all the LLM work itself
  },
})

// 0.9.x recommended:
import { runIssueWorkflowWithAgent, CommandVerifier } from 'clavue-agent-sdk/workflow'
import { createAgent } from 'clavue-agent-sdk'

const agent = createAgent({ /* ... */ })
const verifier = new CommandVerifier([
  { name: 'tests', cmd: 'npm test' },
  { name: 'lint',  cmd: 'npm run lint' },
])

const result = await runIssueWorkflowWithAgent({
  issue,
  cwd,
  agent,
  verifier,
  maxIterations: 3,
})
```

The new function returns the same `IssueWorkflowResult` shape, so
downstream consumers don't need to change.

### `jsonSchema` → `outputSchema`

`jsonSchema` was wired through `agent.run` but never reached the providers
in 0.7.x — it was effectively dead code (audit P0-2). 0.9.x synthesizes
an `_output` tool with `tool_choice` (Anthropic) or `response_format:
json_schema` (OpenAI):

```ts
// 0.7.x (silently did nothing):
const result = await agent.run('...', { jsonSchema: mySchema })

// 0.9.x — actually constrains the output:
const result = await agent.run('...', {
  outputSchema: {
    name: 'plan',
    description: 'A short fix plan',
    schema: mySchema,
  },
})
```

For one transitional release `jsonSchema` is accepted and forwarded into
`outputSchema.schema` automatically; it'll be removed in 1.1.0.

### `maxThinkingTokens` → `thinking.budgetTokens`

```ts
// 0.7.x:
const agent = createAgent({ maxThinkingTokens: 8192 })

// 0.9.x:
const agent = createAgent({
  thinking: { type: 'enabled', budgetTokens: 8192 },
})
```

### `cost` → `total_cost_usd` on result events

Both fields carry the same number in 0.9.x. `cost` is kept for one major
release of overlap; new code should read `total_cost_usd`.

---

## Subagent runtime (audit P1-6)

`AgentTool` and `runAgentSubagent` accept a new `runtime` field:

```ts
// Default — same as 0.7.x:
runtime: 'inprocess'

// New — V8 isolate boundary, hard abort, no shared registries:
runtime: 'worker_thread'
```

Use `worker_thread` when you need:

- Hard isolation from a misbehaving subagent (infinite loops, runaway
  memory).
- Guarantees that the subagent's tool writes (tasks, teams, mailboxes,
  cron) cannot leak into the parent's runtime registries.
- An abort signal that terminates within ~50ms (parent unblock) +
  whatever V8 takes to tear down the isolate.

Stay on `inprocess` (default) when you want low overhead and shared
state — the spawn cost is ~56ms vs ~0ms for inprocess.

See `examples/31-worker-thread-subagent.ts` for the full pattern.

---

## Schema versions

```ts
SDK_EVENT_SCHEMA_VERSION              // unchanged: '1.0.0'
AGENT_RUN_RESULT_SCHEMA_VERSION       // unchanged: '1.0.0'
AGENT_RUN_TRACE_SCHEMA_VERSION        // unchanged: '1.0.0'
AGENT_JOB_RECORD_SCHEMA_VERSION       // unchanged: '1.0.0'
MEMORY_TRACE_SCHEMA_VERSION           // unchanged: '1.0.0'
PROOF_OF_WORK_SCHEMA_VERSION          // unchanged: '1.0.0'
CONTROLLED_EXECUTION_CONTRACT_VERSION // unchanged: '1.0.0'
```

No schema bumps in 0.7.x → 0.9.x. New optional fields were added
(`partial_message` events, `cache_creation_input_tokens`,
`cache_read_input_tokens`, `runtime` on subagent options) but no
existing field changed semantics. Hosts pinning these versions don't
need to update their compatibility checks.

---

## Cleanup checklist for an upgrading host

1. [ ] Replace `runIssueWorkflow` calls with `runIssueWorkflowWithAgent`.
2. [ ] Replace `jsonSchema` with `outputSchema` (rename only, same value
       moves into the `schema` field).
3. [ ] Replace `maxThinkingTokens` with `thinking.budgetTokens`.
4. [ ] (Optional) Switch hot imports to subpaths for tree-shaking.
5. [ ] (Optional) Set `includePartialMessages: true` if rendering streams.
6. [ ] (Optional) Adopt `runtime: 'worker_thread'` for high-trust
       subagents.
7. [ ] Run `npm run bench` against your fork to verify your custom
       changes haven't regressed the SLOs in
       [docs/v2_benchmark_report.md](./v2_benchmark_report.md).

If any of these is unclear, file an issue with a `1.0-migration` tag —
the migration guide will be expanded based on real reports rather than
speculation.
