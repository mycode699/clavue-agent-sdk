# Desktop Tools Integration Handbook

`clavue-agent-sdk/desktop` — opt-in tools that let an agent interact with the user's machine: **clipboard, screen capture, file search, folder/file/URL opening, app launching, email drafting, system notifications**, plus escape hatches for AppleScript (macOS) and PowerShell (Windows).

Pairs with [`examples/34-desktop-tools.ts`](../examples/34-desktop-tools.ts) and the IM-archiver handbook [`desktop-im-archiver-integration.md`](./desktop-im-archiver-integration.md).

---

## 1. Why A Separate Subpath

These tools are **not** in the SDK root or built-in toolsets because they:

- Depend on platform binaries (`pbpaste`, `screencapture`, `osascript`, `powershell`, `xdg-open`, `grim`, …).
- Have a higher blast radius than file/network tools — they drive the user's UI.
- Need a host-side consent gate to be safe.

Importing from `clavue-agent-sdk/desktop` is the explicit opt-in.

```ts
import { buildDesktopServer } from 'clavue-agent-sdk/desktop'
```

---

## 2. Tool Catalog

| Tool | Tier | Platforms | What it does |
| --- | --- | --- | --- |
| `read_clipboard` | safe | mac / win / linux | Read clipboard text |
| `write_clipboard` | safe | mac / win / linux | Set clipboard text |
| `capture_screen` | safe | mac / win / linux | PNG of full screen or interactive region — returned as `image` content for vision models |
| `find_files` | safe | mac (mdfind) / win (PS) / linux (find) | Search by name with optional scope |
| `open_path` | safe | mac / win / linux | Open file / folder / URL with OS default handler |
| `reveal_in_finder` | safe | mac / win / linux | Highlight file in file manager without opening |
| `launch_app` | automation | mac / win / linux | Open or focus an app by display name (WeChat, Lark, Word, WPS, QQ, Mail, …) |
| `compose_email` | automation | mac / win / linux | Open a pre-filled draft via `mailto:` — **never sends** |
| `open_in_browser` | automation | mac / win / linux | Open URL in default browser (Gmail, Feishu web, Notion, Google Docs) |
| `notify` | automation | mac / win / linux | System notification banner |
| `run_applescript` | automation | macOS only | Arbitrary AppleScript — gate carefully |
| `run_powershell` | automation | Windows only | Arbitrary PowerShell — gate carefully |

---

## 3. Tier System

```ts
buildDesktopServer({ tier: 'safe' })        // 6 read-only / user-initiated
buildDesktopServer({ tier: 'automation' })  // 6 UI-driving
buildDesktopServer({ tier: 'all' })         // 12
```

**Recommendation**: start with `'safe'`. Only flip to `'automation'` once your `canUseTool` gate is real (toast / modal). Drop the platform-scripting escape hatches unless you specifically need them:

```ts
buildDesktopServer({
  tier: 'all',
  exclude: ['run_applescript', 'run_powershell'],
})
```

---

## 4. Wiring

```ts
import { createAgent } from 'clavue-agent-sdk'
import { buildDesktopServer } from 'clavue-agent-sdk/desktop'

const desktop = buildDesktopServer({ tier: 'safe' })

const agent = createAgent({
  systemPrompt: 'You are a desktop assistant. Prefer single-action tools. End with notify.',
  mcpServers: { desktop },
  allowedTools: ['mcp__desktop__*'],
  permissionMode: 'default',
  maxTurns: 8,
  maxBudgetUsd: 0.05,
  canUseTool: async (name, input) => {
    if (name.endsWith('__capture_screen') || name.endsWith('__launch_app')) {
      const ok = await hostUi.confirm({ tool: name, input })
      if (!ok) return { behavior: 'deny', message: 'user denied' }
    }
    return { behavior: 'allow', updatedInput: input }
  },
})

await agent.run('Find my latest invoice PDF and reveal it in Finder.')
```

`buildDesktopServer` returns a standard `McpSdkServerConfig` — fully interchangeable with anything you'd write by hand using `tool()` + `createSdkMcpServer()`.

---

## 5. Platform Requirements

| Platform | Required binaries (bundled with OS) | Optional |
| --- | --- | --- |
| macOS | `pbpaste` `pbcopy` `screencapture` `mdfind` `open` `osascript` | — |
| Windows | `powershell` `cmd` `explorer.exe` | `nircmd.exe` (interactive screenshots) |
| Linux | `xdg-open` `find` `notify-send` | `wl-paste` / `xclip` (clipboard), `grim` (Wayland) / `scrot` (X11) |

Tools detect missing binaries and return `{ isError: true, content: [{ text: 'binary not found: ...' }] }` so the model can recover instead of throwing.

---

## 6. Safety Model

| Mechanism | Where | Purpose |
| --- | --- | --- |
| Tool-name allowlist | `allowedTools: ['mcp__desktop__*']` | Restrict the agent to desktop tools |
| Per-call host veto | `canUseTool` | Modal / toast before each action |
| Input rewrite | `canUseTool` returns `updatedInput` | Redact PII before persistence |
| Audit log | `hooks.PreToolUse` / `PostToolUse` | Tamper-evident record of every call |
| Cost ceiling | `maxBudgetUsd` | Stop runaway loops |
| Hard cancel | `abortSignal` | Hotkey cancel from host |

**What this module deliberately does NOT include:**

- Keystroke / mouse injection (no `nut.js` / `robotjs` wrappers). Hosts that want RPA define their own tool with its own consent screen.
- Auto-send email. `compose_email` opens a draft; the user always presses send.
- File / process deletion. Host must define these explicitly so the consent UI is unambiguous.
- "Send WeChat message" tool. Use the clipboard + paste pattern via the IM archiver handbook — keeps the user in the loop.

---

## 7. Per-App Recipes

### 7.1 微信 / WeChat

WeChat does not expose a public local API or stable AppleScript dictionary. Use the **user-mediated** pattern:

```ts
await agent.run([
  'Open WeChat.',
  'Then wait for me — I will copy a chat. Tell me when ready.',
].join(' '))
// (user copies chat, presses hotkey)
await agent.run('Read my clipboard, summarize and notify me with the gist.')
```

### 7.2 飞书 / Lark

Two paths:

- **UI path (any user)** — `launch_app` `"Lark"` / `"Feishu"`, then user-mediated copy + `read_clipboard`.
- **API path (recommended for fidelity)** — wire the Feishu Open Platform webhook into your own tool. The agent consumes structured payloads instead of screenshots.

### 7.3 Google Mail / Outlook / Foxmail

```ts
await agent.run('Draft an email to alex@example.com cc: bob@example.com about the design review.')
// → compose_email opens a pre-filled draft in the default mail handler.
// User presses send.
```

For Gmail web specifically:

```ts
// open_in_browser then optional clipboard paste
await agent.run('Open Gmail and copy this template into my clipboard so I can paste it.')
```

### 7.4 Office / WPS

`open_path` + the file path opens with the registered handler:

```ts
await agent.run('Open ~/Documents/Q3-report.docx.')
```

On macOS you can drive Word via AppleScript through `run_applescript`. On Windows you can drive Word / Excel / Outlook via COM through `run_powershell`. Both require explicit host gating.

### 7.5 QQ / DingTalk / Slack

Same pattern as WeChat: `launch_app` to focus, user copies, `read_clipboard` to ingest. None of them expose a stable local automation API worth depending on.

### 7.6 Browser tasks

```ts
await agent.run('Open https://docs.google.com/document/d/ABC in my browser.')
```

For headless browser control (form filling, scraping, automated logins), do **not** use these tools — wire Playwright as its own tool. Desktop tools are for opening UI, not driving it.

### 7.7 File system search

```ts
await agent.run('Find files named "invoice" under ~/Documents from the last month, reveal the latest.')
```

`find_files` uses Spotlight on macOS (instant), `Get-ChildItem` on Windows (slower; bound your `scope`), and `find` on Linux. Always pass `scope` to keep latency down.

---

## 8. Error Handling

Every tool returns `{ isError: true, content: [{ text }] }` — never throws across the boundary. Common errors the model will see:

| Message pattern | Cause | Host action |
| --- | --- | --- |
| `binary not found: X` | Optional binary missing | Bundle in installer, or surface install instructions |
| `unsupported platform: …` | Wrong OS | Already handled — agent will switch tactics |
| `not found: <path>` | `reveal_in_finder` on bad path | Agent re-runs `find_files` first |
| `screenshot failed` | `screencapture` denied / no display | Tell user to grant screen recording permission |
| `<stderr from the binary>` | Underlying tool failed | Surface verbatim — model usually self-corrects |

---

## 9. Performance & Cost

| Concern | Knob |
| --- | --- |
| Screenshot tokens | Prefer `region: 'interactive'`. A 1024×1024 PNG ≈ 1.5k input tokens |
| File search latency | Always pass `scope` to `find_files` |
| Cost ceiling | `maxBudgetUsd: 0.05` per typical run |
| Tool concurrency | Desktop tools mostly serial; default `AGENT_SDK_MAX_TOOL_CONCURRENCY` is fine |

---

## 10. Verification

```bash
# Static
npm run build

# Unit tests for tier wiring + cross-platform guards
npx tsx --test tests/desktop.test.ts

# Live (needs CLAVUE_AGENT_API_KEY + a vision model)
npx tsx examples/34-desktop-tools.ts
```

When running live, manually check:

1. `read_clipboard` returns whatever you copied last.
2. `capture_screen` in `interactive` mode prompts you to drag a region.
3. `open_path` / `reveal_in_finder` actually open Finder / Explorer.
4. `compose_email` opens a draft in your default mail client; nothing is sent.
5. `notify` shows a system banner.
6. On the wrong OS, `run_applescript` / `run_powershell` return a clean "not supported" message instead of crashing.

---

## 11. Roadmap (Not Yet Implemented — Add Yourself If Needed)

- `record_screen` — short MP4 / GIF capture (depends on `ffmpeg` or platform recorders).
- `read_active_window` — title + bundle id of the focused window (macOS via AppleScript, Win via `GetForegroundWindow`).
- `paste_from_clipboard` — simulate paste keystroke. Out of scope — needs an RPA library.
- `office_word_*` / `office_excel_*` — COM-typed wrappers. Implement in the host with `run_powershell` until a typed Node binding is widely available.
- `feishu_webhook_handler` — first-class Feishu event ingestion. Belongs in your service, not the SDK.

PRs welcome — keep each new tool tier-tagged and platform-detecting.

---

## 12. Compliance Reminders

- These tools see whatever the user sees and copies. Make sure your host UI tells the user that.
- `compose_email` and `launch_app` change visible state. Confirm before invoking in non-supervised contexts.
- `run_applescript` / `run_powershell` are general-purpose code execution. Treat them like `bash` — restrict, log, and review.
- Do not log raw screenshot bytes or clipboard contents to durable storage without consent.
