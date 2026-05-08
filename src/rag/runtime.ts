/**
 * v3.5 RAG — in-memory reference retriever (prototype).
 *
 * Pure-JS cosine similarity store. Good for:
 *   - examples / tests / demos
 *   - < 10k docs
 *   - local dev before wiring a real vector DB
 *
 * Not good for production-scale retrieval. Swap in pgvector / Qdrant /
 * Pinecone / Weaviate behind the same `Retriever` interface.
 *
 * @module
 */

import type {
  EmbedFn,
  RagDocument,
  RetrievalHit,
  Retriever,
  RetrieveQuery,
} from './types.js'

interface StoredDoc {
  id: string
  text: string
  vector: number[]
  metadata?: Record<string, unknown>
}

export interface InMemoryRetrieverOptions {
  embed: EmbedFn
  /**
   * If true (default), `add()` with a duplicate id overwrites the prior
   * entry. If false, duplicates throw.
   */
  upsert?: boolean
}

export class InMemoryRetriever implements Retriever {
  private docs = new Map<string, StoredDoc>()
  private embed: EmbedFn
  private upsert: boolean

  constructor(options: InMemoryRetrieverOptions) {
    if (typeof options.embed !== 'function') {
      throw new Error('InMemoryRetriever: options.embed must be a function')
    }
    this.embed = options.embed
    this.upsert = options.upsert !== false
  }

  async add(documents: RagDocument[]): Promise<void> {
    for (const doc of documents) {
      if (!doc.id || typeof doc.id !== 'string') {
        throw new Error('add: every document must have a non-empty string id')
      }
      if (typeof doc.text !== 'string') {
        throw new Error(`add: document "${doc.id}" has non-string text`)
      }
      if (!this.upsert && this.docs.has(doc.id)) {
        throw new Error(`add: duplicate id "${doc.id}"`)
      }
      const vector = await this.embed(doc.text)
      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error(`add: embed("${doc.id}") returned an invalid vector`)
      }
      this.docs.set(doc.id, {
        id: doc.id,
        text: doc.text,
        vector: vector.slice(),
        ...(doc.metadata !== undefined ? { metadata: { ...doc.metadata } } : {}),
      })
    }
  }

  clear(): void {
    this.docs.clear()
  }

  count(): number {
    return this.docs.size
  }

  async retrieve(query: RetrieveQuery): Promise<RetrievalHit[]> {
    if (!query || typeof query.text !== 'string') {
      throw new Error('retrieve: query.text required')
    }
    const topK = query.topK ?? 5
    if (topK <= 0) return []
    if (this.docs.size === 0) return []

    const qvec = await this.embed(query.text)
    if (!Array.isArray(qvec) || qvec.length === 0) {
      throw new Error('retrieve: embed(query) returned an invalid vector')
    }

    const where = query.where
    const scored: RetrievalHit[] = []
    for (const d of this.docs.values()) {
      if (where && !matchesWhere(d.metadata, where)) continue
      const score = cosine(qvec, d.vector)
      scored.push({
        id: d.id,
        text: d.text,
        score,
        ...(d.metadata !== undefined ? { metadata: { ...d.metadata } } : {}),
      })
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, topK)
  }
}

function matchesWhere(
  meta: Record<string, unknown> | undefined,
  where: Record<string, unknown>,
): boolean {
  if (!meta) return false
  for (const [k, v] of Object.entries(where)) {
    if (meta[k] !== v) return false
  }
  return true
}

/**
 * Cosine similarity. Returns 0 when either vector is the zero vector
 * (instead of NaN) so sort order is well-defined.
 */
export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  let aa = 0
  let bb = 0
  for (let i = 0; i < n; i += 1) {
    const ai = a[i]!
    const bi = b[i]!
    dot += ai * bi
    aa += ai * ai
    bb += bi * bi
  }
  if (aa === 0 || bb === 0) return 0
  return dot / (Math.sqrt(aa) * Math.sqrt(bb))
}
