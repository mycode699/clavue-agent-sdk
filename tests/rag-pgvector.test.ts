/**
 * PgvectorRetriever test (v3.5 follow-up).
 *
 * Stubs the `pg.Client` surface — no Postgres needed in CI. Verifies:
 *   - `add` issues parameterised UPSERT including JSONB metadata + vector literal
 *   - `retrieve` builds a cosine-distance ORDER BY query with topK and `where`
 *   - score reflects `1 - cosine_distance` (i.e. similarity in [-1, 1])
 *   - validation rejects bad table names, empty vectors, and NaN/Infinity
 *
 * @module
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { PgvectorRetriever, type PgClientLike } from '../src/index.ts'

interface RecordedQuery {
  text: string
  values?: unknown[]
}

function stubClient(rowsForRetrieve: unknown[] = []): {
  client: PgClientLike
  log: RecordedQuery[]
} {
  const log: RecordedQuery[] = []
  const client: PgClientLike = {
    async query(text, values) {
      log.push({ text, ...(values !== undefined ? { values } : {}) })
      // Anything matching a SELECT is a retrieve; INSERT/DELETE return [].
      if (/^SELECT/i.test(text.trim())) return { rows: rowsForRetrieve }
      return { rows: [] }
    },
  }
  return { client, log }
}

test('add issues parameterised UPSERT with vector literal + JSONB metadata', async () => {
  const { client, log } = stubClient()
  const r = new PgvectorRetriever({
    client,
    embed: () => [0.1, 0.2, 0.3],
  })

  await r.add([{ id: 'doc-1', text: 'hello', metadata: { lang: 'en' } }])

  assert.equal(log.length, 1)
  const q = log[0]!
  assert.match(q.text, /INSERT INTO clavue_rag/)
  assert.match(q.text, /ON CONFLICT \(id\) DO UPDATE/)
  assert.deepEqual(q.values, ['doc-1', 'hello', '[0.1,0.2,0.3]', '{"lang":"en"}'])
})

test('add omits metadata gracefully when none provided', async () => {
  const { client, log } = stubClient()
  const r = new PgvectorRetriever({
    client,
    embed: () => [0.5, 0.5],
  })

  await r.add([{ id: 'doc-2', text: 'plain' }])

  assert.equal(log[0]!.values?.[3], '{}')
})

test('retrieve builds cosine ORDER BY, applies topK, returns similarity score', async () => {
  const { client, log } = stubClient([
    { id: 'a', text: 'first', metadata: { lang: 'en' }, score: 0.92 },
    { id: 'b', text: 'second', metadata: null, score: '0.81' }, // string from pg numeric
  ])
  const r = new PgvectorRetriever({
    client,
    embed: () => [1, 0, 0],
  })

  const hits = await r.retrieve({ text: 'q', topK: 2 })
  assert.equal(hits.length, 2)
  assert.equal(hits[0]!.id, 'a')
  assert.equal(hits[0]!.score, 0.92)
  assert.deepEqual(hits[0]!.metadata, { lang: 'en' })
  assert.equal(hits[1]!.score, 0.81) // numeric coercion
  assert.equal(hits[1]!.metadata, undefined) // empty metadata not echoed

  const sql = log[0]!.text
  assert.match(sql, /1 - \(embedding <=> \$1::vector\) AS score/)
  assert.match(sql, /ORDER BY embedding <=> \$1::vector/)
  assert.match(sql, /LIMIT \$2/)
  assert.deepEqual(log[0]!.values, ['[1,0,0]', 2])
})

test('retrieve adds JSONB containment WHERE when `where` is provided', async () => {
  const { client, log } = stubClient([])
  const r = new PgvectorRetriever({
    client,
    embed: () => [0.1, 0.2],
  })

  await r.retrieve({ text: 'q', topK: 5, where: { lang: 'en', tier: 1 } })
  const sql = log[0]!.text
  assert.match(sql, / WHERE metadata @> \$3::jsonb/)
  assert.deepEqual(log[0]!.values, ['[0.1,0.2]', 5, '{"lang":"en","tier":1}'])
})

test('retrieve returns [] for topK <= 0 without hitting the database', async () => {
  const { client, log } = stubClient([{ id: 'x', text: 'x', metadata: null, score: 1 }])
  const r = new PgvectorRetriever({ client, embed: () => [1] })
  const hits = await r.retrieve({ text: 'q', topK: 0 })
  assert.deepEqual(hits, [])
  assert.equal(log.length, 0, 'no SELECT issued for topK=0')
})

test('clear issues DELETE against the configured table', async () => {
  const { client, log } = stubClient()
  const r = new PgvectorRetriever({ client, embed: () => [1], table: 'rag_v2' })
  await r.clear()
  assert.equal(log[0]!.text, 'DELETE FROM rag_v2')
})

test('rejects invalid table names (SQL identifier injection guard)', () => {
  assert.throws(
    () => new PgvectorRetriever({
      client: { async query() { return { rows: [] } } },
      embed: () => [1],
      table: 'rag; DROP TABLE users; --',
    }),
    /invalid table name/,
  )
})

test('rejects non-finite embeddings before they reach Postgres', async () => {
  const r = new PgvectorRetriever({
    client: { async query() { return { rows: [] } } },
    embed: () => [0.1, Number.NaN, 0.3],
  })
  await assert.rejects(() => r.add([{ id: 'd', text: 'x' }]), /not finite/)
})

test('rejects empty embeddings', async () => {
  const r = new PgvectorRetriever({
    client: { async query() { return { rows: [] } } },
    embed: () => [],
  })
  await assert.rejects(() => r.retrieve({ text: 'q' }), /non-empty/)
})

test('constructor enforces required client + embed', () => {
  assert.throws(
    () => new PgvectorRetriever({ client: null as unknown as PgClientLike, embed: () => [1] }),
    /client\.query/,
  )
  assert.throws(
    () => new PgvectorRetriever({
      client: { async query() { return { rows: [] } } },
      embed: undefined as unknown as () => number[],
    }),
    /embed must be a function/,
  )
})
