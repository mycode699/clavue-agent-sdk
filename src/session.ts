/**
 * Session Storage & Management
 *
 * Persists conversation transcripts to disk for resumption.
 * Manages session lifecycle (create, resume, list, fork).
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import type { NormalizedMessageParam } from './providers/types.js'

/**
 * Session metadata.
 */
export interface SessionMetadata {
  id: string
  cwd: string
  model: string
  createdAt: string
  updatedAt: string
  messageCount: number
  summary?: string
}

/**
 * Session data on disk.
 */
export interface SessionData {
  metadata: SessionMetadata
  messages: NormalizedMessageParam[]
}

export interface SessionStoreOptions {
  dir?: string
}

/**
 * Get the sessions directory path.
 */
function getSessionsDir(options?: SessionStoreOptions): string {
  if (options?.dir) return options.dir
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  return join(home, '.clavue-agent-sdk', 'sessions')
}

/**
 * Get the path for a specific session.
 */
function getSessionPath(sessionId: string, options?: SessionStoreOptions): string {
  if (!sessionId || sessionId.includes('\0')) {
    throw new Error('Invalid session id')
  }

  const sessionsDir = resolve(getSessionsDir(options))
  const sessionPath = resolve(sessionsDir, sessionId)
  const pathFromStore = relative(sessionsDir, sessionPath)

  if (
    pathFromStore === '' ||
    pathFromStore.startsWith('..') ||
    isAbsolute(pathFromStore)
  ) {
    throw new Error('Invalid session id')
  }

  return sessionPath
}

/**
 * Save session to disk.
 */
export async function saveSession(
  sessionId: string,
  messages: NormalizedMessageParam[],
  metadata: Partial<SessionMetadata>,
  options?: SessionStoreOptions,
): Promise<void> {
  const dir = getSessionPath(sessionId, options)
  await mkdir(dir, { recursive: true })

  const data: SessionData = {
    metadata: {
      id: sessionId,
      cwd: metadata.cwd || process.cwd(),
      model: metadata.model || 'claude-sonnet-4-6',
      createdAt: metadata.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messageCount: messages.length,
      summary: metadata.summary,
    },
    messages,
  }

  await writeFile(
    join(dir, 'transcript.json'),
    JSON.stringify(data, null, 2),
    'utf-8',
  )
}

/**
 * Load session from disk.
 */
export async function loadSession(
  sessionId: string,
  options?: SessionStoreOptions,
): Promise<SessionData | null> {
  try {
    const filePath = join(getSessionPath(sessionId, options), 'transcript.json')
    const content = await readFile(filePath, 'utf-8')
    return JSON.parse(content) as SessionData
  } catch {
    return null
  }
}

/**
 * List all sessions.
 */
export async function listSessions(options?: SessionStoreOptions): Promise<SessionMetadata[]> {
  try {
    const dir = getSessionsDir(options)
    const entries = await readdir(dir)
    const sessions: SessionMetadata[] = []

    for (const entry of entries) {
      try {
        const data = await loadSession(entry, options)
        if (data?.metadata) {
          sessions.push(data.metadata)
        }
      } catch {
        // Skip invalid sessions
      }
    }

    // Sort by updatedAt descending
    sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))

    return sessions
  } catch {
    return []
  }
}

/**
 * Fork a session (create a copy with a new ID).
 */
export async function forkSession(
  sourceSessionId: string,
  newSessionId?: string,
  options?: SessionStoreOptions,
): Promise<string | null> {
  const data = await loadSession(sourceSessionId, options)
  if (!data) return null

  const forkId = newSessionId || crypto.randomUUID()

  await saveSession(
    forkId,
    data.messages,
    {
      ...data.metadata,
      id: forkId,
      createdAt: new Date().toISOString(),
      summary: `Forked from session ${sourceSessionId}`,
    },
    options,
  )

  return forkId
}

/**
 * Get session messages.
 */
export async function getSessionMessages(
  sessionId: string,
  options?: SessionStoreOptions,
): Promise<NormalizedMessageParam[]> {
  const data = await loadSession(sessionId, options)
  return data?.messages || []
}

/**
 * Append a message to a session transcript.
 */
export async function appendToSession(
  sessionId: string,
  message: NormalizedMessageParam,
  options?: SessionStoreOptions,
): Promise<void> {
  const data = await loadSession(sessionId, options)
  if (!data) return

  data.messages.push(message)
  data.metadata.updatedAt = new Date().toISOString()
  data.metadata.messageCount = data.messages.length

  await saveSession(sessionId, data.messages, data.metadata, options)
}

/**
 * Delete a session.
 */
export async function deleteSession(
  sessionId: string,
  options?: SessionStoreOptions,
): Promise<boolean> {
  try {
    const { rm } = await import('fs/promises')
    await rm(getSessionPath(sessionId, options), { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Get info about a specific session.
 */
export async function getSessionInfo(
  sessionId: string,
  options?: { dir?: string },
): Promise<SessionMetadata | null> {
  const data = await loadSession(sessionId, options)
  return data?.metadata || null
}

/**
 * Rename a session.
 */
export async function renameSession(
  sessionId: string,
  title: string,
  options?: { dir?: string },
): Promise<void> {
  const data = await loadSession(sessionId, options)
  if (!data) return

  data.metadata.summary = title
  data.metadata.updatedAt = new Date().toISOString()

  await saveSession(sessionId, data.messages, data.metadata, options)
}

/**
 * Tag a session.
 */
export async function tagSession(
  sessionId: string,
  tag: string | null,
  options?: { dir?: string },
): Promise<void> {
  const data = await loadSession(sessionId, options)
  if (!data) return

  ;(data.metadata as any).tag = tag
  data.metadata.updatedAt = new Date().toISOString()

  await saveSession(sessionId, data.messages, data.metadata, options)
}
