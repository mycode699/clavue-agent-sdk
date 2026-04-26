/**
 * GlobTool - File pattern matching
 */

import { spawn } from 'child_process'
import { stat } from 'fs/promises'
import { resolve } from 'path'
import { defineTool } from './types.js'

async function sortByModifiedTime(searchDir: string, matches: string[]): Promise<string[]> {
  const entries = await Promise.all(
    matches.map(async (match) => {
      try {
        const stats = await stat(resolve(searchDir, match))
        return { match, mtimeMs: stats.mtimeMs }
      } catch {
        return { match, mtimeMs: 0 }
      }
    }),
  )
  return entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs || a.match.localeCompare(b.match))
    .map((entry) => entry.match)
}

export const GlobTool = defineTool({
  name: 'Glob',
  description: 'Find files matching a glob pattern. Returns matching file paths sorted by modification time. Supports patterns like "**/*.ts", "src/**/*.js".',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The glob pattern to match files against',
      },
      path: {
        type: 'string',
        description: 'The directory to search in (defaults to cwd)',
      },
    },
    required: ['pattern'],
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const searchDir = input.path ? resolve(context.cwd, input.path) : context.cwd
    const { pattern } = input

    try {
      // Use Node.js glob (available in Node 22+) or fall back to bash find
      const { glob } = await import('fs/promises')

      // @ts-ignore - glob is available in Node 22+
      if (typeof glob === 'function') {
        const matches: string[] = []
        // @ts-ignore
        for await (const entry of glob(pattern, { cwd: searchDir })) {
          matches.push(entry)
          if (matches.length >= 500) break
        }
        if (matches.length === 0) {
          return `No files matching pattern "${pattern}" in ${searchDir}`
        }
        return (await sortByModifiedTime(searchDir, matches)).join('\n')
      }
    } catch {
      // Fall through to bash-based approach
    }

    // Fallback: pass the pattern through an environment variable instead of interpolating it into shell source.
    return new Promise<string>((resolvePromise) => {
      const script = 'shopt -s globstar nullglob 2>/dev/null; compgen -G "$GLOB_PATTERN"'
      const proc = spawn('bash', ['-c', script], {
        cwd: searchDir,
        env: { ...process.env, GLOB_PATTERN: pattern },
        timeout: 30000,
      })

      const chunks: Buffer[] = []
      proc.stdout?.on('data', (d: Buffer) => chunks.push(d))
      proc.on('close', async () => {
        const result = Buffer.concat(chunks).toString('utf-8').trim()
        if (!result) {
          resolvePromise(`No files matching pattern "${pattern}" in ${searchDir}`)
        } else {
          const matches = result.split('\n').filter(Boolean).slice(0, 500)
          resolvePromise((await sortByModifiedTime(searchDir, matches)).join('\n'))
        }
      })
      proc.on('error', () => {
        resolvePromise(`Error searching for files with pattern "${pattern}"`)
      })
    })
  },
})
