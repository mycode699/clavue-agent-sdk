/**
 * Desktop tools — automation tier (UI-driving / app-launching).
 *
 * **Higher blast radius than `safe-tools.ts`.** Each tool here is opt-in:
 *
 *   buildDesktopServer({ tier: 'automation' })
 *
 * is required to include them, and the host MUST wire `canUseTool` to a
 * consent gate. The agent layer marks these `destructiveHint: false` but
 * `idempotentHint: false` — repeated invocations may compose unintended
 * effects (e.g. opening multiple browser windows).
 *
 * Coverage:
 *   - launch / focus a named application
 *   - draft an email (defers send to user via mailto: handler — NEVER auto-sends)
 *   - open a URL in the user's default browser
 *   - send a system notification
 *   - run an AppleScript / PowerShell snippet under host approval
 *
 * Explicitly out of scope:
 *   - No keystroke injection helpers. If a host wants RPA, it should wrap
 *     `nut.js` / `robotjs` / `pyautogui` in a separate, named tool with its
 *     own consent screen.
 *   - No "send WeChat message" tool. The clipboard + paste pattern via
 *     `safe-tools.ts` keeps the user in the loop.
 *   - No "delete file" / "kill process" tool. Hosts that want them should
 *     define them themselves so the consent UI is unambiguous.
 */

import { z } from 'zod'

import { tool } from '../tool-helper.js'
import {
  asEscape,
  currentPlatform,
  psEscape,
  runCmd,
} from './platform.js'

// --------------------------------------------------------------------------
// launchApp — open or focus an application by name.
// --------------------------------------------------------------------------

export const launchAppTool = tool(
  'launch_app',
  'Launch or focus an application by display name. Examples: "WeChat", "Lark", "Feishu", "Google Chrome", "Microsoft Word", "WPS", "QQ", "Mail".',
  { name: z.string().describe('Application display name as shown in Finder / Start menu.') },
  async ({ name }) => {
    const plat = currentPlatform()
    let result
    if (plat === 'darwin') result = await runCmd('open', ['-a', name])
    else if (plat === 'win32') result = await runCmd('powershell', ['-NoProfile', '-Command', `Start-Process '${psEscape(name)}'`])
    else if (plat === 'linux') result = await runCmd('bash', ['-c', `gtk-launch ${JSON.stringify(name)} 2>/dev/null || ${JSON.stringify(name)}`])
    else return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
    if (result.exitCode !== 0) return { content: [{ type: 'text' as const, text: result.stderr || 'launch failed' }], isError: true }
    return { content: [{ type: 'text' as const, text: `launched: ${name}` }] }
  },
  { annotations: { readOnlyHint: false, idempotentHint: false } },
)

// --------------------------------------------------------------------------
// composeEmail — open the default mail client with a pre-filled draft.
// NEVER sends the email; the user must press send.
// --------------------------------------------------------------------------

export const composeEmailTool = tool(
  'compose_email',
  'Open the OS default mail client (Gmail web, Outlook, Apple Mail, Foxmail, ...) with a pre-filled draft. The user must press send — this tool never sends automatically.',
  {
    to: z.array(z.string()).min(1),
    cc: z.array(z.string()).default([]),
    bcc: z.array(z.string()).default([]),
    subject: z.string().default(''),
    body: z.string().default(''),
  },
  async ({ to, cc, bcc, subject, body }) => {
    const params = new URLSearchParams()
    if (cc.length) params.set('cc', cc.join(','))
    if (bcc.length) params.set('bcc', bcc.join(','))
    if (subject) params.set('subject', subject)
    if (body) params.set('body', body)
    const qs = params.toString()
    const url = `mailto:${to.join(',')}${qs ? '?' + qs : ''}`
    const plat = currentPlatform()
    let result
    if (plat === 'darwin') result = await runCmd('open', [url])
    else if (plat === 'win32') result = await runCmd('cmd', ['/c', 'start', '', url])
    else if (plat === 'linux') result = await runCmd('xdg-open', [url])
    else return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
    if (result.exitCode !== 0) return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    return { content: [{ type: 'text' as const, text: `draft opened for ${to.join(', ')}` }] }
  },
  { annotations: { readOnlyHint: false, idempotentHint: false } },
)

// --------------------------------------------------------------------------
// openInBrowser — explicitly target the user's default browser.
// --------------------------------------------------------------------------

export const openInBrowserTool = tool(
  'open_in_browser',
  'Open a URL in the user default browser. Useful for Gmail, Feishu web, Google Docs, Notion, etc.',
  { url: z.string().url() },
  async ({ url }) => {
    const plat = currentPlatform()
    let result
    if (plat === 'darwin') result = await runCmd('open', [url])
    else if (plat === 'win32') result = await runCmd('cmd', ['/c', 'start', '', url])
    else if (plat === 'linux') result = await runCmd('xdg-open', [url])
    else return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
    if (result.exitCode !== 0) return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    return { content: [{ type: 'text' as const, text: `opened: ${url}` }] }
  },
  { annotations: { readOnlyHint: false } },
)

// --------------------------------------------------------------------------
// notify — system notification banner.
// --------------------------------------------------------------------------

export const notifyTool = tool(
  'notify',
  'Show a system notification banner with a title and body. Useful for "归档完成 N 条" style feedback.',
  {
    title: z.string(),
    body: z.string().default(''),
  },
  async ({ title, body }) => {
    const plat = currentPlatform()
    let result
    if (plat === 'darwin') {
      const script = `display notification "${asEscape(body)}" with title "${asEscape(title)}"`
      result = await runCmd('osascript', ['-e', script])
    } else if (plat === 'win32') {
      const script = `[reflection.assembly]::loadwithpartialname('System.Windows.Forms') | Out-Null
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::Information
$n.BalloonTipTitle = '${psEscape(title)}'
$n.BalloonTipText = '${psEscape(body)}'
$n.Visible = $true
$n.ShowBalloonTip(4000)
Start-Sleep -Seconds 5
$n.Dispose()`
      result = await runCmd('powershell', ['-NoProfile', '-Command', script], { timeoutMs: 8_000 })
    } else if (plat === 'linux') {
      result = await runCmd('notify-send', [title, body])
    } else {
      return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
    }
    if (result.exitCode !== 0) return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    return { content: [{ type: 'text' as const, text: 'notified' }] }
  },
  { annotations: { readOnlyHint: false } },
)

// --------------------------------------------------------------------------
// runAppleScript — macOS-only, behind explicit allowlist.
// --------------------------------------------------------------------------

export const runAppleScriptTool = tool(
  'run_applescript',
  'macOS only: run an AppleScript snippet via osascript. Use sparingly — host MUST gate this in canUseTool. Common uses: tell Microsoft Word to count words, get the selected text from any app, focus a specific Lark channel.',
  { script: z.string().describe('AppleScript source.') },
  async ({ script }) => {
    if (currentPlatform() !== 'darwin') {
      return { content: [{ type: 'text' as const, text: 'AppleScript is macOS only' }], isError: true }
    }
    const result = await runCmd('osascript', ['-e', script], { timeoutMs: 20_000 })
    if (result.exitCode !== 0) return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    return { content: [{ type: 'text' as const, text: result.stdout.trim() || 'ok' }] }
  },
  { annotations: { readOnlyHint: false, idempotentHint: false } },
)

// --------------------------------------------------------------------------
// runPowerShell — Windows-only, behind explicit allowlist.
// --------------------------------------------------------------------------

export const runPowerShellTool = tool(
  'run_powershell',
  'Windows only: run a PowerShell snippet. Use sparingly — host MUST gate this in canUseTool. Useful for COM automation against Outlook / Word / Excel.',
  { script: z.string().describe('PowerShell source.') },
  async ({ script }) => {
    if (currentPlatform() !== 'win32') {
      return { content: [{ type: 'text' as const, text: 'PowerShell tool is Windows only' }], isError: true }
    }
    const result = await runCmd('powershell', ['-NoProfile', '-Command', script], { timeoutMs: 30_000 })
    if (result.exitCode !== 0) return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    return { content: [{ type: 'text' as const, text: result.stdout.trim() || 'ok' }] }
  },
  { annotations: { readOnlyHint: false, idempotentHint: false } },
)
