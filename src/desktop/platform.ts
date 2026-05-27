/**
 * Cross-platform desktop helpers — internal.
 *
 * Centralizes the `execFile` plumbing, platform detection, timeout handling,
 * and binary-availability checks used by `src/desktop/*` tool factories.
 *
 * The desktop module is intentionally **opt-in**: it is not exported from the
 * SDK root and is not added to any built-in toolset. Hosts that want desktop
 * automation import from `clavue-agent-sdk/desktop` explicitly.
 *
 * Design rules:
 *   - Never throw across the tool boundary — return `{ isError: true }` text
 *     so the model can recover.
 *   - Never shell out to `bash -c "..."` with interpolated user input. Always
 *     pass arguments as an array to `execFile` to avoid injection.
 *   - Every long-running call has a wall-clock timeout (default 10s).
 *   - Every binary used is detectable with `which` / `where`. Surface a clear
 *     "not installed" message instead of a stack trace.
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)

export type DesktopPlatform = 'darwin' | 'win32' | 'linux'

export function currentPlatform(): DesktopPlatform | 'other' {
  if (process.platform === 'darwin') return 'darwin'
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'linux') return 'linux'
  return 'other'
}

export interface RunCmdOptions {
  /** Timeout in milliseconds. Default 10_000. */
  timeoutMs?: number
  /** Maximum stdout/stderr bytes captured. Default 1 MB. */
  maxBuffer?: number
  /** Environment overrides. */
  env?: NodeJS.ProcessEnv
  /** Working directory. */
  cwd?: string
}

export interface RunCmdResult {
  stdout: string
  stderr: string
  exitCode: number
}

/**
 * Run a command safely. Arguments are passed as an array — no shell
 * interpolation. Errors are normalized rather than thrown.
 */
export async function runCmd(
  bin: string,
  args: string[],
  opts: RunCmdOptions = {},
): Promise<RunCmdResult> {
  const { timeoutMs = 10_000, maxBuffer = 1_048_576, env, cwd } = opts
  try {
    const { stdout, stderr } = await execFileP(bin, args, {
      timeout: timeoutMs,
      maxBuffer,
      env: env ?? process.env,
      cwd,
      windowsHide: true,
    })
    return { stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 }
  } catch (err: any) {
    return {
      stdout: err?.stdout?.toString() ?? '',
      stderr: err?.stderr?.toString() ?? err?.message ?? String(err),
      exitCode: typeof err?.code === 'number' ? err.code : 1,
    }
  }
}

/**
 * Check whether a binary is reachable on PATH. Caches results per process.
 */
const binCache = new Map<string, boolean>()
export async function hasBinary(bin: string): Promise<boolean> {
  if (binCache.has(bin)) return binCache.get(bin)!
  const probe = process.platform === 'win32' ? 'where' : 'which'
  const r = await runCmd(probe, [bin], { timeoutMs: 2_000 })
  const ok = r.exitCode === 0 && r.stdout.trim().length > 0
  binCache.set(bin, ok)
  return ok
}

/**
 * Build a uniform "binary missing" CallToolResult.
 */
export function missingBinaryError(bin: string, hint?: string) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `binary not found: ${bin}${hint ? ` — ${hint}` : ''}`,
      },
    ],
    isError: true,
  }
}

/**
 * Trim and bound large stdout payloads before returning to the model.
 */
export function clipText(s: string, max = 20_000): string {
  if (s.length <= max) return s
  return s.slice(0, max) + `\n…(truncated ${s.length - max} chars)`
}

/**
 * Shell-quote a string for AppleScript embedding. Used by `darwin.ts` tools
 * to safely pass user-supplied text into `osascript -e '...'` payloads.
 *
 * AppleScript string literals only need backslash + double-quote escaping.
 */
export function asEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * PowerShell single-quote escape: `'` → `''`.
 */
export function psEscape(s: string): string {
  return s.replace(/'/g, "''")
}
