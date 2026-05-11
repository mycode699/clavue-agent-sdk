/**
 * Memory consolidation — Tier A #8.
 *
 * Over time the structured memory store accumulates duplicates and
 * near-duplicates: two `feedback` entries that say almost the same thing,
 * a `project` note rewritten with slightly different wording, etc.
 * Duplicates inflate retrieval noise (top-K fills with redundant hits) and
 * waste prompt-injection budget.
 *
 * This module is opt-in (host calls `consolidateMemories()` explicitly,
 * e.g. on session boundary or via a maintenance task). The default read /
 * write paths are untouched.
 *
 * Strategy:
 * - Group entries by an "identity key" — same `type`, same `scope`, same
 *   normalized `title`, same `repoPath` (when present), same `sessionId`
 *   (when present). Anything that differs across these axes is a separate
 *   memory and must NOT be merged.
 * - Within a cluster of size ≥ 2, optionally apply an embedder cosine
 *   threshold to drop merges that are titularly the same but content-wise
 *   different (rare, but a fail-open guard for short generic titles).
 * - Merge the cluster into a single canonical entry: keep the most
 *   recently updated entry as the base, union tags, take max confidence,
 *   take the freshest `lastValidatedAt`, append unique non-redundant
 *   content lines from the other entries.
 * - Persist the canonical entry; delete the others.
 *
 * Returns a structured report so the host can show "merged X duplicates
 * across Y groups" or feed it into telemetry. Dry-run mode (`apply: false`)
 * returns the same report without touching disk.
 */

import { writeFile } from 'fs/promises'
import { join } from 'path'

import {
  deleteMemory,
  invalidateMemoryCache,
  listMemories,
  type MemoryConfidence,
  type MemoryEntry,
  type MemoryStoreOptions,
} from '../memory.js'
import { cosineSimilarity, type EmbedderLike } from './embedder-adapter.js'

export interface ConsolidateMemoriesOptions extends MemoryStoreOptions {
  /**
   * If false (default = true), only return the report without writing to
   * disk. Useful for previewing what would be merged.
   */
  apply?: boolean
  /**
   * Optional embedder. When provided, cluster members below
   * `similarityThreshold` cosine are split back out as singletons
   * (i.e. NOT merged). Without an embedder, identity-key matches alone
   * drive the merge decision.
   */
  embedder?: EmbedderLike
  /**
   * Cosine threshold for embedder-guarded merges. Defaults to 0.85.
   * Ignored when `embedder` is absent.
   */
  similarityThreshold?: number
}

export interface ConsolidationMergedGroup {
  /** Canonical entry id that remains after the merge. */
  kept_id: string
  /** Ids that were merged into the canonical entry and deleted. */
  removed_ids: string[]
  /** The identity key the cluster shared. */
  identity: {
    type: MemoryEntry['type']
    scope: MemoryEntry['scope']
    title: string
    repo_path?: string
    session_id?: string
  }
}

export interface ConsolidateMemoriesReport {
  /** Total number of memories considered. */
  scanned: number
  /** Number of clusters of size ≥ 2 found. */
  duplicate_groups: number
  /** Total entries removed across all merges (= sum of removed_ids). */
  removed: number
  /** Per-group merge details. */
  groups: ConsolidationMergedGroup[]
  /** Whether `apply: false` was set (no disk writes). */
  dry_run: boolean
}

/**
 * Public preview helper — returns clusters of size ≥ 2 without touching
 * disk. Equivalent to `consolidateMemories({ apply: false })` but typed to
 * make the read-only intent explicit.
 */
export async function findDuplicateMemories(
  options?: ConsolidateMemoriesOptions,
): Promise<ConsolidateMemoriesReport> {
  return consolidateMemories({ ...options, apply: false })
}

export async function consolidateMemories(
  options?: ConsolidateMemoriesOptions,
): Promise<ConsolidateMemoriesReport> {
  const apply = options?.apply !== false
  const embedder = options?.embedder
  const threshold = options?.similarityThreshold ?? 0.85

  const all = await listMemories(options)
  const clusters = groupByIdentity(all)

  const groups: ConsolidationMergedGroup[] = []
  let removed = 0

  for (const cluster of clusters) {
    if (cluster.length < 2) continue

    // Optional embedder gate: split clusters whose members fall below the
    // similarity threshold against the canonical (most-recent) entry.
    const filtered = embedder
      ? await filterByEmbedderSimilarity(cluster, embedder, threshold)
      : cluster

    if (filtered.length < 2) continue

    const canonical = mergeCluster(filtered)
    const removedIds = filtered.filter((e) => e.id !== canonical.id).map((e) => e.id)

    groups.push({
      kept_id: canonical.id,
      removed_ids: removedIds,
      identity: {
        type: canonical.type,
        scope: canonical.scope,
        title: canonical.title,
        repo_path: canonical.repoPath,
        session_id: canonical.sessionId,
      },
    })
    removed += removedIds.length

    if (apply) {
      // Save the canonical entry first so we never end up with zero copies
      // of the data if the deletes fail mid-way. We bypass `saveMemory`
      // here because it always inherits the existing `createdAt` for the
      // given id — but cluster merges need to retain the *earliest*
      // createdAt across the cluster, which may come from one of the
      // other entries.
      const finalEntry: MemoryEntry = {
        ...canonical,
        updatedAt: new Date().toISOString(),
      }
      const dir = options?.dir ?? defaultMemoryDir()
      await writeFile(
        join(dir, `${canonical.id}.json`),
        JSON.stringify(finalEntry, null, 2),
        'utf-8',
      )
      invalidateMemoryCache(dir)
      await Promise.all(removedIds.map((id) => deleteMemory(id, options)))
    }
  }

  return {
    scanned: all.length,
    duplicate_groups: groups.length,
    removed,
    groups,
    dry_run: !apply,
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function defaultMemoryDir(): string {
  // Mirrors `getMemoryDir` in `../memory.ts`. Kept private here to avoid
  // exporting that helper; consolidation is the only path that needs to
  // bypass `saveMemory()` and write directly.
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  return join(home, '.clavue-agent-sdk', 'memory')
}

function identityKey(entry: MemoryEntry): string {
  // Title is normalized to absorb trivial whitespace / case differences.
  // repoPath / sessionId go in raw — empty strings are preserved as a
  // distinct bucket so untagged memories don't merge into repo-tagged ones.
  const title = entry.title.trim().toLowerCase().replace(/\s+/g, ' ')
  return [
    entry.type,
    entry.scope,
    title,
    entry.repoPath ?? '',
    entry.sessionId ?? '',
  ].join('\u0001')
}

function groupByIdentity(entries: MemoryEntry[]): MemoryEntry[][] {
  const buckets = new Map<string, MemoryEntry[]>()
  for (const entry of entries) {
    const key = identityKey(entry)
    const bucket = buckets.get(key)
    if (bucket) {
      bucket.push(entry)
    } else {
      buckets.set(key, [entry])
    }
  }
  return [...buckets.values()]
}

const CONFIDENCE_RANK: Record<MemoryConfidence, number> = {
  low: 1,
  medium: 2,
  high: 3,
}

function pickHigherConfidence(
  a: MemoryConfidence | undefined,
  b: MemoryConfidence | undefined,
): MemoryConfidence | undefined {
  if (!a) return b
  if (!b) return a
  return CONFIDENCE_RANK[a] >= CONFIDENCE_RANK[b] ? a : b
}

function mergeCluster(cluster: MemoryEntry[]): MemoryEntry {
  // Sort newest-first so the canonical entry inherits the most recent state.
  const sorted = [...cluster].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const canonical = { ...sorted[0]! }
  const others = sorted.slice(1)

  // createdAt: keep the earliest across the cluster so audit history isn't
  // pulled forward on every merge.
  let earliestCreatedAt = canonical.createdAt
  for (const other of others) {
    if (other.createdAt.localeCompare(earliestCreatedAt) < 0) {
      earliestCreatedAt = other.createdAt
    }
  }
  canonical.createdAt = earliestCreatedAt

  // Tags: union, deduplicated, sorted (matches saveMemory's normalization).
  const tagSet = new Set<string>()
  for (const e of sorted) for (const t of e.tags || []) tagSet.add(t)
  canonical.tags = tagSet.size > 0 ? [...tagSet].sort() : undefined

  // Confidence: max-rank wins.
  let conf: MemoryConfidence | undefined = canonical.confidence
  for (const other of others) conf = pickHigherConfidence(conf, other.confidence)
  canonical.confidence = conf

  // lastValidatedAt: freshest wins.
  let validated = canonical.lastValidatedAt
  for (const other of others) {
    if (other.lastValidatedAt && (!validated || other.lastValidatedAt.localeCompare(validated) > 0)) {
      validated = other.lastValidatedAt
    }
  }
  canonical.lastValidatedAt = validated

  // Content: keep canonical body, then append any line from another entry
  // that is non-empty and not already present (case-insensitive). Preserves
  // information that was only in the older copies (e.g. a `Why:` line that
  // got lost in a rewrite).
  const seenLines = new Set<string>()
  const canonicalLines = canonical.content.split('\n')
  for (const line of canonicalLines) seenLines.add(line.trim().toLowerCase())
  const appended: string[] = []
  for (const other of others) {
    for (const rawLine of other.content.split('\n')) {
      const norm = rawLine.trim().toLowerCase()
      if (!norm) continue
      if (seenLines.has(norm)) continue
      seenLines.add(norm)
      appended.push(rawLine)
    }
  }
  if (appended.length > 0) {
    canonical.content = `${canonical.content}\n\n${appended.join('\n')}`.trimEnd()
  }

  return canonical
}

async function filterByEmbedderSimilarity(
  cluster: MemoryEntry[],
  embedder: EmbedderLike,
  threshold: number,
): Promise<MemoryEntry[]> {
  // Sort newest-first; keep the canonical and only retain other entries
  // whose cosine similarity to it is ≥ threshold.
  const sorted = [...cluster].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const head = sorted[0]!
  let headVec: number[]
  try {
    headVec = await embedder.embed(`${head.title}\n${head.content}`)
  } catch {
    return cluster // fail-open: keep the cluster intact
  }

  const out: MemoryEntry[] = [head]
  for (const other of sorted.slice(1)) {
    try {
      const otherVec = await embedder.embed(`${other.title}\n${other.content}`)
      const sim = cosineSimilarity(headVec, otherVec)
      if (sim >= threshold) out.push(other)
    } catch {
      // fail-open per entry: skip this one rather than aborting the merge
    }
  }
  return out
}
