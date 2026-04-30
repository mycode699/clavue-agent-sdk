import { mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'

export type MemoryType = 'user' | 'project' | 'reference' | 'feedback' | 'decision' | 'improvement'
export type MemoryScope = 'global' | 'repo' | 'session'
export type MemoryConfidence = 'low' | 'medium' | 'high'

export interface MemoryEntry {
  id: string
  type: MemoryType
  scope: MemoryScope
  title: string
  content: string
  tags?: string[]
  source?: string
  confidence?: MemoryConfidence
  repoPath?: string
  sessionId?: string
  createdAt: string
  updatedAt: string
  lastValidatedAt?: string
}

export interface MemoryStoreOptions {
  dir?: string
}

export interface MemoryQuery {
  type?: MemoryType | MemoryType[]
  scope?: MemoryScope | MemoryScope[]
  tags?: string[]
  repoPath?: string
  sessionId?: string
  text?: string
  limit?: number
}

export interface MemoryQueryResult {
  entry: MemoryEntry
  score: number
  scoreReasons: string[]
}

function getMemoryDir(options?: MemoryStoreOptions): string {
  if (options?.dir) return options.dir
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  return join(home, '.clavue-agent-sdk', 'memory')
}

function sanitizeMemoryId(id: string): string {
  if (!id || id.includes('..') || id.includes('/') || id.includes('\\')) {
    throw new Error(`Invalid memory id: ${id}`)
  }
  return id
}

function getMemoryPath(id: string, options?: MemoryStoreOptions): string {
  return join(getMemoryDir(options), `${sanitizeMemoryId(id)}.json`)
}

async function ensureMemoryDir(options?: MemoryStoreOptions): Promise<string> {
  const dir = getMemoryDir(options)
  await mkdir(dir, { recursive: true })
  return dir
}

function normalizeArray<T>(value?: T | T[]): T[] | undefined {
  if (value === undefined) return undefined
  return Array.isArray(value) ? value : [value]
}

function uniqueSorted(values?: string[]): string[] | undefined {
  if (!values || values.length === 0) return undefined
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort()
}

function scoreMemory(entry: MemoryEntry, query: MemoryQuery): { score: number; scoreReasons: string[] } {
  let score = 0
  const scoreReasons: string[] = []

  if (query.repoPath && entry.repoPath === query.repoPath) {
    score += 6
    scoreReasons.push('repo_path')
  }
  if (query.sessionId && entry.sessionId === query.sessionId) {
    score += 4
    scoreReasons.push('session_id')
  }

  const tags = new Set(entry.tags || [])
  for (const tag of query.tags || []) {
    if (tags.has(tag)) {
      score += 3
      scoreReasons.push(`tag:${tag}`)
    }
  }

  if (query.text) {
    const haystack = `${entry.title}\n${entry.content}\n${(entry.tags || []).join(' ')}`.toLowerCase()
    const terms = query.text
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean)

    for (const term of terms) {
      if (haystack.includes(term)) {
        score += 2
        scoreReasons.push(`text:${term}`)
      }
    }
  }

  if (entry.confidence === 'high') {
    score += 1
    scoreReasons.push('confidence:high')
  }
  if (entry.lastValidatedAt) {
    score += 1
    scoreReasons.push('validated')
  }

  return { score, scoreReasons }
}

function matchesMemory(entry: MemoryEntry, query: MemoryQuery): boolean {
  const types = normalizeArray(query.type)
  const scopes = normalizeArray(query.scope)

  if (types && !types.includes(entry.type)) return false
  if (scopes && !scopes.includes(entry.scope)) return false
  if (query.repoPath && entry.repoPath !== query.repoPath) return false
  if (query.sessionId && entry.sessionId !== query.sessionId) return false

  if (query.tags && query.tags.length > 0) {
    const tags = new Set(entry.tags || [])
    if (!query.tags.every((tag) => tags.has(tag))) return false
  }

  if (query.text) {
    const haystack = `${entry.title}\n${entry.content}\n${(entry.tags || []).join(' ')}`.toLowerCase()
    const terms = query.text
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean)

    if (!terms.some((term) => haystack.includes(term))) return false
  }

  return true
}

export async function saveMemory(
  input: Omit<MemoryEntry, 'createdAt' | 'updatedAt' | 'tags'> & { tags?: string[] },
  options?: MemoryStoreOptions,
): Promise<MemoryEntry> {
  await ensureMemoryDir(options)

  const now = new Date().toISOString()
  const existing = await loadMemory(input.id, options)
  const entry: MemoryEntry = {
    ...input,
    tags: uniqueSorted(input.tags),
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  }

  await writeFile(getMemoryPath(entry.id, options), JSON.stringify(entry, null, 2), 'utf-8')
  return entry
}

export async function loadMemory(
  id: string,
  options?: MemoryStoreOptions,
): Promise<MemoryEntry | null> {
  try {
    const content = await readFile(getMemoryPath(id, options), 'utf-8')
    return JSON.parse(content) as MemoryEntry
  } catch {
    return null
  }
}

export async function listMemories(options?: MemoryStoreOptions): Promise<MemoryEntry[]> {
  try {
    const dir = await ensureMemoryDir(options)
    const entries = await readdir(dir)
    const memories = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => {
          try {
            const content = await readFile(join(dir, entry), 'utf-8')
            return JSON.parse(content) as MemoryEntry
          } catch {
            return null
          }
        }),
    )

    return memories
      .filter((entry): entry is MemoryEntry => entry !== null)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

export async function queryMemoryMatches(
  query: MemoryQuery,
  options?: MemoryStoreOptions,
): Promise<MemoryQueryResult[]> {
  const limit = query.limit ?? 10
  const memories = await listMemories(options)

  return memories
    .filter((entry) => matchesMemory(entry, query))
    .map((entry) => {
      const { score, scoreReasons } = scoreMemory(entry, query)
      return { entry, score, scoreReasons }
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.entry.updatedAt.localeCompare(a.entry.updatedAt)
    })
    .slice(0, limit)
}

export async function queryMemories(
  query: MemoryQuery,
  options?: MemoryStoreOptions,
): Promise<MemoryEntry[]> {
  const matches = await queryMemoryMatches(query, options)
  return matches.map(({ entry }) => entry)
}

export async function deleteMemory(id: string, options?: MemoryStoreOptions): Promise<boolean> {
  try {
    await rm(getMemoryPath(id, options), { force: true })
    return true
  } catch {
    return false
  }
}

export async function getMemoryStoreInfo(options?: MemoryStoreOptions): Promise<{
  dir: string
  count: number
}> {
  const dir = await ensureMemoryDir(options)
  const memories = await listMemories(options)
  return { dir, count: memories.length }
}
