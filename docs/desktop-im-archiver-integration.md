# Desktop IM Archiver — Integration Handbook

A focused, copy-paste handbook for embedding `clavue-agent-sdk` into a desktop application that archives messages from WeChat / Feishu / QQ / DingTalk via **user-initiated clipboard reads and screenshots** — never by touching the IM client's internals.

This is the companion to [`examples/33-im-archiver.ts`](../examples/33-im-archiver.ts) and §22 of [`programmatic-integration-guide.md`](./programmatic-integration-guide.md).

---

## TL;DR

The SDK is the **brain**. You provide the **hands** (clipboard, screencapture, DB sink) as `tool()` definitions and a **trigger** (hotkey / tray / cron) from your host. The agent loop, vision, classification, retry, budgeting, and observability are already in the SDK.

```
[Hotkey / Tray / Schedule]                 ← your host app
        │
        ▼
[agent.run("Archive now")]                 ← clavue-agent-sdk
        │
        ├─► tool: read_clipboard           ← you implement (10 lines)
        ├─► tool: capture_screen → image   ← you implement (15 lines)
        ├─► model classifies via vision    ← SDK + provider
        └─► tool: archive_message          ← you implement (your DB)
```

---

## 1. Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ Host Application (Electron / Tauri / Node + Hammerspoon / ...)   │
│                                                                  │
│  • Global hotkey or tray button                                  │
│  • Consent UI (toast / modal) used by canUseTool                 │
│  • Real database (Postgres / SQLite / S3 / DuckDB)               │
│  • Telemetry sink for hooks (audit log)                          │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐  │
│  │ clavue-agent-sdk                                           │  │
│  │                                                            │  │
│  │  createAgent({                                             │  │
│  │    mcpServers: { im_archiver },   ← in-process MCP server  │  │
│  │    allowedTools, canUseTool, hooks, abortSignal, ...       │  │
│  │  })                                                        │  │
│  │                                                            │  │
│  │  Tool calls dispatched in-process — no IPC, no subprocess. │  │
│  └────────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

The SDK never reads the IM client's process memory, files, or database. Everything it sees is what the user copied or screenshotted. That is the compliance story you want.

---

## 2. SDK Surface You Will Use

| Symbol | Purpose | Reference |
| --- | --- | --- |
| `createAgent(options)` | Long-lived agent instance | `src/agent.ts` |
| `tool(name, desc, zodShape, handler, extras?)` | Define a custom tool | `src/tool-helper.ts` |
| `createSdkMcpServer({ name, tools })` | Bundle tools as an in-process MCP server | `src/sdk-mcp-server.ts` |
| `AgentOptions.canUseTool` | Per-call host veto | `src/types/agent.ts` |
| `AgentOptions.hooks.PreToolUse` / `PostToolUse` | Audit / redact | `src/hooks.ts` |
| `AgentOptions.abortSignal` | Cancel mid-run | `src/types/agent.ts` |
| `agent.run(prompt)` | One-shot execution returning `AgentRunResult` | `src/agent.ts` |
| `agent.query(prompt)` | Streaming async generator | `src/agent.ts` |
| `agent.close()` | Release resources | `src/agent.ts` |

Tool result content blocks accepted by the engine:

```ts
{ type: 'text',  text: string }
{ type: 'image', data: string /* base64 */, mimeType: 'image/png' | 'image/jpeg' | ... }
```

Returning `image` blocks from a tool is the supported way to feed screenshots to a vision model — **no OCR step required** for Claude 3.5+ / GPT-4o family.

---

## 3. The Three Tools You Implement

### 3.1 `read_clipboard`

```ts
import { execFileSync } from 'node:child_process'
import { tool } from 'clavue-agent-sdk'
import { z } from 'zod'

export const readClipboard = tool(
  'read_clipboard',
  'Read system clipboard. Call after the user copies chat content.',
  {},
  async () => {
    let text: string
    if (process.platform === 'darwin') {
      text = execFileSync('pbpaste', { encoding: 'utf8' })
    } else if (process.platform === 'win32') {
      text = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' })
    } else {
      try { text = execFileSync('wl-paste', { encoding: 'utf8' }) }
      catch { text = execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' }) }
    }
    return { content: [{ type: 'text', text: text.slice(0, 20_000) }] }
  },
  { annotations: { readOnlyHint: true } },
)
```

### 3.2 `capture_screen`

```ts
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const captureScreen = tool(
  'capture_screen',
  'Capture a screen region as an image. The model reads it directly via vision.',
  {
    region: z.enum(['interactive', 'full']).default('interactive'),
  },
  async ({ region }) => {
    const path = join(tmpdir(), `cap-${Date.now()}.png`)
    try {
      if (process.platform === 'darwin') {
        const args = region === 'interactive' ? ['-i', '-x', '-o', path] : ['-x', '-o', path]
        execFileSync('screencapture', args)
      } else if (process.platform === 'win32') {
        // Bundle nircmd.exe with your installer:
        execFileSync('nircmd.exe', ['savescreenshot', path])
      } else {
        const bin = process.env.WAYLAND_DISPLAY ? 'grim' : 'scrot'
        execFileSync(bin, [path])
      }
      const data = readFileSync(path).toString('base64')
      return { content: [{ type: 'image', data, mimeType: 'image/png' }] }
    } finally {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  },
  { annotations: { readOnlyHint: true } },
)
```

### 3.3 `archive_message`

```ts
export const archiveMessage = tool(
  'archive_message',
  'Persist one classified message.',
  {
    source: z.enum(['wechat', 'feishu', 'qq', 'dingtalk', 'other']),
    contact: z.string(),
    body: z.string(),
    category: z.string(),                              // 工作 / 生活 / 广告 / 重要通知 / 其他
    importance: z.enum(['low', 'normal', 'high']),
    occurredAt: z.string().optional(),                 // ISO 8601 if visible in screenshot
  },
  async (row) => {
    await db.insert('im_messages', { ...row, archivedAt: new Date().toISOString() })
    return { content: [{ type: 'text', text: 'ok' }] }
  },
)
```

Recommended DB schema:

```sql
CREATE TABLE im_messages (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,
  contact      TEXT NOT NULL,
  body         TEXT NOT NULL,
  category     TEXT NOT NULL,
  importance   TEXT NOT NULL CHECK (importance IN ('low','normal','high')),
  occurred_at  TIMESTAMPTZ,
  archived_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw_source   TEXT,                                   -- 'clipboard' | 'screenshot'
  -- vector column for semantic search later
  embedding    VECTOR(1536)
);
CREATE INDEX ON im_messages (source, contact, archived_at DESC);
CREATE INDEX ON im_messages (category, importance);
```

---

## 4. Wiring The Agent

```ts
import { createAgent, createSdkMcpServer } from 'clavue-agent-sdk'

const archiverServer = createSdkMcpServer({
  name: 'im_archiver',
  tools: [readClipboard, captureScreen, archiveMessage],
})

export function buildArchiverAgent({ abortSignal }: { abortSignal?: AbortSignal } = {}) {
  return createAgent({
    model: process.env.CLAVUE_AGENT_MODEL ?? 'claude-sonnet-4-6',
    systemPrompt: ARCHIVER_SYSTEM_PROMPT,
    mcpServers: { im_archiver: archiverServer },
    allowedTools: [
      'mcp__im_archiver__read_clipboard',
      'mcp__im_archiver__capture_screen',
      'mcp__im_archiver__archive_message',
    ],
    permissionMode: 'default',
    maxTurns: 12,
    maxBudgetUsd: 0.10,                  // hard cost cap per archive run
    abortSignal,
    canUseTool: hostConsentGate,         // see §5
    hooks: {
      PreToolUse: [{ hooks: [auditPreToolUse] }],   // see §6
      PostToolUse: [{ hooks: [auditPostToolUse] }],
    },
  })
}

const ARCHIVER_SYSTEM_PROMPT = `You are an IM message archiver embedded in a desktop app.
Pipeline:
  1. Call read_clipboard first. If empty or clearly not chat content, call capture_screen.
  2. Extract individual messages: sender, time if visible, body text.
  3. Classify category: 工作 / 生活 / 广告 / 重要通知 / 其他.
  4. Set importance: high for explicit asks or deadlines, low for ads, otherwise normal.
  5. Call archive_message once per extracted message.
  6. Reply with: "已归档 N 条 (高:x 普通:y 低:z)".
Rules:
  - Never invent messages. If unreadable, archive once with importance=low, category=其他.
  - Strip UI chrome, system prompts, timestamps from body — store time in occurredAt.
  - Stop after archive_message — do not over-explain.`
```

---

## 5. Consent Gate (`canUseTool`)

The host owns the user's trust. `canUseTool` is invoked **before every tool call**, can rewrite input, and can reject with a reason the model sees.

```ts
import type { CanUseToolFn } from 'clavue-agent-sdk'

export const hostConsentGate: CanUseToolFn = async (name, input) => {
  if (name.endsWith('__capture_screen')) {
    const ok = await ui.confirm({
      title: '允许截屏？',
      detail: '将对你选择的窗口截图并送给 AI 进行归档。',
    })
    if (!ok) return { behavior: 'deny', message: 'User declined screen capture.' }
  }
  if (name.endsWith('__archive_message')) {
    // Redact phone numbers before persisting.
    const redacted = { ...input, body: String(input.body).replace(/1[3-9]\d{9}/g, '[手机号]') }
    return { behavior: 'allow', updatedInput: redacted }
  }
  return { behavior: 'allow', updatedInput: input }
}
```

`updatedInput` lets you redact PII without rewriting tool code.

---

## 6. Audit Trail (`hooks.PreToolUse` / `PostToolUse`)

```ts
import type { HookDefinition } from 'clavue-agent-sdk'

export const auditPreToolUse: HookDefinition = async (input) => {
  await audit.write({
    at: Date.now(),
    phase: 'pre',
    tool: input.tool_name,
    inputDigest: sha256(JSON.stringify(input.tool_input)).slice(0, 16),
  })
  return {}                                    // allow by default
}

export const auditPostToolUse: HookDefinition = async (input) => {
  await audit.write({
    at: Date.now(),
    phase: 'post',
    tool: input.tool_name,
    durationMs: input.duration_ms,
    isError: input.is_error,
  })
  return {}
}
```

Hooks are non-blocking observability; for hard policy use `canUseTool`.

---

## 7. Triggering The Agent

### 7.1 Electron `globalShortcut`

```ts
import { app, globalShortcut } from 'electron'

app.whenReady().then(() => {
  globalShortcut.register('CommandOrControl+Shift+A', async () => {
    const ctrl = new AbortController()
    activeRun?.abort()
    activeRun = ctrl
    const agent = buildArchiverAgent({ abortSignal: ctrl.signal })
    try {
      const result = await agent.run('Archive what I just copied or what is on screen.')
      tray.toast(result.text)
    } finally {
      await agent.close()
    }
  })
})
```

### 7.2 Hammerspoon (macOS, Lua)

```lua
hs.hotkey.bind({"cmd","shift"}, "A", function()
  hs.task.new("/usr/local/bin/node",
    function(code, stdout) hs.alert.show(stdout) end,
    { "/path/to/run-archiver.mjs" }
  ):start()
end)
```

`run-archiver.mjs` is a tiny script that calls `buildArchiverAgent().run(...)`.

### 7.3 AutoHotkey (Windows)

```autohotkey
^+a::Run, "C:\Program Files\nodejs\node.exe" "C:\app\run-archiver.mjs", , Hide
```

### 7.4 Scheduled via `cron-tools`

If you want periodic archiving of the clipboard (e.g. after a sticky-paste workflow), reuse the SDK's built-in `CronCreateTool` — see `examples/16-background-agent-jobs.ts`.

---

## 8. Streaming UI Updates

For a live toast / panel showing progress, use `agent.query()` instead of `agent.run()`:

```ts
for await (const ev of agent.query('Archive now.')) {
  if (ev.type === 'assistant' && ev.message?.content) {
    for (const block of ev.message.content) {
      if ('text' in block) ui.appendLog(block.text)
      if ('name' in block) ui.setStatus(`tool: ${block.name}`)
    }
  } else if (ev.type === 'result') {
    ui.finish({ ok: ev.subtype === 'success', cost: ev.total_cost_usd })
  }
}
```

---

## 9. Cost & Budget Discipline

| Knob | Recommended |
| --- | --- |
| `maxTurns` | 12 — enough for clipboard + 1–2 screenshots + multiple `archive_message` calls |
| `maxBudgetUsd` | 0.05–0.10 per archive run; cap higher for batch sessions |
| `region: 'interactive'` default | Forces single-window screenshots — avoids token waste on full-screen captures |
| Image preprocessing | Optional: downscale to ≤ 1280px wide before sending |
| Provider | `claude-sonnet-4-6` is the cheapest vision-capable default; switch to Haiku for higher volume |

A typical archive run costs roughly **\$0.01–\$0.03**. Always set `maxBudgetUsd` — it is enforced by the engine.

---

## 10. Vision Vs OCR — When To Pick Which

| Scenario | Use |
| --- | --- |
| Default — Claude 3.5+, GPT-4o, Gemini-vision | Return `image` from `capture_screen`, skip OCR |
| Air-gapped or vision-disabled model | Add an `ocr_image` tool wrapping PaddleOCR / Tesseract; return `text` |
| Mixed: heavy logo/sticker noise | OCR first to drop emoji-only frames cheaply, then send filtered crops to vision |

If you go OCR-first, the tool signature becomes:

```ts
const ocrImage = tool('ocr_image', 'Run OCR on a base64 PNG.', { data: z.string() },
  async ({ data }) => {
    const text = await runPaddleOcr(Buffer.from(data, 'base64'))
    return { content: [{ type: 'text', text }] }
  })
```

---

## 11. Error Handling & Retry

The SDK already retries on rate limits / transient provider errors via `withRetry` (see `src/utils/retry.ts`). You only need to handle:

- **Permission denial** — `canUseTool` returning `deny` surfaces a tool error to the model, which will reply with a refusal summary. Show that to the user.
- **Tool exceptions** — throw inside the handler; the engine returns `isError: true` to the model and a `ToolFailure` block in trace.
- **Out-of-budget** — `result.subtype === 'budget_exceeded'`. Tell the user, do not auto-retry.
- **Abort** — `result.subtype === 'cancelled'`. No archive happened; safe to retry on next hotkey.

```ts
const result = await agent.run('Archive now.')
switch (result.subtype) {
  case 'success':           return notifyOk(result.text)
  case 'budget_exceeded':   return notifyWarn('成本上限触发，已停止。')
  case 'cancelled':         return                         // user pressed Esc
  case 'permission_denied': return notifyWarn('被拒绝。')
  default:                  return notifyError(result.errors?.join('\n'))
}
```

---

## 12. Sessions & Memory (Optional)

For multi-turn archive sessions (e.g. "now also tag last 10 as 项目X"), reuse a session id:

```ts
const agent = createAgent({ /* ... */, sessionId: 'archiver-main' })
```

Use `runtimeNamespace` to isolate state across users in a multi-tenant host:

```ts
createAgent({ /* ... */, runtimeNamespace: `user:${userId}` })
```

Avoid pushing every archived message into `src/memory.ts` — that store is for agent self-context, not bulk data. Bulk data goes to your DB.

---

## 13. Security Checklist

- [ ] `canUseTool` shows a consent UI before `capture_screen`.
- [ ] PII redaction happens in `canUseTool.updatedInput`, not only in the prompt.
- [ ] `permissionMode` is `default` (not `bypassPermissions`).
- [ ] `allowedTools` whitelists only the three archiver tools.
- [ ] `maxBudgetUsd` is set.
- [ ] Audit log (`hooks`) is written to durable storage, not just stdout.
- [ ] Temp screenshot files are deleted in a `finally` (see §3.2).
- [ ] API keys come from env or OS keychain, never from the renderer process.
- [ ] You have **not** added any tool that reads IM client files or process memory.

---

## 14. Verification

```bash
# Static
npm run build

# Unit-level smoke (tool() helper + in-process MCP server wiring)
npx tsx --test tests/single-tool-helpers.test.ts

# Live with a real provider (needs CLAVUE_AGENT_API_KEY + vision model)
export CLAVUE_AGENT_API_KEY=...
export CLAVUE_AGENT_MODEL=claude-sonnet-4-6
npx tsx examples/33-im-archiver.ts
```

For the host integration, exercise:

1. Empty clipboard → agent should call `capture_screen`.
2. Permission deny on `capture_screen` → agent should reply with a graceful refusal, not retry forever.
3. `abortSignal.abort()` mid-run → `result.subtype === 'cancelled'`.
4. Budget pinned to \$0.001 → `result.subtype === 'budget_exceeded'`.

---

## 15. Where To Go Next

- **Feishu high-fidelity**: replace `capture_screen` with a webhook handler tool that consumes Feishu Open Platform events. Same agent, structured input.
- **Semantic search over archive**: feed `im_messages.body` through `PgvectorRetriever` (see `src/rag/pgvector.ts`) for "find that message about X" queries.
- **Background batching**: durable AgentJobs (`createAgentJob` in `src/agent-jobs.ts`) for end-of-day digest runs.
- **Cross-machine sync**: namespace by `runtimeNamespace`, ship the DB; nothing in the SDK is bound to a specific machine.

---

## 16. What This Pattern Does NOT Do

Be explicit with stakeholders:

| Not supported | Why |
| --- | --- |
| Reading IM local SQLite (`MSG*.db`, Feishu cache, etc.) | Out of SDK scope, typical ToS violation |
| Hooking IM process / DLL injection | Out of scope, fragile, ToS violation |
| Silent background screen monitoring | Privacy-hostile; require user-initiated triggers |
| Decoding voice / file attachments stored only in the IM client | Capture the rendered preview if you must |
| Replying to messages on behalf of the user | Out of scope of "archive"; build a separate tool with explicit consent |

The clipboard + screenshot pipeline is the **cleanest** integration. If you find yourself wanting to go further, stop and have the compliance conversation first.
