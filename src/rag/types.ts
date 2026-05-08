/**
 * v3.5 RAG — retriever types (prototype).
 *
 * Provider-agnostic retrieval interface. Hosts plug their own embedding
 * provider + vector store; the SDK only owns the contract.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.5 section).
 *
 * @module
 */

/** Document ingested into a retriever. */
export interface RagDocument {
  id: string
  text: string
  /** Free-form metadata stored verbatim. Used for filtering and citations. */
  metadata?: Record<string, unknown>
}

/** Query against a retriever. */
export interface RetrieveQuery {
  text: string
  /** Top-k results to return. Defaults to 5. */
  topK?: number
  /**
   * Optional metadata equality filter. Document must match every key/value
   * pair to be considered. Missing key on the document = no match.
   */
  where?: Record<string, unknown>
}

/** A single retrieval hit. Higher score = more relevant (cosine in [-1, 1]). */
export interface RetrievalHit {
  id: string
  text: string
  score: number
  metadata?: Record<string, unknown>
}

/**
 * The minimum surface every retriever must implement.
 *
 *   - `add()` and `clear()` are optional (read-only stores skip them).
 *   - `retrieve()` is mandatory.
 *   - `count()` is optional but recommended for diagnostics.
 */
export interface Retriever {
  retrieve(query: RetrieveQuery): Promise<RetrievalHit[]>
  add?(docs: RagDocument[]): Promise<void> | void
  clear?(): Promise<void> | void
  count?(): number
}

/**
 * Embedding function — text -> dense vector. Caller provides this; the
 * SDK does not bundle an embedding model.
 */
export type EmbedFn = (text: string) => Promise<number[]> | number[]
