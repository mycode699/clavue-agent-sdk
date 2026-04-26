/**
 * LSPTool - Language Server Protocol integration
 *
 * Provides code intelligence: go-to-definition, find-references,
 * hover, document symbols, workspace symbols, etc.
 */

import { execFile } from 'child_process'
import { promisify } from 'util'
import { readdir, readFile } from 'fs/promises'
import { join, resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../types.js'

const execFileAsync = promisify(execFile)
const sourceTypeArgs = ['--type-add', 'src:*.{ts,tsx,js,jsx,py,go,rs,java}', '-t', 'src']

export const LSPTool: ToolDefinition = {
  name: 'LSP',
  description: 'Language Server Protocol operations for code intelligence. Supports go-to-definition, find-references, hover, and symbol lookup.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'goToDefinition',
          'findReferences',
          'hover',
          'documentSymbol',
          'workspaceSymbol',
          'goToImplementation',
          'prepareCallHierarchy',
          'incomingCalls',
          'outgoingCalls',
        ],
        description: 'LSP operation to perform',
      },
      file_path: { type: 'string', description: 'File path for the operation' },
      line: { type: 'number', description: 'Line number (0-based)' },
      character: { type: 'number', description: 'Character position (0-based)' },
      query: { type: 'string', description: 'Symbol name (for workspace symbol search)' },
    },
    required: ['operation'],
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Code intelligence via Language Server Protocol.' },
  async call(input: any, context: { cwd: string }): Promise<ToolResult> {
    const { operation, file_path, line, character, query } = input

    // LSP requires a running language server. In standalone mode,
    // we fall back to basic grep/ripgrep-based symbol lookup.
    try {
      switch (operation) {
        case 'goToDefinition':
        case 'goToImplementation': {
          if (!file_path || line === undefined) {
            return { type: 'tool_result', tool_use_id: '', content: 'file_path and line required', is_error: true }
          }
          // Use grep to find definition
          const symbol = await getSymbolAtPosition(file_path, line, character || 0, context.cwd)
          if (!symbol) {
            return { type: 'tool_result', tool_use_id: '', content: 'Could not identify symbol at position' }
          }
          const pattern = `(function|class|interface|type|const|let|var|export)[[:space:]]+${escapeRegex(symbol)}`
          const results = await runSearch(['-n', pattern, ...sourceTypeArgs, context.cwd])
          return { type: 'tool_result', tool_use_id: '', content: results || `No definition found for "${symbol}"` }
        }

        case 'findReferences': {
          if (!file_path || line === undefined) {
            return { type: 'tool_result', tool_use_id: '', content: 'file_path and line required', is_error: true }
          }
          const sym = await getSymbolAtPosition(file_path, line, character || 0, context.cwd)
          if (!sym) {
            return { type: 'tool_result', tool_use_id: '', content: 'Could not identify symbol at position' }
          }
          const refs = await runSearch(['-n', escapeRegex(sym), ...sourceTypeArgs, context.cwd], 50)
          return { type: 'tool_result', tool_use_id: '', content: refs || `No references found for "${sym}"` }
        }

        case 'hover': {
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: 'Hover information requires a running language server. Use Read tool to examine the file content.',
          }
        }

        case 'documentSymbol': {
          if (!file_path) {
            return { type: 'tool_result', tool_use_id: '', content: 'file_path required', is_error: true }
          }
          const symbols = await runSearch(
            ['-n', '^[[:space:]]*(export[[:space:]]+)?(function|class|interface|type|const|let|var|enum)[[:space:]]+', file_path],
            undefined,
            context.cwd,
          )
          return { type: 'tool_result', tool_use_id: '', content: symbols || 'No symbols found' }
        }

        case 'workspaceSymbol': {
          if (!query) {
            return { type: 'tool_result', tool_use_id: '', content: 'query required', is_error: true }
          }
          const wsSymbols = await runSearch(['-n', escapeRegex(query), ...sourceTypeArgs, context.cwd], 30)
          return { type: 'tool_result', tool_use_id: '', content: wsSymbols || `No symbols found for "${query}"` }
        }

        default:
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: `LSP operation "${operation}" requires a running language server.`,
          }
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `LSP error: ${err.message}`,
        is_error: true,
      }
    }
  },
}

async function runSearch(args: string[], headLimit?: number, cwd?: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('rg', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 10000,
      maxBuffer: 1024 * 1024,
    })
    const result = String(stdout).trim()
    if (!headLimit) return result
    return result.split('\n').slice(0, headLimit).join('\n')
  } catch (err: any) {
    if (err?.code === 1) return ''
    if (err?.code === 'ENOENT') return runSearchFallback(args, headLimit, cwd)
    throw err
  }
}

async function runSearchFallback(args: string[], headLimit?: number, cwd?: string): Promise<string> {
  const patternIndex = args.indexOf('-n') + 1
  const pattern = patternIndex > 0 ? args[patternIndex] : args[0]
  const searchPath = args.at(-1) || cwd || process.cwd()
  const regex = new RegExp(pattern)
  const files = await collectSourceFiles(resolve(cwd || process.cwd(), searchPath))
  const matches: string[] = []

  for (const file of files) {
    const content = await readFile(file, 'utf-8')
    const lines = content.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push(`${file}:${i + 1}:${lines[i]}`)
        if (headLimit && matches.length >= headLimit) return matches.join('\n')
      }
    }
  }

  return matches.join('\n')
}

async function collectSourceFiles(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(async () => [])
  if (!entries.length) return isSourceFile(path) ? [path] : []

  const files: string[] = []
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue
    const fullPath = join(path, entry.name)
    if (entry.isDirectory()) {
      files.push(...await collectSourceFiles(fullPath))
    } else if (entry.isFile() && isSourceFile(fullPath)) {
      files.push(fullPath)
    }
  }
  return files
}

function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|py|go|rs|java)$/.test(path)
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Get the symbol at a given position in a file.
 */
async function getSymbolAtPosition(
  filePath: string,
  line: number,
  character: number,
  cwd: string,
): Promise<string | null> {
  try {
    const content = await readFile(resolve(cwd, filePath), 'utf-8')
    const lines = content.split('\n')

    if (line >= lines.length) return null

    const lineText = lines[line]
    if (!lineText || character >= lineText.length) return null

    // Extract word at position
    const wordMatch = /\b\w+\b/g
    let match
    while ((match = wordMatch.exec(lineText)) !== null) {
      if (match.index <= character && match.index + match[0].length >= character) {
        return match[0]
      }
    }

    return null
  } catch {
    return null
  }
}
