/**
 * FileEditTool - Precise string replacement in files
 */

import { readFile, stat, writeFile } from 'fs/promises'
import { defineTool } from './types.js'
import { resolveWorkspacePath } from './workspace.js'

export const FileEditTool = defineTool({
  name: 'Edit',
  description: 'Perform exact string replacements in files. The old_string must match exactly (including whitespace and indentation). Use replace_all to change every occurrence.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The absolute path to the file to modify',
      },
      old_string: {
        type: 'string',
        description: 'The exact text to find and replace',
      },
      new_string: {
        type: 'string',
        description: 'The replacement text',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences (default false)',
      },
    },
    required: ['file_path', 'old_string', 'new_string'],
  },
  safety: {
    read: true,
    write: true,
    destructive: true,
    approvalRequired: true,
  },
  isReadOnly: false,
  isConcurrencySafe: false,
  async call(input, context) {
    const filePath = resolveWorkspacePath(context, input.file_path)
    if (typeof filePath !== 'string') return filePath
    const { old_string, new_string, replace_all } = input

    if (old_string === new_string) {
      return { data: 'Error: old_string and new_string are identical', is_error: true }
    }

    try {
      // Slice I: if a cache entry exists for this path, verify the file
      // hasn't been modified out-of-band since the last Read. A stale
      // cache entry signals the agent should re-Read before editing.
      if (context.fileStateCache) {
        const cached = context.fileStateCache.get(filePath)
        if (cached) {
          try {
            const fileStat = await stat(filePath)
            if (fileStat.mtimeMs > cached.timestamp) {
              return {
                data: `Error: ${filePath} has been modified since it was last read. Re-read the file before editing.`,
                is_error: true,
              }
            }
          } catch {
            // If stat fails, fall through to readFile which will surface a clearer error.
          }
        }
      }

      let content = await readFile(filePath, 'utf-8')

      if (!content.includes(old_string)) {
        return { data: `Error: old_string not found in ${filePath}. Make sure it matches exactly including whitespace.`, is_error: true }
      }

      if (!replace_all) {
        // Check uniqueness
        const count = content.split(old_string).length - 1
        if (count > 1) {
          return {
            data: `Error: old_string appears ${count} times in the file. Provide more context to make it unique, or set replace_all: true.`,
            is_error: true,
          }
        }
        content = content.replace(old_string, new_string)
      } else {
        content = content.split(old_string).join(new_string)
      }

      await writeFile(filePath, content, 'utf-8')

      // Refresh cache so subsequent Edits see our own write as the new baseline.
      if (context.fileStateCache) {
        try {
          const newStat = await stat(filePath)
          context.fileStateCache.set(filePath, {
            content,
            timestamp: newStat.mtimeMs,
          })
        } catch {
          // Best-effort refresh — leave the stale entry rather than fail the edit.
        }
      }

      return `File edited: ${filePath}`
    } catch (err: any) {
      if (err.code === 'ENOENT') {
        return { data: `Error: File not found: ${filePath}`, is_error: true }
      }
      return { data: `Error editing file: ${err.message}`, is_error: true }
    }
  },
})
