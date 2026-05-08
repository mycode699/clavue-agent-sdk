import test from 'node:test'
import assert from 'node:assert/strict'

import { InMemoryRetriever, cosine } from '../src/rag/index.ts'

/** Toy embedding: hash 'topic:X' tokens into 8-dim one-hot-ish vectors. */
function toyEmbed(text: string): number[] {
  const dims = 8
  const v = new Array<number>(dims).fill(0)
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0
    for (let i = 0; i < word.length; i += 1) h = (h * 31 + word.charCodeAt(i)) & 0xffffffff
    const idx = Math.abs(h) % dims
    v[idx] = v[idx]! + 1
  }
  return v
}

test('cosine: identical vectors → 1, orthogonal → 0, zero vector → 0 (no NaN)', () => {
  assert.equal(cosine([1, 0, 0], [1, 0, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([0, 0, 0], [1, 1, 1]), 0)
  // antiparallel
  assert.equal(cosine([1, 0], [-1, 0]), -1)
})

test('cosine: handles vectors of unequal length by truncating to min', () => {
  // Loop only walks the first min(|a|,|b|) elements, so trailing values in
  // the longer vector are ignored entirely. a=[1,0,5] vs b=[1,0]:
  //   dot = 1, aa = 1 (only first 2 of a), bb = 1 → cosine = 1.
  assert.equal(cosine([1, 0, 5], [1, 0]), 1)
})

test('constructor rejects missing embed fn', () => {
  // @ts-expect-error
  assert.throws(() => new InMemoryRetriever({}), /embed must be a function/)
})

test('add: rejects bad ids and bad text and bad vectors', async () => {
  const r = new InMemoryRetriever({ embed: toyEmbed })
  // @ts-expect-error
  await assert.rejects(() => r.add([{ text: 'no id' }]), /non-empty string id/)
  // @ts-expect-error
  await assert.rejects(() => r.add([{ id: 'a', text: 42 }]), /non-string text/)

  const badEmbed = new InMemoryRetriever({ embed: () => [] })
  await assert.rejects(() => badEmbed.add([{ id: 'x', text: 't' }]), /invalid vector/)
})

test('add: upsert default true overwrites; upsert false throws on duplicate', async () => {
  const upserter = new InMemoryRetriever({ embed: toyEmbed })
  await upserter.add([{ id: 'a', text: 'first' }])
  await upserter.add([{ id: 'a', text: 'second' }])
  assert.equal(upserter.count(), 1)

  const strict = new InMemoryRetriever({ embed: toyEmbed, upsert: false })
  await strict.add([{ id: 'a', text: 'first' }])
  await assert.rejects(() => strict.add([{ id: 'a', text: 'second' }]), /duplicate id/)
})

test('retrieve: empty store returns []', async () => {
  const r = new InMemoryRetriever({ embed: toyEmbed })
  const hits = await r.retrieve({ text: 'anything' })
  assert.deepEqual(hits, [])
})

test('retrieve: ranks by cosine similarity (best first)', async () => {
  const r = new InMemoryRetriever({ embed: toyEmbed })
  await r.add([
    { id: 'd1', text: 'graph dsl router parallel verifier' },
    { id: 'd2', text: 'totally unrelated cooking recipe sausage' },
    { id: 'd3', text: 'graph router agent' },
  ])
  const hits = await r.retrieve({ text: 'graph router', topK: 2 })
  assert.equal(hits.length, 2)
  // d1 and d3 share tokens with the query — d2 should NOT be in top-2.
  const ids = hits.map((h) => h.id)
  assert.ok(!ids.includes('d2'), `expected d2 to be excluded, got ${ids.join(', ')}`)
  // hits sorted descending by score
  assert.ok(hits[0]!.score >= hits[1]!.score)
})

test('retrieve: respects topK and topK<=0', async () => {
  const r = new InMemoryRetriever({ embed: toyEmbed })
  await r.add([
    { id: '1', text: 'a' },
    { id: '2', text: 'b' },
    { id: '3', text: 'c' },
  ])
  const oneHit = await r.retrieve({ text: 'a', topK: 1 })
  assert.equal(oneHit.length, 1)
  const zero = await r.retrieve({ text: 'a', topK: 0 })
  assert.deepEqual(zero, [])
})

test('retrieve: where filter (metadata equality) excludes non-matching docs', async () => {
  const r = new InMemoryRetriever({ embed: toyEmbed })
  await r.add([
    { id: 'pub', text: 'public secret', metadata: { visibility: 'public' } },
    { id: 'pri', text: 'private secret', metadata: { visibility: 'private' } },
    { id: 'no-meta', text: 'private secret' },
  ])
  const hits = await r.retrieve({ text: 'secret', where: { visibility: 'public' } })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.id, 'pub')
})

test('retrieve: clones metadata so callers cannot mutate store state', async () => {
  const r = new InMemoryRetriever({ embed: toyEmbed })
  await r.add([{ id: 'm', text: 'x', metadata: { tag: 'orig' } }])
  const hits = await r.retrieve({ text: 'x', topK: 1 })
  ;(hits[0]!.metadata as Record<string, unknown>).tag = 'mutated'
  const again = await r.retrieve({ text: 'x', topK: 1 })
  assert.equal((again[0]!.metadata as Record<string, unknown>).tag, 'orig')
})

test('clear empties the store', async () => {
  const r = new InMemoryRetriever({ embed: toyEmbed })
  await r.add([{ id: 'a', text: 'x' }])
  assert.equal(r.count(), 1)
  r.clear()
  assert.equal(r.count(), 0)
})

test('retrieve rejects malformed query.text', async () => {
  const r = new InMemoryRetriever({ embed: toyEmbed })
  await r.add([{ id: 'a', text: 'x' }])
  // @ts-expect-error
  await assert.rejects(() => r.retrieve({}), /text required/)
})

test('async embed fn is awaited', async () => {
  const asyncEmbed = async (t: string) => {
    await new Promise((r) => setTimeout(r, 1))
    return toyEmbed(t)
  }
  const r = new InMemoryRetriever({ embed: asyncEmbed })
  await r.add([{ id: 'q', text: 'graph router' }])
  const hits = await r.retrieve({ text: 'graph router', topK: 1 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0]!.id, 'q')
})
