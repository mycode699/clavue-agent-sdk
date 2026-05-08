/**
 * Verifier — runs verification commands (tests, lint, typecheck) and produces
 * QualityGateResult records that drive the issue-workflow loop's pass/fail
 * decision.
 *
 * Default implementation: CommandVerifier — shells out to user-supplied
 * commands and grades by exit code. Hosts can supply a custom Verifier (e.g.
 * one that uses an existing CI agent) by implementing the interface.
 *
 * @module
 */

import { spawn } from 'node:child_process'
import type { QualityGateResult } from '../types.js'

export interface VerifyInput {
  /** Working directory in which to run verification commands. */
  cwd: string
  /** Iteration index (1-based) — included for telemetry only. */
  iteration?: number
}

export interface Verifier {
  /**
   * Run all configured checks against `input.cwd`.
   * Returns one QualityGateResult per check, in the order they were defined.
   */
  verify(input: VerifyInput): Promise<QualityGateResult[]>
}

export interface CommandVerifierCheck {
  /** Logical gate name (e.g. "tests", "lint", "typecheck"). */
  name: string
  /** Shell command to run. Executed via /bin/sh -c. */
  cmd: string
  /** Optional millisecond timeout. Default: 120000 (2 minutes). */
  timeoutMs?: number
}

export interface CommandVerifierOptions {
  /** Optional environment variables overlaid on top of process.env. */
  env?: Record<string, string>
  /** Cap on captured stdout/stderr per check (default 4096 bytes each end). */
  maxOutputBytes?: number
}

interface CommandResult {
  exitCode: number
  stdout: string
  stderr: string
  timedOut: boolean
}

/**
 * Run a shell command with a timeout, capturing trimmed stdout/stderr.
 * Pure helper — no side effects on process state.
 */
async function runCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  env: Record<string, string>,
  maxBytes: number,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn('/bin/sh', ['-c', cmd], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore — process may already have exited
      }
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({
        exitCode: typeof code === 'number' ? code : -1,
        stdout: clipTail(stdout, maxBytes),
        stderr: clipTail(stderr, maxBytes),
        timedOut,
      })
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({
        exitCode: -1,
        stdout: clipTail(stdout, maxBytes),
        stderr: clipTail(stderr + `\n[spawn error] ${err.message}`, maxBytes),
        timedOut,
      })
    })
  })
}

function clipTail(text: string, maxBytes: number): string {
  if (text.length <= maxBytes) return text
  return `…(truncated)…\n${text.slice(-maxBytes)}`
}

/**
 * CommandVerifier — runs each configured shell check sequentially and grades
 * by exit code. Each check produces one QualityGateResult.
 *
 * Status mapping:
 *   exitCode === 0           → status: 'passed'
 *   timedOut                 → status: 'failed', summary mentions timeout
 *   exitCode !== 0           → status: 'failed'
 *
 * The verifier is intentionally synchronous-by-check (no parallelism). Test
 * runners often share state (build caches, ports); running them sequentially
 * is the predictable default. Hosts that need parallel execution can wrap
 * multiple verifiers with Promise.all themselves.
 */
export class CommandVerifier implements Verifier {
  private readonly checks: CommandVerifierCheck[]
  private readonly env: Record<string, string>
  private readonly maxOutputBytes: number

  constructor(checks: CommandVerifierCheck[], options: CommandVerifierOptions = {}) {
    if (!Array.isArray(checks) || checks.length === 0) {
      throw new Error('CommandVerifier requires at least one check')
    }
    this.checks = checks.map((c) => ({ ...c }))
    this.env = options.env ?? {}
    this.maxOutputBytes = options.maxOutputBytes ?? 4096
  }

  async verify(input: VerifyInput): Promise<QualityGateResult[]> {
    const results: QualityGateResult[] = []
    for (const check of this.checks) {
      const result = await runCommand(
        check.cmd,
        input.cwd,
        check.timeoutMs ?? 120_000,
        this.env,
        this.maxOutputBytes,
      )
      const passed = result.exitCode === 0 && !result.timedOut
      results.push({
        name: check.name,
        status: passed ? 'passed' : 'failed',
        summary: buildSummary(check, result),
      })
    }
    return results
  }
}

function buildSummary(check: CommandVerifierCheck, result: CommandResult): string {
  if (result.timedOut) {
    return `[${check.name}] timed out after ${check.timeoutMs ?? 120_000}ms running: ${check.cmd}`
  }
  const tail = result.exitCode === 0 ? result.stdout : result.stderr || result.stdout
  const status = `exit=${result.exitCode}`
  return tail.trim() ? `[${check.name}] ${status}\n${tail.trim()}` : `[${check.name}] ${status}`
}

/**
 * StaticVerifier — returns pre-computed gate results without running any
 * commands. Useful for testing the issue-workflow real loop without spawning
 * subprocesses. Not intended for production use.
 */
export class StaticVerifier implements Verifier {
  constructor(private readonly results: QualityGateResult[] | (() => QualityGateResult[] | Promise<QualityGateResult[]>)) {}

  async verify(): Promise<QualityGateResult[]> {
    const value = typeof this.results === 'function' ? await this.results() : this.results
    return value.map((r) => ({ ...r }))
  }
}
