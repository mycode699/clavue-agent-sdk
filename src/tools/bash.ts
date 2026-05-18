/**
 * BashTool - Execute shell commands
 */

import { spawn } from 'child_process'
import { defineTool } from './types.js'
import { wrapSpawnForSandbox } from '../sandbox/exec-sandbox.js'

function classifyShellCommand(command: string): { blocked: boolean; reason?: string; pattern?: string } {
  const destructivePatterns = [
    /(?:^|[\s;&|()])rm\s+[^\n;&|]*-[^\n;&|]*r[^\n;&|]*f[^\n;&|]*/i,
    /(?:^|[\s;&|()])rm\s+[^\n;&|]*-[^\n;&|]*f[^\n;&|]*r[^\n;&|]*/i,
  ]

  for (const pattern of destructivePatterns) {
    const match = command.match(pattern)
    if (match) {
      return {
        blocked: true,
        reason: 'destructive command',
        pattern: match[0].trim(),
      }
    }
  }

  return { blocked: false }
}

export const BashTool = defineTool({
  name: 'Bash',
  description: 'Execute a bash command and return its output. Use for running shell commands, scripts, and system operations.',
  inputSchema: {
    type: 'object',
    properties: {
      command: {
        type: 'string',
        description: 'The bash command to execute',
      },
      timeout: {
        type: 'number',
        description: 'Optional timeout in milliseconds (max 600000, default 120000)',
      },
    },
    required: ['command'],
  },
  safety: {
    read: true,
    write: true,
    shell: true,
    network: true,
    externalState: true,
    destructive: true,
    approvalRequired: true,
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    const { command, timeout: userTimeout } = input
    const classification = classifyShellCommand(command)
    if (classification.blocked) {
      return {
        data: `Error: blocked ${classification.reason}: ${classification.pattern}`,
        is_error: true,
      }
    }

    const timeoutMs = Math.min(userTimeout || 120000, 600000)

    // M3 sandbox — wrap when settings.enabled. Pass-through when off /
    // unsupported (notice surfaced in trace via stderr prefix).
    const wrap = wrapSpawnForSandbox({
      command: 'bash',
      args: ['-c', command],
      cwd: context.cwd,
      settings: context.sandbox,
    })

    return new Promise<string>((resolve) => {
      const chunks: Buffer[] = []
      const errChunks: Buffer[] = []
      if (wrap.notice) {
        errChunks.push(Buffer.from(`[sandbox] ${wrap.notice}\n`))
      }

      const proc = spawn(wrap.command, wrap.args, {
        cwd: context.cwd,
        env: { ...process.env },
        timeout: timeoutMs,
        stdio: ['pipe', 'pipe', 'pipe'],
      })

      proc.stdout?.on('data', (data: Buffer) => chunks.push(data))
      proc.stderr?.on('data', (data: Buffer) => errChunks.push(data))

      if (context.abortSignal) {
        context.abortSignal.addEventListener('abort', () => {
          proc.kill('SIGTERM')
        }, { once: true })
      }

      proc.on('close', (code) => {
        const stdout = Buffer.concat(chunks).toString('utf-8')
        const stderr = Buffer.concat(errChunks).toString('utf-8')

        let output = ''
        if (stdout) output += stdout
        if (stderr) output += (output ? '\n' : '') + stderr
        if (code !== 0 && code !== null) {
          output += `\nExit code: ${code}`
        }

        // Truncate very large outputs
        if (output.length > 100000) {
          output = output.slice(0, 50000) + '\n...(truncated)...\n' + output.slice(-50000)
        }

        resolve(output || '(no output)')
      })

      proc.on('error', (err) => {
        resolve(`Error executing command: ${err.message}`)
      })
    })
  },
})
