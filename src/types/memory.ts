/**
 * Memory and session storage configuration types.
 */

import type { EmbedderLike } from '../memory/embedder-adapter.js'

export type MemoryPolicyMode = 'off' | 'autoInject' | 'brainFirst'

/**
 * Retrieval strategy for memory lookups.
 *
 * - `'keyword'` (default): the original zero-dep keyword + tag + recency
 *   scorer. No embedder required.
 * - `'vector'`: pure cosine similarity against embeddings supplied by an
 *   `EmbedderLike`. Requires `embedder` in `MemoryConfig`.
 * - `'hybrid'`: union of keyword + vector scores, additive. Both strategies
 *   contribute; tuning happens by picking `limit`.
 */
export type MemoryRetrievalStrategy = 'keyword' | 'vector' | 'hybrid'

export interface MemoryPolicy {
  mode?: MemoryPolicyMode
}

export interface MemoryConfig {
  enabled?: boolean
  dir?: string
  autoInject?: boolean
  policy?: MemoryPolicy
  autoSaveSessionSummary?: boolean
  maxInjectedEntries?: number
  repoPath?: string
  /**
   * Retrieval strategy for `queryMemoryMatches` / `queryMemories`.
   * Defaults to `'keyword'` — the zero-dep legacy behavior.
   */
  retrieval?: MemoryRetrievalStrategy
  /**
   * Embedder adapter, required when `retrieval` is `'vector'` or `'hybrid'`.
   * Resolved lazily; callers using `'keyword'` never touch it.
   */
  embedder?: EmbedderLike
}

export interface SessionConfig {
  dir?: string
}
