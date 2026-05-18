/**
 * M3 sandbox — OS-level command-execution wrapper.
 *
 * Wraps `child_process.spawn` arguments with a platform sandbox driver
 * when `SandboxSettings.enabled === true`. The driver is a pure mapping
 * from settings + (command, args) to a new (command, args) pair; the
 * caller still does the spawn itself, so timeouts / abort signals / stdio
 * stay the responsibility of the tool.
 *
 * Supported platforms:
 *   - `darwin`: `sandbox-exec -p '<sbpl-profile>'`.
 *   - `linux`:  `bwrap` if available; else returns `unsupported`.
 *   - other:    `unsupported` (Windows etc.).
 *
 * `unsupported` is a soft signal: the caller decides whether to fall
 * back to unsandboxed execution (default) or refuse. This module never
 * throws — it returns the decision and lets the tool log/route it.
 */

import { existsSync } from 'node:fs'
import { platform } from 'node:os'
import type { SandboxSettings } from '../types/sandbox.js'

export type SandboxDriverKind = 'sandbox-exec' | 'bwrap' | 'unsupported' | 'disabled'

export interface SandboxWrap {
  /** Final command to spawn (e.g. `sandbox-exec`, `bwrap`, or the original `bash`). */
  command: string
  /** Final argv. The original command becomes a tail of this array. */
  args: string[]
  /** Which driver shaped the result. `'disabled'` = pass-through (sandbox off). */
  driver: SandboxDriverKind
  /** Human-readable note for trace/log; useful when driver is `unsupported`. */
  notice?: string
}

/**
 * Build an SBPL profile string for macOS `sandbox-exec`. Default-deny
 * everything risky; allow:
 *   - process spawning (so bash itself can fork ls/grep/etc.),
 *   - read from any path except `denyRead`,
 *   - write to the cwd subtree and any `allowWrite` paths,
 *   - network only when `allowedDomains` is empty AND
 *     `allowManagedDomainsOnly` is not true; otherwise block.
 */
export function buildMacSandboxProfile(input: {
  cwd: string
  settings: SandboxSettings
}): string {
  const { cwd, settings } = input
  const fs = settings.filesystem ?? {}
  const net = settings.network ?? {}

  const allowWriteLines = [cwd, ...(fs.allowWrite ?? [])].map(
    (p) => `(allow file-write* (subpath "${escapeSbpl(p)}"))`,
  )
  const denyWriteLines = (fs.denyWrite ?? []).map(
    (p) => `(deny file-write* (subpath "${escapeSbpl(p)}"))`,
  )
  const denyReadLines = (fs.denyRead ?? []).map(
    (p) => `(deny file-read* (subpath "${escapeSbpl(p)}"))`,
  )

  // Network: only fully open when no allowlist + no managed-only flag.
  // Otherwise default-deny; callers wanting domain filtering should use
  // a proxy and add the proxy port to allowed sockets (Phase 2).
  const networkAllowed =
    !net.allowManagedDomainsOnly &&
    (!net.allowedDomains || net.allowedDomains.length === 0)
  const networkLine = networkAllowed
    ? '(allow network*)'
    : '(deny network* (with no-log))'

  return [
    '(version 1)',
    '(deny default)',
    '(allow process*)',
    '(allow signal)',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    '(allow ipc-posix-shm)',
    '(allow file-read*)',
    ...denyReadLines,
    ...allowWriteLines,
    ...denyWriteLines,
    networkLine,
  ].join('\n')
}

/** Escape characters that would close the SBPL string literal. */
function escapeSbpl(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Decide how to wrap a child process spawn given the active sandbox
 * settings. When sandboxing is off, returns a pass-through (`driver:
 * 'disabled'`). When the platform driver is missing, returns
 * `unsupported` — the caller decides whether to proceed unsandboxed
 * (default for backward-compat) or refuse.
 */
export function wrapSpawnForSandbox(input: {
  command: string
  args: string[]
  cwd: string
  settings?: SandboxSettings
  platformOverride?: NodeJS.Platform
  /** Test seam: override `sandbox-exec`/`bwrap` path probe. */
  binaryExists?: (path: string) => boolean
}): SandboxWrap {
  const { command, args, cwd } = input
  const settings = input.settings
  if (!settings?.enabled) {
    return { command, args, driver: 'disabled' }
  }
  const plat = input.platformOverride ?? platform()
  const probe = input.binaryExists ?? defaultBinaryExists

  if (plat === 'darwin' && probe('/usr/bin/sandbox-exec')) {
    const profile = buildMacSandboxProfile({ cwd, settings })
    return {
      command: '/usr/bin/sandbox-exec',
      args: ['-p', profile, command, ...args],
      driver: 'sandbox-exec',
    }
  }

  if (plat === 'linux' && probe('/usr/bin/bwrap')) {
    return {
      command: '/usr/bin/bwrap',
      args: buildBwrapArgs({ cwd, settings, command, args }),
      driver: 'bwrap',
    }
  }

  return {
    command,
    args,
    driver: 'unsupported',
    notice:
      plat === 'win32'
        ? 'sandbox unsupported on win32 — running command unsandboxed'
        : `sandbox driver missing on ${plat} — running command unsandboxed`,
  }
}

function defaultBinaryExists(path: string): boolean {
  try {
    return existsSync(path)
  } catch {
    return false
  }
}

/**
 * Build a minimal bwrap argv:
 *   - mount the real /, /usr, /lib, /lib64 read-only,
 *   - bind cwd + allowWrite paths read/write,
 *   - --unshare-net unless network is fully open,
 *   - drop privileges to current uid/gid,
 *   - then run the original command.
 */
function buildBwrapArgs(input: {
  cwd: string
  settings: SandboxSettings
  command: string
  args: string[]
}): string[] {
  const { cwd, settings, command, args } = input
  const fs = settings.filesystem ?? {}
  const net = settings.network ?? {}

  const argv: string[] = [
    '--die-with-parent',
    '--unshare-pid',
    '--unshare-uts',
    '--unshare-ipc',
    '--proc',
    '/proc',
    '--dev',
    '/dev',
    '--ro-bind',
    '/usr',
    '/usr',
    '--ro-bind',
    '/lib',
    '/lib',
    '--ro-bind',
    '/lib64',
    '/lib64',
    '--ro-bind',
    '/bin',
    '/bin',
    '--ro-bind',
    '/etc',
    '/etc',
  ]

  // Network sharing: only keep host network if fully open.
  const networkAllowed =
    !net.allowManagedDomainsOnly &&
    (!net.allowedDomains || net.allowedDomains.length === 0)
  if (!networkAllowed) {
    argv.push('--unshare-net')
  }

  // cwd is the primary writable subtree.
  argv.push('--bind', cwd, cwd)
  for (const path of fs.allowWrite ?? []) {
    argv.push('--bind', path, path)
  }
  for (const path of fs.denyWrite ?? []) {
    argv.push('--ro-bind', path, path)
  }
  for (const path of fs.denyRead ?? []) {
    argv.push('--tmpfs', path)
  }

  argv.push('--chdir', cwd)
  argv.push(command, ...args)
  return argv
}
