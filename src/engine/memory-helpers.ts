/**
 * Pure memory scoring/formatting helpers used by `QueryEngine` to render
 * injected memories into the system prompt and to materialize memory
 * selection traces. Extracted from `src/engine.ts` to shrink the god-class.
 */

import type {
  AgentRunMemorySelectionTrace,
} from '../types.js'
import type { MemoryEntry, MemoryQueryResult } from '../memory.js'

export function getMemoryPriority(memory: MemoryEntry): number {
  switch (memory.type) {
    case 'feedback':
      return 0
    case 'decision':
      return 1
    case 'improvement':
      return 2
    case 'project':
      return 3
    case 'reference':
      return 4
    case 'user':
      return 5
    default:
      return 6
  }
}

export function toMemoryScoreComponents(
  scoreReasons: string[],
): AgentRunMemorySelectionTrace['score_components'] {
  return scoreReasons.map((reason) => {
    if (reason === 'repo_path') return { reason, score: 6 }
    if (reason === 'session_id') return { reason, score: 4 }
    if (reason.startsWith('tag:')) return { reason, score: 3 }
    if (reason.startsWith('text:')) return { reason, score: 2 }
    return { reason, score: 1 }
  })
}

export function getMatchedMemoryFields(
  entry: MemoryEntry,
  queryText?: string,
): string[] {
  if (!queryText) return []

  const terms = queryText
    .toLowerCase()
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean)
  if (terms.length === 0) return []

  const fields: string[] = []
  const title = entry.title.toLowerCase()
  const content = entry.content.toLowerCase()
  const tags = (entry.tags || []).join(' ').toLowerCase()

  if (terms.some((term) => title.includes(term))) fields.push('title')
  if (terms.some((term) => content.includes(term))) fields.push('content')
  if (tags && terms.some((term) => tags.includes(term))) fields.push('tags')

  return fields
}

export function isStaleMemory(entry: MemoryEntry): boolean {
  if (!entry.lastValidatedAt) return false
  const validated = Date.parse(entry.lastValidatedAt)
  if (!Number.isFinite(validated)) return false
  const staleAfterMs = 30 * 24 * 60 * 60 * 1000
  return Date.now() - validated >= staleAfterMs
}

export function toMemorySelectionTrace(
  match: MemoryQueryResult,
  options: { includeRichFields?: boolean; queryText?: string } = {},
): AgentRunMemorySelectionTrace {
  const { entry, score, scoreReasons } = match
  const trace: AgentRunMemorySelectionTrace = {
    id: entry.id,
    type: entry.type,
    scope: entry.scope,
    title: entry.title,
    score,
    score_reasons: [...scoreReasons],
    validation_state: entry.lastValidatedAt ? 'validated' : 'unvalidated',
    tags: entry.tags ? [...entry.tags] : undefined,
    source: entry.source,
    confidence: entry.confidence,
    last_validated_at: entry.lastValidatedAt,
    repo_path: entry.repoPath,
    session_id: entry.sessionId,
  }

  if (options.includeRichFields) {
    trace.score_components = toMemoryScoreComponents(scoreReasons)
    trace.matched_fields = getMatchedMemoryFields(entry, options.queryText)
    trace.stale = isStaleMemory(entry)
    trace.redaction_status = 'not_required'
  }

  return trace
}

export function formatInjectedMemories(memories: MemoryEntry[]): string {
  const lines: string[] = []

  for (const memory of [...memories].sort(
    (a, b) => getMemoryPriority(a) - getMemoryPriority(b),
  )) {
    const metadata = [memory.type, memory.scope, memory.confidence]
      .filter(Boolean)
      .join(' / ')
    lines.push(`- ${memory.title}${metadata ? ` (${metadata})` : ''}`)
    lines.push(`  ${memory.content}`)
    if (memory.tags && memory.tags.length > 0) {
      lines.push(`  tags: ${memory.tags.join(', ')}`)
    }
  }

  return lines.join('\n')
}
