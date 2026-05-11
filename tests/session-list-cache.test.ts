/**
 * Tier B — in-memory listSessions cache tests.
 *
 * Mirrors `tests/memory-list-cache.test.ts` and
 * `tests/agent-jobs-list-cache.test.ts`. Verifies cache hits, write-path
 * invalidation, explicit `invalidateSessionCache(dir?)`, and that callers
 * can mutate the returned array without poisoning the cache.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  deleteSession,
  invalidateSessionCache,
  listSessions,
  saveSession,
} from '../src/index.ts'

async function mkSessionsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-session-cache-'))
}

test('listSessions returns cached results without re-reading transcripts', async () => {
  const dir = await mkSessionsDir()
  try {
    await saveSession('sess-a', [], { cwd: '/tmp', model: 'm' }, { dir })

    const first = await listSessions({ dir })
    assert.equal(first.length, 1)

    // Raw write outside the public API. Cache must still return the stale
    // one-entry snapshot.
    const rawId = 'sess-raw'
    await mkdir(join(dir, rawId), { recursive: true })
    await writeFile(
      join(dir, rawId, 'transcript.json'),
      JSON.stringify({
        metadata: {
          id: rawId,
          cwd: '/tmp',
          model: 'm',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          messageCount: 0,
        },
        messages: [],
      }),
      'utf-8',
    )
    const second = await listSessions({ dir })
    assert.equal(second.length, 1, 'stale cache returned')

    invalidateSessionCache(dir)
    const third = await listSessions({ dir })
    assert.equal(third.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('saveSession invalidates the cache for its dir', async () => {
  const dir = await mkSessionsDir()
  try {
    await saveSession('sess-a', [], { cwd: '/tmp', model: 'm' }, { dir })
    assert.equal((await listSessions({ dir })).length, 1)

    await saveSession('sess-b', [], { cwd: '/tmp', model: 'm' }, { dir })
    const after = await listSessions({ dir })
    assert.equal(after.length, 2, 'saveSession invalidated cache')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('deleteSession invalidates the cache for its dir', async () => {
  const dir = await mkSessionsDir()
  try {
    await saveSession('sess-a', [], { cwd: '/tmp', model: 'm' }, { dir })
    await saveSession('sess-b', [], { cwd: '/tmp', model: 'm' }, { dir })
    assert.equal((await listSessions({ dir })).length, 2)

    await deleteSession('sess-a', { dir })
    const after = await listSessions({ dir })
    assert.equal(after.length, 1)
    assert.equal(after[0]!.id, 'sess-b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalidateSessionCache() with no argument clears all directories', async () => {
  const dirA = await mkSessionsDir()
  const dirB = await mkSessionsDir()
  try {
    await saveSession('x', [], { cwd: '/tmp', model: 'm' }, { dir: dirA })
    await saveSession('y', [], { cwd: '/tmp', model: 'm' }, { dir: dirB })
    await listSessions({ dir: dirA })
    await listSessions({ dir: dirB })

    // Raw out-of-band writes to both.
    const writeRaw = async (root: string, id: string) => {
      await mkdir(join(root, id), { recursive: true })
      await writeFile(
        join(root, id, 'transcript.json'),
        JSON.stringify({
          metadata: {
            id,
            cwd: '/tmp',
            model: 'm',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            messageCount: 0,
          },
          messages: [],
        }),
        'utf-8',
      )
    }
    await writeRaw(dirA, 'x2')
    await writeRaw(dirB, 'y2')

    invalidateSessionCache()
    assert.equal((await listSessions({ dir: dirA })).length, 2)
    assert.equal((await listSessions({ dir: dirB })).length, 2)
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('listSessions returns a fresh array (caller mutation is safe)', async () => {
  const dir = await mkSessionsDir()
  try {
    await saveSession('sess-a', [], { cwd: '/tmp', model: 'm' }, { dir })
    const first = await listSessions({ dir })
    first.length = 0
    const second = await listSessions({ dir })
    assert.equal(second.length, 1, 'internal cache survived caller truncation')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listSessions cache avoids re-reading transcripts on hot path', async () => {
  const dir = await mkSessionsDir()
  try {
    await saveSession('sess-a', [], { cwd: '/tmp', model: 'm' }, { dir })

    await listSessions({ dir })

    // Blow away the session dir behind the cache's back.
    await rm(join(dir, 'sess-a'), { recursive: true, force: true })

    const cached = await listSessions({ dir })
    assert.equal(cached.length, 1, 'cache served without touching disk')

    invalidateSessionCache(dir)
    assert.equal((await listSessions({ dir })).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
