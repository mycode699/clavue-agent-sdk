/**
 * System & User Context
 *
 * Builds context for the system prompt:
 * - Git status injection (branch, commits, status)
 * - AGENT.md / project context discovery and injection
 * - Working directory info
 * - Date injection
 */

import { execFileSync } from 'child_process'
import { readFile, realpath, stat } from 'fs/promises'
import { basename, dirname, join } from 'path'
import type { ContextPack, ContextPackOptions, ContextPipeline, ContextPipelineTransform } from '../types.js'

// Memoization cache
let cachedGitStatus: string | null = null
let cachedGitStatusCwd: string | null = null

/**
 * Get git status info for system prompt.
 * Memoized per cwd (cleared on new session).
 */
export async function getGitStatus(cwd: string): Promise<string> {
  if (cachedGitStatus && cachedGitStatusCwd === cwd) {
    return cachedGitStatus
  }

  try {
    const parts: string[] = []

    const gitExec = (args: string[], timeoutMs = 5000): string | null => {
      try {
        return execFileSync('git', args, {
          cwd, timeout: timeoutMs, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
        }).trim()
      } catch {
        return null
      }
    }

    // Check if this is a git repo at all
    if (!gitExec(['rev-parse', '--git-dir'])) return ''

    // Current branch
    const branch = gitExec(['rev-parse', '--abbrev-ref', 'HEAD'])
    if (branch) parts.push(`Current branch: ${branch}`)

    // Main branch detection
    const mainBranch = detectMainBranch(cwd)
    if (mainBranch) parts.push(`Main branch: ${mainBranch}`)

    // Git user
    const user = gitExec(['config', 'user.name'], 3000)
    if (user) parts.push(`Git user: ${user}`)

    // Status (staged + unstaged)
    const status = gitExec(['status', '--short'])
    if (status) {
      const truncated = status.length > 2000
        ? status.slice(0, 2000) + '\n...(truncated)'
        : status
      parts.push(`Status:\n${truncated}`)
    }

    // Recent commits (only if HEAD exists)
    const hasHead = gitExec(['rev-parse', 'HEAD'])
    if (hasHead) {
      const log = gitExec(['log', '--oneline', '-5', '--no-decorate'])
      if (log) parts.push(`Recent commits:\n${log}`)
    }

    cachedGitStatus = parts.join('\n\n')
    cachedGitStatusCwd = cwd

    return cachedGitStatus
  } catch {
    return ''
  }
}

/**
 * Detect the main branch name (main or master).
 */
function detectMainBranch(cwd: string): string | null {
  try {
    const branches = execFileSync('git', ['branch', '-l', 'main', 'master'], {
      cwd, timeout: 3000, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim()
    if (branches.includes('main')) return 'main'
    if (branches.includes('master')) return 'master'
    return null
  } catch {
    return null
  }
}

/**
 * Discover project context files (AGENT.md, CLAVUE.md) in the project.
 */
export async function discoverProjectContextFiles(cwd: string, options: Pick<ContextPackOptions, 'includeUser'> = {}): Promise<string[]> {
  const candidates = [
    join(cwd, 'AGENT.md'),
    join(cwd, 'CLAVUE.md'),
    join(cwd, '.clavue', 'CLAVUE.md'),
    join(cwd, 'clavue.md'),
  ]

  // Also check home directory
  const includeUser = options.includeUser ?? true
  const home = process.env.HOME || process.env.USERPROFILE || ''
  if (includeUser && home) {
    candidates.push(
      join(home, '.clavue', 'CLAVUE.md'),
    )
  }

  const found: string[] = []
  const seen = new Set<string>()
  for (const path of candidates) {
    try {
      const s = await stat(path)
      if (!s.isFile()) continue

      const canonical = await realpath(path)
      const key = canonical.toLocaleLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        found.push(join(dirname(path), basename(canonical)))
      }
    } catch {
      // File doesn't exist
    }
  }

  return found
}

/**
 * Read project context file content from discovered files.
 */
export async function readProjectContextContent(cwd: string): Promise<string> {
  const files = await discoverProjectContextFiles(cwd)
  if (files.length === 0) return ''

  const parts: string[] = []
  for (const file of files) {
    try {
      const content = await readFile(file, 'utf-8')
      if (content.trim()) {
        parts.push(`# From ${file}:\n${content.trim()}`)
      }
    } catch {
      // Skip unreadable files
    }
  }

  return parts.join('\n\n')
}

export async function buildContextPack(cwd: string, options: ContextPackOptions = {}): Promise<ContextPack> {
  const includeDate = options.includeDate ?? true
  const includeGit = options.includeGit ?? true
  const includeProject = options.includeProject ?? true
  const now = options.now ?? new Date()
  const sections: ContextPack['sections'] = []

  if (includeDate) {
    sections.push({
      kind: 'date',
      title: 'currentDate',
      content: `Today's date is ${now.toISOString().split('T')[0]}.`,
    })
  }

  if (includeGit) {
    const gitStatus = await getGitStatus(cwd)
    if (gitStatus) {
      sections.push({ kind: 'git', title: 'gitStatus', content: gitStatus })
    }
  }

  if (includeProject) {
    const files = await discoverProjectContextFiles(cwd, { includeUser: options.includeUser })
    for (const file of files) {
      try {
        const content = (await readFile(file, 'utf-8')).trim()
        if (content) {
          sections.push({ kind: 'project', title: basename(file), source: file, content })
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return { cwd, created_at: now.toISOString(), sections }
}

export function renderContextPack(pack: ContextPack): string {
  return pack.sections
    .filter((section) => section.content.trim())
    .map((section) => `# ${section.title}\n${section.content.trim()}`)
    .join('\n\n')
}

export function createContextPipeline(transforms: ContextPipelineTransform[] = []): ContextPipeline {
  return {
    use(transform: ContextPipelineTransform): ContextPipeline {
      return createContextPipeline([...transforms, transform])
    },
    async run(cwd: string, options: ContextPackOptions = {}): Promise<ContextPack> {
      let pack = await buildContextPack(cwd, options)
      for (const transform of transforms) {
        pack = await transform(pack)
      }
      return pack
    },
  }
}

/**
 * Get system context for the system prompt.
 */
export async function getSystemContext(cwd: string): Promise<string> {
  const pack = await buildContextPack(cwd, { includeDate: false, includeProject: false })
  return pack.sections
    .filter((section) => section.kind === 'git')
    .map((section) => `${section.title}: ${section.content}`)
    .join('\n\n')
}

/**
 * Get user context (AGENT.md, date, etc).
 */
export async function getUserContext(cwd: string): Promise<string> {
  const pack = await buildContextPack(cwd, { includeGit: false })
  return renderContextPack(pack)
}

/**
 * Clear memoized context (call between sessions).
 */
export function clearContextCache(): void {
  cachedGitStatus = null
  cachedGitStatusCwd = null
}
