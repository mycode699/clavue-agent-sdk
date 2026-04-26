/**
 * Git Worktree Tools
 *
 * EnterWorktree / ExitWorktree - Isolated git worktree environments
 * for parallel work without affecting the main working tree.
 */

import { execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { mkdirSync } from 'fs'
import { isAbsolute, join, relative, resolve } from 'path'
import type { ToolDefinition, ToolResult } from '../types.js'

// Track active worktrees
const activeWorktrees = new Map<string, { path: string; branch: string; originalCwd: string }>()

function runGit(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' })
}

function isSafeBranchName(branch: string): boolean {
  return /^(?!-)(?!.*\.\.)(?!.*[~^:?*\[\\])(?!.*(?:^|\/)\.)(?!.*\.lock$)[A-Za-z0-9._/-]+$/.test(branch) &&
    !branch.endsWith('/') &&
    !branch.endsWith('.')
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export const EnterWorktreeTool: ToolDefinition = {
  name: 'EnterWorktree',
  description: 'Create an isolated git worktree for parallel work. The agent will work in the worktree without affecting the main working tree.',
  inputSchema: {
    type: 'object',
    properties: {
      branch: { type: 'string', description: 'Branch name for the worktree (auto-generated if not provided)' },
      path: { type: 'string', description: 'Path for the worktree (auto-generated if not provided)' },
    },
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Create an isolated git worktree for parallel work.' },
  async call(input: any, context: { cwd: string }): Promise<ToolResult> {
    try {
      // Check if we're in a git repo
      runGit(['rev-parse', '--git-dir'], context.cwd)
      const repoRoot = runGit(['rev-parse', '--show-toplevel'], context.cwd).trim()

      const branch = input.branch || `worktree-${Date.now()}`
      if (!isSafeBranchName(branch)) {
        throw new Error(`Invalid branch name: ${branch}`)
      }
      const worktreeBase = join(repoRoot, '.clavue', 'worktrees')
      const worktreePath = input.path
        ? resolve(context.cwd, input.path)
        : join(worktreeBase, branch.replaceAll('/', '-'))
      if (!isPathInside(worktreeBase, worktreePath)) {
        throw new Error(`Worktree path must be inside ${worktreeBase}`)
      }
      mkdirSync(worktreeBase, { recursive: true })

      // Create the branch if it doesn't exist
      try {
        runGit(['branch', branch], context.cwd)
      } catch {
        // Branch might already exist
      }

      // Create worktree
      runGit(['worktree', 'add', worktreePath, branch], context.cwd)

      const id = randomUUID()
      activeWorktrees.set(id, {
        path: worktreePath,
        branch,
        originalCwd: context.cwd,
      })

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Worktree created:\n  ID: ${id}\n  Path: ${worktreePath}\n  Branch: ${branch}\n\nYou are now working in the isolated worktree.`,
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error creating worktree: ${err.message}`,
        is_error: true,
      }
    }
  },
}

export const ExitWorktreeTool: ToolDefinition = {
  name: 'ExitWorktree',
  description: 'Exit and optionally remove a git worktree. Use "keep" to preserve changes or "remove" to clean up.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Worktree ID' },
      action: {
        type: 'string',
        enum: ['keep', 'remove'],
        description: 'Whether to keep or remove the worktree (default: remove)',
      },
    },
    required: ['id'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Exit a git worktree.' },
  async call(input: any): Promise<ToolResult> {
    const worktree = activeWorktrees.get(input.id)
    if (!worktree) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Worktree not found: ${input.id}`,
        is_error: true,
      }
    }

    const action = input.action || 'remove'

    try {
      if (action === 'remove') {
        const status = runGit(['status', '--porcelain'], worktree.path).trim()
        if (status) {
          return {
            type: 'tool_result',
            tool_use_id: '',
            content: `Refusing to remove worktree with uncommitted changes: ${worktree.path}`,
            is_error: true,
          }
        }

        runGit(['worktree', 'remove', worktree.path], worktree.originalCwd)
        try {
          runGit(['branch', '-d', worktree.branch], worktree.originalCwd)
        } catch {
          // Keep branches that contain unmerged commits or are still referenced.
        }
      }

      activeWorktrees.delete(input.id)

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Worktree ${action === 'remove' ? 'removed' : 'kept'}: ${worktree.path}`,
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: ${err.message}`,
        is_error: true,
      }
    }
  },
}
