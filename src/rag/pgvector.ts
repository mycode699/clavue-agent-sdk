/**
 * v3.5 RAG — pgvector adapter.
 *
 * Production-grade `Retriever` backed by Postgres + the
 * [`pgvector`](https://github.com/pgvector/pgvector) extension. The SDK
 * does not depend on `pg`; hosts pass any client matching `PgClientLike`
 * (the official `pg.Client`/`pg.Pool` shape works as-is).
 *
 * Schema (idempotent, host runs once):
 *
 *   CREATE EXTENSION IF NOT EXISTS vector;
 *   CREATE TABLE IF NOT EXISTS clavue_rag (
 *     id        text PRIMARY KEY,
 *     text      text NOT NULL,
 *     embedding vector(:dim) NOT NULL,
 *     metadata  jsonb NOT NULL DEFAULT '{}'::jsonb
 *   );
 *   CREATE INDEX IF NOT EXISTS clavue_rag_embedding_idx
 *     ON clavue_rag USING ivfflat (embedding vector_cosine_ops);
 *
 * Cosine distance via the `<=>` operator, converted to similarity in
 * `[-1, 1]` so callers can mix pg hits with `InMemoryRetriever` hits
 * without translating scores.
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

/**
 * Minimal `pg.Client`-shaped surface. Both `pg.Client` and `pg.Pool`
 * already implement this; hosts can also wrap any other Postgres driver.
 */
export interface PgClientLike {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: unknown[] }>
}

export interface PgvectorRetrieverOptions {
  client: PgClientLike
  embed: EmbedFn
  /** Defaults to `clavue_rag`. */
  table?: string
}

/**
 * Convert a JS number[] into pgvector's text literal: `[0.1,0.2,0.3]`.
 * Pgvector parses this from a `text`/`vector` cast on the wire, which keeps
 * the adapter driver-agnostic (no special binary protocol needed).
 */
function toVectorLiteral(v: number[]): string {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error('pgvector: embedding must be a non-empty number[]')
  }
  // Use Number.isFinite so NaN/Infinity are caught early. Postgres would
  // reject them, but the error is clearer here.
  for (let i = 0; i < v.length; i += 1) {
    if (!Number.isFinite(v[i])) {
      throw new Error(`pgvector: embedding[${i}] is not finite`)
    }
  }
  return `[${v.join(',')}]`
}

/**
 * pgvector-backed Retriever. Inherits semantics from `InMemoryRetriever`:
 *   - `score` is cosine *similarity* in `[-1, 1]` (1 = identical).
 *   - `where` is an equality filter on `metadata` (JSONB `@>` containment).
 *   - empty store / empty topK → `[]`.
 */
export class PgvectorRetriever implements Retriever {
  private client: PgClientLike
  private embed: EmbedFn
  private table: string

  constructor(options: PgvectorRetrieverOptions) {
    if (!options?.client || typeof options.client.query !== 'function') {
      throw new Error('PgvectorRetriever: options.client.query is required')
    }
    if (typeof options.embed !== 'function') {
      throw new Error('PgvectorRetriever: options.embed must be a function')
    }
    this.client = options.client
    this.embed = options.embed
    this.table = options.table ?? 'clavue_rag'
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(this.table)) {
      // Identifier is interpolated into SQL — refuse anything that could
      // permit injection. Parameter binding doesn't apply to identifiers.
      throw new Error(`PgvectorRetriever: invalid table name "${this.table}"`)
    }
  }

  async add(documents: RagDocument[]): Promise<void> {
    for (const doc of documents) {
      if (!doc.id || typeof doc.id !== 'string') {
        throw new Error('add: every document must have a non-empty string id')
      }
      if (typeof doc.text !== 'string') {
        throw new Error(`add: document "${doc.id}" has non-string text`)
      }
      const vector = await this.embed(doc.text)
      const literal = toVectorLiteral(vector)
      const metadata = doc.metadata ?? {}
      await this.client.query(
        `INSERT INTO ${this.table} (id, text, embedding, metadata)
         VALUES ($1, $2, $3::vector, $4::jsonb)
         ON CONFLICT (id) DO UPDATE
           SET text = EXCLUDED.text,
               embedding = EXCLUDED.embedding,
               metadata = EXCLUDED.metadata`,
        [doc.id, doc.text, literal, JSON.stringify(metadata)],
      )
    }
  }

  async clear(): Promise<void> {
    await this.client.query(`DELETE FROM ${this.table}`)
  }

  async retrieve(query: RetrieveQuery): Promise<RetrievalHit[]> {
    if (!query || typeof query.text !== 'string') {
      throw new Error('retrieve: query.text required')
    }
    const topK = query.topK ?? 5
    if (topK <= 0) return []

    const vec = await this.embed(query.text)
    const literal = toVectorLiteral(vec)

    const params: unknown[] = [literal, topK]
    let whereSql = ''
    if (query.where && Object.keys(query.where).length > 0) {
      params.push(JSON.stringify(query.where))
      whereSql = ` WHERE metadata @> $3::jsonb`
    }

    // `1 - (a <=> b)` converts cosine distance back into similarity. The
    // ORDER BY uses the raw distance (ASC) so the ivfflat cosine index can
    // serve the query plan.
    const sql = `SELECT id, text, metadata, 1 - (embedding <=> $1::vector) AS score
                 FROM ${this.table}${whereSql}
                 ORDER BY embedding <=> $1::vector
                 LIMIT $2`

    const result = await this.client.query(sql, params)
    const rows = result.rows as Array<{
      id: string
      text: string
      metadata: Record<string, unknown> | null
      score: number | string
    }>
    return rows.map((r) => ({
      id: r.id,
      text: r.text,
      score: typeof r.score === 'string' ? Number(r.score) : r.score,
      ...(r.metadata && Object.keys(r.metadata).length > 0
        ? { metadata: { ...r.metadata } }
        : {}),
    }))
  }
}
