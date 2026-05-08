/**
 * v3.5 RAG (prototype) — public surface.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.5 section).
 * @module
 */

export type {
  EmbedFn,
  RagDocument,
  RetrievalHit,
  Retriever,
  RetrieveQuery,
} from './types.js'

export {
  InMemoryRetriever,
  cosine,
  type InMemoryRetrieverOptions,
} from './runtime.js'

export {
  PgvectorRetriever,
  type PgClientLike,
  type PgvectorRetrieverOptions,
} from './pgvector.js'
