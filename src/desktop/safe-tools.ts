/**
 * Cross-platform desktop tools — safe layer (read-only / user-initiated).
 *
 * Every tool in this file is **non-destructive** by design:
 *   - read clipboard
 *   - capture screen (returns base64 image)
 *   - search files
 *   - open a folder / file / URL in the OS default handler
 *   - reveal a file in Finder / Explorer
 *
 * Compose into an in-process MCP server with `buildDesktopServer({ tier: 'safe' })`
 * — see `src/desktop/index.ts`.
 *
 * Platform notes:
 *   - macOS: zero extra binaries. Everything uses tools shipped with the OS
 *     (`pbpaste`, `screencapture`, `mdfind`, `open`).
 *   - Windows: PowerShell built-ins. `nircmd` is recommended for screenshots
 *     but not strictly required (a PowerShell fallback exists).
 *   - Linux: requires `wl-paste`/`xclip`, `grim`/`scrot`, `xdg-open`, `find`.
 */

import { readFileSync, unlinkSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { tool } from '../tool-helper.js'
import {
  clipText,
  currentPlatform,
  hasBinary,
  missingBinaryError,
  runCmd,
} from './platform.js'

// --------------------------------------------------------------------------
// readClipboard
// --------------------------------------------------------------------------

export const readClipboardTool = tool(
  'read_clipboard',
  'Read the system clipboard (plain text). Use after the user has copied content from any application (chat, browser, document).',
  {},
  async () => {
    const plat = currentPlatform()
    let result
    if (plat === 'darwin') {
      result = await runCmd('pbpaste', [])
    } else if (plat === 'win32') {
      result = await runCmd('powershell', ['-NoProfile', '-Command', 'Get-Clipboard'])
    } else if (plat === 'linux') {
      if (await hasBinary('wl-paste')) result = await runCmd('wl-paste', [])
      else if (await hasBinary('xclip')) result = await runCmd('xclip', ['-selection', 'clipboard', '-o'])
      else return missingBinaryError('wl-paste or xclip', 'install via your package manager')
    } else {
      return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
    }
    if (result.exitCode !== 0) return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    return { content: [{ type: 'text' as const, text: clipText(result.stdout) }] }
  },
  { annotations: { readOnlyHint: true } },
)

// --------------------------------------------------------------------------
// writeClipboard  (still safe: only writes the clipboard, not files)
// --------------------------------------------------------------------------

export const writeClipboardTool = tool(
  'write_clipboard',
  'Copy a text string into the system clipboard so the user can paste it.',
  { text: z.string() },
  async ({ text }) => {
    const plat = currentPlatform()
    let result
    if (plat === 'darwin') {
      result = await runCmd('bash', ['-c', `printf %s ${JSON.stringify(text)} | pbcopy`])
    } else if (plat === 'win32') {
      result = await runCmd('powershell', ['-NoProfile', '-Command', `Set-Clipboard -Value ${JSON.stringify(text)}`])
    } else if (plat === 'linux') {
      if (await hasBinary('wl-copy')) result = await runCmd('bash', ['-c', `printf %s ${JSON.stringify(text)} | wl-copy`])
      else if (await hasBinary('xclip')) result = await runCmd('bash', ['-c', `printf %s ${JSON.stringify(text)} | xclip -selection clipboard`])
      else return missingBinaryError('wl-copy or xclip')
    } else {
      return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
    }
    if (result.exitCode !== 0) return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    return { content: [{ type: 'text' as const, text: 'clipboard written' }] }
  },
  { annotations: { readOnlyHint: false } },
)

// --------------------------------------------------------------------------
// captureScreen
// --------------------------------------------------------------------------

export const captureScreenTool = tool(
  'capture_screen',
  'Capture the screen (or an interactively-selected region) and return a PNG image. The model can read the image directly via vision — no separate OCR step needed.',
  {
    region: z
      .enum(['interactive', 'full'])
      .default('interactive')
      .describe('"interactive" lets the user select a region/window; "full" captures the primary display.'),
  },
  async ({ region }) => {
    const path = join(tmpdir(), `clavue-shot-${Date.now()}.png`)
    const plat = currentPlatform()
    try {
      let result
      if (plat === 'darwin') {
        const args = region === 'interactive' ? ['-i', '-x', '-o', path] : ['-x', '-o', path]
        result = await runCmd('screencapture', args, { timeoutMs: 60_000 })
      } else if (plat === 'win32') {
        if (await hasBinary('nircmd')) {
          result = await runCmd('nircmd', ['savescreenshot', path])
        } else {
          // PowerShell fallback (full screen only — no interactive selection).
          const script = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width,$b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save('${path.replace(/\\/g, '\\\\')}')
$g.Dispose(); $bmp.Dispose()
`
          result = await runCmd('powershell', ['-NoProfile', '-Command', script], { timeoutMs: 15_000 })
        }
      } else if (plat === 'linux') {
        const bin = process.env.WAYLAND_DISPLAY && (await hasBinary('grim')) ? 'grim' : 'scrot'
        if (!(await hasBinary(bin))) return missingBinaryError(bin)
        result = await runCmd(bin, [path], { timeoutMs: 15_000 })
      } else {
        return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
      }
      if (result.exitCode !== 0 || !existsSync(path)) {
        return { content: [{ type: 'text' as const, text: result.stderr || 'screenshot failed' }], isError: true }
      }
      const data = readFileSync(path).toString('base64')
      return { content: [{ type: 'image' as const, data, mimeType: 'image/png' }] }
    } finally {
      try { unlinkSync(path) } catch { /* ignore */ }
    }
  },
  { annotations: { readOnlyHint: true } },
)

// --------------------------------------------------------------------------
// findFiles
// --------------------------------------------------------------------------

export const findFilesTool = tool(
  'find_files',
  'Search for files by name on the local filesystem. Uses Spotlight (macOS), Windows Search (Win), or `find` (Linux). Returns absolute paths.',
  {
    query: z.string().describe('File name fragment or full name. Spotlight syntax allowed on macOS.'),
    scope: z.string().optional().describe('Restrict search to a directory (absolute path).'),
    limit: z.number().int().positive().max(200).default(50),
  },
  async ({ query, scope, limit }) => {
    const plat = currentPlatform()
    let result
    if (plat === 'darwin') {
      const args = ['-name', query, '-0']
      if (scope) args.unshift('-onlyin', scope)
      result = await runCmd('mdfind', args, { timeoutMs: 15_000 })
    } else if (plat === 'win32') {
      // PowerShell Get-ChildItem; bounded to scope or user profile.
      const root = scope ?? '$env:USERPROFILE'
      const script = `Get-ChildItem -Path ${root} -Recurse -Filter '*${query.replace(/'/g, "''")}*' -ErrorAction SilentlyContinue | Select-Object -First ${limit} -ExpandProperty FullName`
      result = await runCmd('powershell', ['-NoProfile', '-Command', script], { timeoutMs: 30_000 })
    } else if (plat === 'linux') {
      const root = scope ?? process.env.HOME ?? '/'
      result = await runCmd('find', [root, '-iname', `*${query}*`, '-print'], { timeoutMs: 30_000 })
    } else {
      return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
    }
    if (result.exitCode !== 0 && !result.stdout) {
      return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    }
    const sep = plat === 'darwin' ? '\0' : '\n'
    const lines = result.stdout.split(sep).map((l) => l.trim()).filter(Boolean).slice(0, limit)
    return { content: [{ type: 'text' as const, text: lines.length ? lines.join('\n') : 'no matches' }] }
  },
  { annotations: { readOnlyHint: true } },
)

// --------------------------------------------------------------------------
// openPath  — open a file / folder / URL in the OS default handler.
// --------------------------------------------------------------------------

export const openPathTool = tool(
  'open_path',
  'Open a local file, folder, or URL using the OS default handler. Equivalent to double-clicking the item in Finder/Explorer.',
  {
    target: z.string().describe('Absolute path or URL (http(s)://, file://, mailto:, ...).'),
  },
  async ({ target }) => {
    const plat = currentPlatform()
    let result
    if (plat === 'darwin') result = await runCmd('open', [target])
    else if (plat === 'win32') result = await runCmd('cmd', ['/c', 'start', '', target])
    else if (plat === 'linux') result = await runCmd('xdg-open', [target])
    else return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
    if (result.exitCode !== 0) return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    return { content: [{ type: 'text' as const, text: `opened: ${target}` }] }
  },
  { annotations: { readOnlyHint: false } },
)

// --------------------------------------------------------------------------
// revealInFinder  — highlight a file in Finder / Explorer / file manager.
// --------------------------------------------------------------------------

export const revealInFinderTool = tool(
  'reveal_in_finder',
  'Reveal (highlight) a file or folder in the platform file manager without opening it.',
  { target: z.string().describe('Absolute path to a file or directory.') },
  async ({ target }) => {
    if (!existsSync(target)) return { content: [{ type: 'text' as const, text: `not found: ${target}` }], isError: true }
    const plat = currentPlatform()
    let result
    if (plat === 'darwin') result = await runCmd('open', ['-R', target])
    else if (plat === 'win32') result = await runCmd('explorer.exe', [`/select,${target}`])
    else if (plat === 'linux') result = await runCmd('xdg-open', [statSync(target).isDirectory() ? target : join(target, '..')])
    else return { content: [{ type: 'text' as const, text: `unsupported platform: ${process.platform}` }], isError: true }
    if (result.exitCode !== 0 && plat !== 'win32') {
      // explorer.exe /select returns code 1 on success — ignore on win32.
      return { content: [{ type: 'text' as const, text: result.stderr }], isError: true }
    }
    return { content: [{ type: 'text' as const, text: `revealed: ${target}` }] }
  },
  { annotations: { readOnlyHint: false } },
)
