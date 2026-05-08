import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  cosineSimilarity,
  type EmbedderLike,
} from '../src/memory/embedder-adapter.ts'
import {
  saveMemory,
  queryMemoryMatches,
  type MemoryEntry,
} from '../src/memory.ts'

// ---------------------------------------------------------------------------
// cosineSimilarity — pure helper, no IO
// ---------------------------------------------------------------------------

test('cosineSimilarity: identical vectors return 1', () => {
  const v = [0.5, 0.5, 0.5, 0.5]
  assert.equal(cosineSimilarity(v, v), 1)
})

test('cosineSimilarity: orthogonal vectors return 0', () => {
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
})

test('cosineSimilarity: opposite vectors return -1 (clamped)', () => {
  const sim = cosineSimilarity([1, 0], [-1, 0])
  assert.equal(sim, -1)
})

test('cosineSimilarity: zero vectors return 0 (no division by zero)', () => {
  assert.equal(cosineSimilarity([0, 0], [0, 0]), 0)
  assert.equal(cosineSimilarity([0, 0], [1, 0]), 0)
})

test('cosineSimilarity: mismatched dimensions return 0', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0, 0]), 0)
})

// ---------------------------------------------------------------------------
// queryMemoryMatches strategy dispatch — uses a tmp memory dir
// ---------------------------------------------------------------------------

/**
 * Deterministic mock embedder — returns a fixed vector for known tokens so
 * we can write meaningful similarity assertions without floating-point dance.
 *
 * Token bank:
 *   "cat"   → [1, 0, 0]
 *   "feline" → [0.95, 0.05, 0]   (close to cat — synonym)
 *   "car"   → [0, 1, 0]          (orthogonal — different meaning)
 *   else    → [0, 0, 1]
 */
function tokenEmbedder(): EmbedderLike {
  const bank: Record<string, number[]> = {
    cat: [1, 0, 0],
    feline: [0.95, 0.05, 0],
    car: [0, 1, 0],
  }
  return {
    async embed(text) {
      const t = text.toLowerCase()
      for (const [key, vec] of Object.entries(bank)) {
        if (t.includes(key)) return vec
      }
      return [0, 0, 1]
    },
  }
}

async function withTempMemoryDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-memvec-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function seed(dir: string, ...entries: Array<Partial<MemoryEntry> & { id: string; title: string; content: string }>): Promise<void> {
  for (const e of entries) {
    await saveMemory(
      {
        id: e.id,
        type: e.type ?? 'reference',
        scope: e.scope ?? 'global',
        title: e.title,
        content: e.content,
        tags: e.tags,
      },
      { dir },
    )
  }
}

test('queryMemoryMatches default strategy is keyword (no embedder needed)', async () => {
  await withTempMemoryDir(async (dir) => {
    await seed(
      dir,
      { id: 'm1', title: 'Cat facts', content: 'cats purr' },
      { id: 'm2', title: 'Car facts', content: 'cars vroom' },
    )
    // Legacy keyword path is also a hard filter: m2 contains no "cat" so
    // it's filtered out entirely. m1 stays with a positive score.
    const matches = await queryMemoryMatches({ text: 'cat' }, { dir })
    assert.equal(matches.length, 1)
    assert.equal(matches[0].entry.id, 'm1')
    assert.ok(matches[0].score > 0)
  })
})

test('queryMemoryMatches vector strategy finds synonyms keyword cannot', async () => {
  await withTempMemoryDir(async (dir) => {
    await seed(
      dir,
      { id: 'm1', title: 'Feline biology', content: 'whiskers and claws' },
      { id: 'm2', title: 'Automotive', content: 'engines and tires' },
    )
    // Keyword path filters everything because no entry contains "cat".
    const kw = await queryMemoryMatches({ text: 'cat' }, { dir })
    assert.equal(kw.length, 0)

    // Vector path with the synonym embedder finds m1 above m2.
    const vec = await queryMemoryMatches(
      { text: 'cat', strategy: 'vector', embedder: tokenEmbedder() },
      { dir },
    )
    assert.equal(vec[0].entry.id, 'm1')
    assert.ok(vec[0].score > vec[1].score)
    assert.ok(vec[0].scoreReasons.some((r) => r.startsWith('vector:')))
  })
})

test('queryMemoryMatches hybrid strategy combines keyword + vector signals', async () => {
  await withTempMemoryDir(async (dir) => {
    await seed(
      dir,
      { id: 'kw_only', title: 'cat in title', content: 'no synonym here' },
      { id: 'vec_only', title: 'Feline notes', content: 'whiskers' },
      { id: 'unrelated', title: 'Car facts', content: 'engines' },
    )
    const matches = await queryMemoryMatches(
      { text: 'cat', strategy: 'hybrid', embedder: tokenEmbedder() },
      { dir },
    )
    // Both kw_only and vec_only must rank above unrelated.
    const ids = matches.map((m) => m.entry.id)
    assert.notEqual(ids[0], 'unrelated')
    assert.notEqual(ids[1], 'unrelated')
    // Top 2 must be kw_only + vec_only in some order.
    assert.deepEqual([...ids.slice(0, 2)].sort(), ['kw_only', 'vec_only'])
  })
})

test('queryMemoryMatches vector strategy without embedder falls back gracefully', async () => {
  await withTempMemoryDir(async (dir) => {
    await seed(dir, { id: 'm1', title: 'Cat', content: 'cat content' })
    const matches = await queryMemoryMatches(
      { text: 'cat', strategy: 'vector' /* no embedder */ },
      { dir },
    )
    assert.equal(matches.length, 1)
    // Only keyword scoring would have applied, but strategy was vector-only,
    // so score for keyword path is 0 — and we record the skip reason.
    assert.equal(matches[0].score, 0)
    assert.ok(
      matches[0].scoreReasons.some((r) => r === 'vector_skipped:no_embedder'),
    )
  })
})

test('queryMemoryMatches vector handles embedder throwing on the query', async () => {
  await withTempMemoryDir(async (dir) => {
    await seed(dir, { id: 'm1', title: 'Cat', content: 'cat content' })
    const broken: EmbedderLike = {
      async embed() {
        throw new Error('embed failed')
      },
    }
    const matches = await queryMemoryMatches(
      { text: 'cat', strategy: 'vector', embedder: broken },
      { dir },
    )
    assert.equal(matches.length, 1)
    assert.ok(
      matches[0].scoreReasons.some((r) => r === 'vector_skipped:embed_error'),
    )
  })
})
