import { spawn } from 'child_process'
import process from 'process'
import type {
  RetroQualityGate,
  RetroQualityGateResult,
  RetroVerificationInput,
  RetroVerificationResult,
} from './types.js'

const DEFAULT_RETRO_GATES: RetroQualityGate[] = [
  { name: 'build', command: 'npm', args: ['run', 'build'], timeoutMs: 120_000 },
  { name: 'test', command: 'npm', args: ['test'], timeoutMs: 120_000 },
]

function getDefaultGateCwd(input: RetroVerificationInput): string {
  return input.target.cwd ?? process.cwd()
}

function runGate(
  gate: RetroQualityGate,
  defaultCwd: string,
): Promise<RetroQualityGateResult> {
  const startedAt = Date.now()
  const args = gate.args ?? []
  const cwd = gate.cwd ?? defaultCwd

  return new Promise((resolve) => {
    const child = spawn(gate.command, args, {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let timeoutId: NodeJS.Timeout | undefined
    let settled = false

    const finish = (result: RetroQualityGateResult) => {
      if (settled) return
      settled = true
      if (timeoutId) clearTimeout(timeoutId)
      resolve(result)
    }

    child.stdout.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString()
    })

    child.on('error', (error) => {
      finish({
        name: gate.name,
        command: gate.command,
        args,
        cwd,
        passed: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        error: error.message,
      })
    })

    child.on('close', (code) => {
      finish({
        name: gate.name,
        command: gate.command,
        args,
        cwd,
        passed: code === 0,
        exitCode: code,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      })
    })

    const timeoutMs = gate.timeoutMs
    if (typeof timeoutMs === 'number' && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        child.kill('SIGTERM')
        finish({
          name: gate.name,
          command: gate.command,
          args,
          cwd,
          passed: false,
          exitCode: null,
          durationMs: Date.now() - startedAt,
          stdout,
          stderr,
          error: `Timed out after ${timeoutMs}ms`,
        })
      }, timeoutMs)
    }
  })
}

export async function runRetroVerification(
  input: RetroVerificationInput,
): Promise<RetroVerificationResult> {
  const startedAtIso = new Date().toISOString()
  const startedAtMs = Date.now()
  const gates = input.gates ?? DEFAULT_RETRO_GATES
  const defaultCwd = getDefaultGateCwd(input)
  const results: RetroQualityGateResult[] = []

  for (const gate of gates) {
    const result = await runGate(gate, defaultCwd)
    results.push(result)
    if (!result.passed && !gate.continueOnFailure) break
  }

  const passed = results.length > 0 && results.every((result) => result.passed)
  const failedGate = results.find((result) => !result.passed)

  return {
    passed,
    summary: passed
      ? `All ${results.length} quality gate(s) passed.`
      : `Quality gate failed: ${failedGate?.name ?? 'unknown'}.`,
    startedAt: startedAtIso,
    completedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAtMs,
    gates: results,
  }
}
