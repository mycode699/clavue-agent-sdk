/**
 * Tier A #7 — in-memory listMemories cache tests.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deleteMemory,
  invalidateMemoryCache,
  listMemories,
  saveMemory,
} from '../src/index.ts'

async function mkMemDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-list-cache-'))
}

test('listMemories returns cached results on repeated calls without re-reading files', async () => {
  const dir = await mkMemDir()
  try {
    await saveMemory(
      { id: 'a', type: 'feedback', scope: 'global', title: 'T', content: 'c1' },
      { dir },
    )

    // Warm the cache.
    const first = await listMemories({ dir })
    assert.equal(first.length, 1)

    // Write a raw file outside the public API — cache must still return
    // the stale (one-entry) snapshot because the write didn't go through
    // saveMemory.
    await writeFile(
      join(dir, 'b.json'),
      JSON.stringify({
        id: 'b',
        type: 'feedback',
        scope: 'global',
        title: 'T2',
        content: 'c2',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    )
    const second = await listMemories({ dir })
    assert.equal(second.length, 1, 'stale cache returned')

    // Invalidate explicitly → fresh read picks up the out-of-band file.
    invalidateMemoryCache(dir)
    const third = await listMemories({ dir })
    assert.equal(third.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saveMemory invalidates the cache for its dir', async () => {
  const dir = await mkMemDir()
  try {
    await saveMemory(
      { id: 'a', type: 'feedback', scope: 'global', title: 'T', content: 'c1' },
      { dir },
    )
    const first = await listMemories({ dir })
    assert.equal(first.length, 1)

    await saveMemory(
      { id: 'b', type: 'feedback', scope: 'global', title: 'T', content: 'c2' },
      { dir },
    )
    const second = await listMemories({ dir })
    assert.equal(second.length, 2, 'saveMemory invalidated cache')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteMemory invalidates the cache for its dir', async () => {
  const dir = await mkMemDir()
  try {
    await saveMemory(
      { id: 'a', type: 'feedback', scope: 'global', title: 'T', content: 'c1' },
      { dir },
    )
    await saveMemory(
      { id: 'b', type: 'feedback', scope: 'global', title: 'T', content: 'c2' },
      { dir },
    )
    assert.equal((await listMemories({ dir })).length, 2)

    await deleteMemory('a', { dir })
    const after = await listMemories({ dir })
    assert.equal(after.length, 1)
    assert.equal(after[0]!.id, 'b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalidateMemoryCache() with no argument clears all directories', async () => {
  const dirA = await mkMemDir()
  const dirB = await mkMemDir()
  try {
    await saveMemory(
      { id: 'x', type: 'feedback', scope: 'global', title: 'Ta', content: 'ca' },
      { dir: dirA },
    )
    await saveMemory(
      { id: 'y', type: 'feedback', scope: 'global', title: 'Tb', content: 'cb' },
      { dir: dirB },
    )
    // Warm both caches.
    await listMemories({ dir: dirA })
    await listMemories({ dir: dirB })

    // Raw writes to both (out-of-band).
    await writeFile(
      join(dirA, 'x2.json'),
      JSON.stringify({
        id: 'x2', type: 'feedback', scope: 'global', title: 'Ta2', content: 'ca2',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    )
    await writeFile(
      join(dirB, 'y2.json'),
      JSON.stringify({
        id: 'y2', type: 'feedback', scope: 'global', title: 'Tb2', content: 'cb2',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    )

    invalidateMemoryCache()
    assert.equal((await listMemories({ dir: dirA })).length, 2)
    assert.equal((await listMemories({ dir: dirB })).length, 2)
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('listMemories cache returns a fresh array (caller mutation is safe)', async () => {
  const dir = await mkMemDir()
  try {
    await saveMemory(
      { id: 'a', type: 'feedback', scope: 'global', title: 'T', content: 'c1' },
      { dir },
    )
    const first = await listMemories({ dir })
    first.length = 0 // mutate caller's copy
    const second = await listMemories({ dir })
    assert.equal(second.length, 1, 'internal cache survived caller truncation')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listMemories cache avoids re-reading files on hot path', async () => {
  const dir = await mkMemDir()
  try {
    await saveMemory(
      { id: 'a', type: 'feedback', scope: 'global', title: 'T', content: 'c1' },
      { dir },
    )

    // Warm cache.
    await listMemories({ dir })

    // Remove the disk file behind the cache's back. A fresh read would
    // see zero entries — the cache should still return one entry.
    await rm(join(dir, 'a.json'))
    assert.deepEqual(await readdir(dir), [])

    const cached = await listMemories({ dir })
    assert.equal(cached.length, 1, 'cache served without touching disk')

    invalidateMemoryCache(dir)
    assert.equal((await listMemories({ dir })).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
