import { createHash } from 'node:crypto'

import { saveMemory, type MemoryEntry, type MemoryStoreOptions } from './memory.js'
import type { Message } from './types.js'

export interface SessionMemoryExtractionOptions {
  repoPath?: string
  sessionId?: string
}

export type ExtractedMemoryCandidate = Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>

function splitIntoCandidates(text: string): string[] {
  return text
    .split(/\r?\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+/))
    .map((line) => line.trim())
    .map((line) => line.replace(/^[-*]\s*/, ''))
    .map((line) => line.replace(/^remember that\s+/i, ''))
    .map((line) => line.replace(/^please\s+/i, ''))
    .map((line) => line.replace(/\s+/g, ' '))
    .filter((line) => line.length >= 20 && line.length <= 280)
}

function buildTags(text: string, type: 'feedback' | 'decision'): string[] {
  const lower = text.toLowerCase()
  const tags = new Set<string>([type, 'auto'])

  if (/\bworkflow\b|\bcontinue\b|\bkeep moving\b/.test(lower)) tags.add('workflow')
  if (/\bconfirm/.test(lower)) tags.add('confirmations')
  if (/\bconcise\b|\bbrief\b|\bshort\b/.test(lower)) tags.add('concise')
  if (/\bdestructive\b/.test(lower)) tags.add('destructive-actions')
  if (/\bprovider\b/.test(lower)) tags.add('provider')
  if (/\bopenai\b|\bgpt\b/.test(lower)) tags.add('openai')
  if (/\banthropic\b|\bclaude\b/.test(lower)) tags.add('anthropic')
  if (/\brepo\b|\bproject\b|\bsdk\b/.test(lower)) tags.add('project')

  return [...tags].sort()
}

function buildTitle(text: string, type: 'feedback' | 'decision'): string {
  const lower = text.toLowerCase()

  if (type === 'feedback') {
    if (/\bconcise\b|\bbrief\b|\bshort\b/.test(lower)) return 'Prefer concise responses'
    if (/\bconfirm/.test(lower)) return 'Minimize confirmation prompts'
    if (/\bkeep moving\b|\bdefault to\b/.test(lower)) return 'Default to continuous execution'
    return `Feedback: ${text.slice(0, 56)}${text.length > 56 ? '…' : ''}`
  }

  if (/\bopenai\b/.test(lower) && /\banthropic\b|\bclaude\b/.test(lower)) {
    return 'Use OpenAI-compatible provider'
  }
  if (/\bprovider\b/.test(lower)) return 'Provider selection decision'
  return `Decision: ${text.slice(0, 56)}${text.length > 56 ? '…' : ''}`
}

function classifyCandidate(text: string): {
  type: 'feedback' | 'decision'
  confidence: 'medium' | 'high'
} | null {
  const lower = text.toLowerCase()

  const decisionLead = /^(?:for this repo,?\s*)?(?:use|choose|go with|stick with|standardize on|switch to|adopt)\b/i.test(text)
  const decisionComparison = /\b(?:instead of|rather than|over)\b/.test(lower)
  const decisionCommitment = /\b(?:we are using|we're using|we will use|we should use|let's use)\b/.test(lower)
  if (decisionLead || decisionComparison || decisionCommitment) {
    return {
      type: 'decision',
      confidence: decisionComparison || decisionCommitment ? 'high' : 'medium',
    }
  }

  const feedbackSignals = [
    /\bprefer\b/,
    /\bdefault to\b/,
    /\b(?:don't|do not|avoid|never)\b/,
    /\bonly\s+(?:stop|ask|pause)\b/,
    /\bkeep\b.*\b(?:concise|brief|short|moving)\b/,
    /\bminimi[sz]e\b/,
  ]

  if (feedbackSignals.some((pattern) => pattern.test(lower))) {
    return {
      type: 'feedback',
      confidence: /\bprefer\b|\bdefault to\b|\bdo not\b|\bdon't\b|\bnever\b/.test(lower)
        ? 'high'
        : 'medium',
    }
  }

  return null
}

function dedupeKey(candidate: ExtractedMemoryCandidate): string {
  return [candidate.type, candidate.scope, candidate.repoPath || '', candidate.content.toLowerCase()].join('\n')
}

function buildMemoryId(candidate: ExtractedMemoryCandidate): string {
  const hash = createHash('sha1')
    .update(dedupeKey(candidate))
    .digest('hex')
    .slice(0, 16)
  return `auto-${candidate.scope}-${candidate.type}-${hash}`
}

export function extractSessionMemoryCandidates(
  messages: Message[],
  options: SessionMemoryExtractionOptions,
): ExtractedMemoryCandidate[] {
  const repoPath = options.repoPath
  const sessionId = options.sessionId
  const candidates = new Map<string, ExtractedMemoryCandidate>()

  for (const message of messages) {
    if (message.type !== 'user') continue
    if (typeof message.message.content !== 'string') continue

    for (const text of splitIntoCandidates(message.message.content)) {
      const classification = classifyCandidate(text)
      if (!classification) continue

      const candidate: ExtractedMemoryCandidate = {
        type: classification.type,
        scope: 'repo',
        title: buildTitle(text, classification.type),
        content: text,
        tags: buildTags(text, classification.type),
        confidence: classification.confidence,
        repoPath,
        sessionId,
        source: 'auto-extracted from session user messages',
      }

      candidates.set(dedupeKey(candidate), candidate)
    }
  }

  return [...candidates.values()]
}

export async function persistSessionMemoryCandidates(
  messages: Message[],
  options: SessionMemoryExtractionOptions,
  storeOptions?: MemoryStoreOptions,
): Promise<MemoryEntry[]> {
  const candidates = extractSessionMemoryCandidates(messages, options)

  return Promise.all(
    candidates.map((candidate) =>
      saveMemory(
        {
          id: buildMemoryId(candidate),
          ...candidate,
        },
        storeOptions,
      ),
    ),
  )
}
