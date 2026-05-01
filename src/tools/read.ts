/**
 * FileReadTool - Read file contents with line numbers
 */

import { readFile, stat } from 'fs/promises'
import { defineTool } from './types.js'
import { resolveWorkspacePath } from './workspace.js'

export const FileReadTool = defineTool({
  name: 'Read',
  description: 'Read a file from the filesystem. Returns content with line numbers. Supports text files, images (returns visual content), and PDFs.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to read',
      },
      offset: {
        type: 'number',
        description: 'Line number to start reading from (0-based)',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of lines to read',
      },
    },
    required: ['file_path'],
  },
  safety: {
    read: true,
    idempotent: true,
  },
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input, context) {
    const filePath = resolveWorkspacePath(context, input.file_path)
    if (typeof filePath !== 'string') return filePath

    if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) {
      return { data: 'Error: offset must be a non-negative integer.', is_error: true }
    }

    if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) {
      return { data: 'Error: limit must be a positive integer.', is_error: true }
    }

    try {
      const fileStat = await stat(filePath)
      if (fileStat.isDirectory()) {
        return { data: `Error: ${filePath} is a directory, not a file. Use Bash with 'ls' to list directory contents.`, is_error: true }
      }

      // Check for binary/image files
      const ext = filePath.split('.').pop()?.toLowerCase()
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext || '')) {
        return `[Image file: ${filePath} (${fileStat.size} bytes)]`
      }

      const content = await readFile(filePath, 'utf-8')
      const lines = content.split('\n')

      const offset = input.offset || 0
      const limit = input.limit || 2000
      const selectedLines = lines.slice(offset, offset + limit)

      // Format with line numbers (cat -n style)
      const numbered = selectedLines.map((line: string, i: number) => {
        const lineNum = offset + i + 1
        return `${lineNum}\t${line}`
      }).join('\n')

      let result = numbered
      if (lines.length > offset + limit) {
        result += `\n\n(${lines.length - offset - limit} more lines not shown)`
      }

      return result || '(empty file)'
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { data: `Error: File not found: ${filePath}`, is_error: true }
      }
      return { data: `Error reading file: ${err.message}`, is_error: true }
    }
  },
})
