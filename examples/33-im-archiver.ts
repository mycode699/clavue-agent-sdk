/**
 * Example 33: Desktop IM Archiver — clipboard + screenshot + classification
 *
 * Goal: integrate clavue-agent-sdk into a host application (Electron tray app,
 * Hammerspoon binding, AutoHotkey script, ...) that helps the user archive
 * messages from desktop IM clients (WeChat / Feishu / QQ / DingTalk) WITHOUT
 * touching the IM client's internals.
 *
 * Strategy:
 *   1. The host triggers archiving (global hotkey, tray click, scheduled job).
 *   2. The agent calls `read_clipboard` (user pre-copied chat text) OR
 *      `capture_screen` (returns an image block — the model reads it directly
 *      via vision; no separate OCR step is required for Claude/GPT-4o).
 *   3. The agent extracts sender / time / body, classifies the content, and
 *      calls `archive_message` to persist into the host's database.
 *
 * What this example demonstrates about the SDK:
 *   - Custom tools via `tool()` + `createSdkMcpServer()` (in-process MCP).
 *   - Returning `image` content from a tool — fed straight to the vision-
 *     capable model. No OCR pipeline needed.
 *   - Host-side authorization via `canUseTool` (privacy gate).
 *   - `permissionMode: 'default'` keeps tool gating explicit.
 *
 * Run:
 *   export CLAVUE_AGENT_API_KEY=...
 *   export CLAVUE_AGENT_MODEL=claude-sonnet-4-6   # or gpt-4o
 *   npx tsx examples/33-im-archiver.ts
 *
 * Production hardening (see docs/programmatic-integration-guide.md §13):
 *   - Replace the in-memory `archiveStore` with your real DB.
 *   - Wire `canUseTool` to your privacy / consent UI.
 *   - Wrap `agent.run()` in a global hotkey handler (Hammerspoon / Electron
 *     globalShortcut / AutoHotkey).
 */

import { execFileSync } from 'node:child_process'
import { readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import {
  createAgent,
  createSdkMcpServer,
  tool,
  type CanUseToolFn,
} from '../src/index.js'

// --------------------------------------------------------------------------
// Tool 1: read_clipboard — user pre-copied chat content
// --------------------------------------------------------------------------

const readClipboard = tool(
  'read_clipboard',
  'Read the system clipboard. Use after the user has copied chat messages from WeChat / Feishu / QQ / DingTalk.',
  {},
  async () => {
    let text: string
    if (process.platform === 'darwin') {
      text = execFileSync('pbpaste', { encoding: 'utf8' })
    } else if (process.platform === 'win32') {
      text = execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'], { encoding: 'utf8' })
    } else {
      // Linux: prefer wl-paste (Wayland) then xclip (X11). Fall back gracefully.
      try {
        text = execFileSync('wl-paste', { encoding: 'utf8' })
      } catch {
        text = execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' })
      }
    }
    return {
      content: [{ type: 'text' as const, text: text.slice(0, 20_000) }],
    }
  },
  { annotations: { readOnlyHint: true } },
)

// --------------------------------------------------------------------------
// Tool 2: capture_screen — returns an image block, fed straight to vision.
// No OCR step — Claude 3.5+/GPT-4o read Chinese chat screenshots directly.
// --------------------------------------------------------------------------

const captureScreen = tool(
  'capture_screen',
  'Capture a region of the screen and return it as an image. The model can read text in the image directly via vision; no separate OCR is needed. Prefer "interactive" so the user selects a single chat window — full-screen captures lose resolution under vision token limits.',
  {
    region: z
      .enum(['interactive', 'full'])
      .default('interactive')
      .describe('"interactive" lets the user drag-select a region; "full" grabs the whole screen.'),
  },
  async ({ region }) => {
    const path = join(tmpdir(), `clavue-im-${Date.now()}.png`)
    try {
      if (process.platform === 'darwin') {
        // macOS: -i interactive, -x silent (no shutter sound), -o no shadow
        const args = region === 'interactive' ? ['-i', '-x', '-o', path] : ['-x', '-o', path]
        execFileSync('screencapture', args)
      } else if (process.platform === 'win32') {
        // Windows: requires nircmd or similar bundled binary in production.
        // For brevity, expect users to provide an external screenshot tool.
        throw new Error('Windows: bundle nircmd.exe or use screenshot-desktop. See docs §13.3.')
      } else {
        // Linux: grim (Wayland) / scrot (X11)
        const tool = process.env.WAYLAND_DISPLAY ? 'grim' : 'scrot'
        execFileSync(tool, [path])
      }

      const data = readFileSync(path).toString('base64')
      return {
        content: [{ type: 'image' as const, data, mimeType: 'image/png' }],
      }
    } finally {
      try {
        unlinkSync(path)
      } catch {
        /* ignore */
      }
    }
  },
  { annotations: { readOnlyHint: true } },
)

// --------------------------------------------------------------------------
// Tool 3: archive_message — write classified messages to the host DB.
// In production replace this with a real Postgres / SQLite / S3 sink.
// --------------------------------------------------------------------------

interface ArchivedRow {
  source: 'wechat' | 'feishu' | 'qq' | 'dingtalk' | 'other'
  contact: string
  body: string
  category: string
  importance: 'low' | 'normal' | 'high'
  archivedAt: string
}

const archiveStore: ArchivedRow[] = [] // demo only

const archiveMessage = tool(
  'archive_message',
  'Persist one extracted-and-classified message to the archive store.',
  {
    source: z.enum(['wechat', 'feishu', 'qq', 'dingtalk', 'other']),
    contact: z.string().describe('Sender or chat group display name.'),
    body: z.string().describe('Cleaned message body. Strip UI chrome, timestamps, system prompts.'),
    category: z.string().describe('Topic label, e.g. "工作/项目X", "广告", "重要通知".'),
    importance: z.enum(['low', 'normal', 'high']),
  },
  async ({ source, contact, body, category, importance }) => {
    const row: ArchivedRow = {
      source,
      contact,
      body,
      category,
      importance,
      archivedAt: new Date().toISOString(),
    }
    archiveStore.push(row)
    return {
      content: [
        {
          type: 'text' as const,
          text: `archived id=${archiveStore.length} source=${source} category=${category} importance=${importance}`,
        },
      ],
    }
  },
  { annotations: { destructiveHint: false, idempotentHint: false } },
)

// --------------------------------------------------------------------------
// In-process MCP server bundling all three tools.
// --------------------------------------------------------------------------

const archiverServer = createSdkMcpServer({
  name: 'im_archiver',
  version: '0.1.0',
  tools: [readClipboard, captureScreen, archiveMessage],
})

// --------------------------------------------------------------------------
// Privacy gate — host-side veto for every tool call.
// In a real Electron app, surface a confirmation toast before returning allow.
// --------------------------------------------------------------------------

const canUseTool: CanUseToolFn = async (toolName, input) => {
  // capture_screen could leak unrelated content — prompt the user upstream.
  // Here we just log and allow; replace with real consent UI.
  console.error(`[host-gate] ${toolName} ${JSON.stringify(input).slice(0, 120)}`)
  return { behavior: 'allow', updatedInput: input }
}

// --------------------------------------------------------------------------
// Driver — invoke once per "archive now" hotkey press in the host app.
// --------------------------------------------------------------------------

async function archiveOnce(promptHint: string) {
  const agent = createAgent({
    systemPrompt: [
      'You are an IM message archiver embedded in a desktop app.',
      'Pipeline:',
      '  1. Use `read_clipboard` if the user just copied chat text, otherwise `capture_screen`.',
      '  2. From the raw text/image, extract individual messages (sender, time if visible, body).',
      '  3. Classify each into one of: 工作 / 生活 / 广告 / 重要通知 / 其他.',
      '  4. Set importance: high for explicit asks/deadlines, low for ads, otherwise normal.',
      '  5. Call `archive_message` once per extracted message.',
      '  6. Reply with a one-line summary: "已归档 N 条 (高:x 普通:y 低:z)".',
      'Never invent messages. If you cannot read the input clearly, archive_message with importance=low and category="其他" so the human can review later.',
    ].join('\n'),
    mcpServers: { im_archiver: archiverServer as any },
    allowedTools: [
      'mcp__im_archiver__read_clipboard',
      'mcp__im_archiver__capture_screen',
      'mcp__im_archiver__archive_message',
    ],
    permissionMode: 'default',
    canUseTool,
    maxTurns: 12,
  })

  try {
    const result = await agent.run(promptHint)
    console.log('\n--- Agent reply ---')
    console.log(result.text)
    console.log('\n--- Archive store ---')
    console.table(archiveStore)
    return result
  } finally {
    await agent.close()
  }
}

// --------------------------------------------------------------------------
// Manual entry — pretend the host pressed the global hotkey.
// --------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  archiveOnce('归档我刚刚在微信里复制的聊天内容。如果剪贴板为空，对当前屏幕窗口截图后再分析。').catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

export { archiveOnce, archiverServer }
