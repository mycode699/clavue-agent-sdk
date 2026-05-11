/**
 * Tier B — in-memory listAgentJobs cache tests.
 *
 * Mirrors `tests/memory-list-cache.test.ts`. Verifies cache hits, write-path
 * invalidation (create / update / stop / clear / replay), explicit
 * `invalidateAgentJobsCache(dir?)`, and that callers can mutate the
 * returned array without poisoning the cache.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

import {
  clearAgentJobs,
  createAgentJob,
  invalidateAgentJobsCache,
  listAgentJobs,
  stopAgentJob,
} from '../src/index.ts'

async function mkJobsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-job-list-cache-'))
}

function namespaceDir(root: string, namespace: string): string {
  return join(root, Buffer.from(namespace, 'utf8').toString('base64url'))
}

const JOB_OPTIONS = (dir: string, namespace: string) => ({
  dir,
  runtimeNamespace: namespace,
  // Negative disables stale checks so cached records aren't rewritten by
  // refresh side-effects in these unit tests.
  staleAfterMs: -1,
})

test('listAgentJobs returns cached results without re-reading files', async () => {
  const dir = await mkJobsDir()
  const namespace = 'cache-hit'
  try {
    const opts = JOB_OPTIONS(dir, namespace)
    await createAgentJob({ kind: 'subagent', prompt: 'first' }, opts)

    const first = await listAgentJobs(opts)
    assert.equal(first.length, 1)

    // Drop a raw file outside the public API. Cache must still return the
    // stale (one-entry) snapshot.
    const nsDir = namespaceDir(dir, namespace)
    await writeFile(
      join(nsDir, 'agent_job_external.json'),
      JSON.stringify({
        id: 'agent_job_external',
        kind: 'subagent',
        status: 'queued',
        runtimeNamespace: namespace,
        prompt: 'external',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      'utf-8',
    )
    const second = await listAgentJobs(opts)
    assert.equal(second.length, 1, 'stale cache returned')

    invalidateAgentJobsCache(nsDir)
    const third = await listAgentJobs(opts)
    assert.equal(third.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createAgentJob invalidates the cache for its namespace', async () => {
  const dir = await mkJobsDir()
  const namespace = 'cache-create'
  try {
    const opts = JOB_OPTIONS(dir, namespace)
    await createAgentJob({ kind: 'subagent', prompt: 'a' }, opts)
    assert.equal((await listAgentJobs(opts)).length, 1)

    await createAgentJob({ kind: 'subagent', prompt: 'b' }, opts)
    const after = await listAgentJobs(opts)
    assert.equal(after.length, 2, 'createAgentJob invalidated cache')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stopAgentJob invalidates the cache (status flips to cancelled)', async () => {
  const dir = await mkJobsDir()
  const namespace = 'cache-stop'
  try {
    const opts = JOB_OPTIONS(dir, namespace)
    const job = await createAgentJob({ kind: 'subagent', prompt: 'x' }, opts)
    const before = await listAgentJobs(opts)
    assert.equal(before[0]!.status, 'queued')

    await stopAgentJob(job.id, 'no-op', opts)
    const after = await listAgentJobs(opts)
    assert.equal(after.length, 1)
    assert.equal(after[0]!.status, 'cancelled', 'cache reflected status update')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('clearAgentJobs invalidates the cache for its namespace', async () => {
  const dir = await mkJobsDir()
  const namespace = 'cache-clear'
  try {
    const opts = JOB_OPTIONS(dir, namespace)
    await createAgentJob({ kind: 'subagent', prompt: 'one' }, opts)
    await createAgentJob({ kind: 'subagent', prompt: 'two' }, opts)
    assert.equal((await listAgentJobs(opts)).length, 2)

    await clearAgentJobs(opts)
    assert.equal((await listAgentJobs(opts)).length, 0, 'cache cleared on rm')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalidateAgentJobsCache() with no argument clears all directories', async () => {
  const dirA = await mkJobsDir()
  const dirB = await mkJobsDir()
  const ns = 'cache-global'
  try {
    const optsA = JOB_OPTIONS(dirA, ns)
    const optsB = JOB_OPTIONS(dirB, ns)
    await createAgentJob({ kind: 'subagent', prompt: 'a' }, optsA)
    await createAgentJob({ kind: 'subagent', prompt: 'b' }, optsB)

    await listAgentJobs(optsA)
    await listAgentJobs(optsB)

    // Out-of-band raw writes to both namespace dirs.
    const writeRaw = async (root: string, id: string) => {
      const nsDir = namespaceDir(root, ns)
      await writeFile(
        join(nsDir, `${id}.json`),
        JSON.stringify({
          id,
          kind: 'subagent',
          status: 'queued',
          runtimeNamespace: ns,
          prompt: id,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        'utf-8',
      )
    }
    await writeRaw(dirA, 'agent_job_a2')
    await writeRaw(dirB, 'agent_job_b2')

    invalidateAgentJobsCache()
    assert.equal((await listAgentJobs(optsA)).length, 2)
    assert.equal((await listAgentJobs(optsB)).length, 2)
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('listAgentJobs returns a fresh array (caller mutation is safe)', async () => {
  const dir = await mkJobsDir()
  const namespace = 'cache-isolation'
  try {
    const opts = JOB_OPTIONS(dir, namespace)
    await createAgentJob({ kind: 'subagent', prompt: 'a' }, opts)

    const first = await listAgentJobs(opts)
    first.length = 0 // mutate caller's copy
    const second = await listAgentJobs(opts)
    assert.equal(second.length, 1, 'internal cache survived caller truncation')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listAgentJobs cache avoids re-reading files on hot path', async () => {
  const dir = await mkJobsDir()
  const namespace = 'cache-no-disk'
  try {
    const opts = JOB_OPTIONS(dir, namespace)
    const job = await createAgentJob({ kind: 'subagent', prompt: 'a' }, opts)

    // Warm cache.
    await listAgentJobs(opts)

    // Remove the disk file behind the cache's back. A fresh read would see
    // zero entries — the cache should still return one entry.
    const nsDir = namespaceDir(dir, namespace)
    await rm(join(nsDir, `${job.id}.json`))
    assert.deepEqual(await readdir(nsDir), [])

    const cached = await listAgentJobs(opts)
    assert.equal(cached.length, 1, 'cache served without touching disk')

    invalidateAgentJobsCache(nsDir)
    assert.equal((await listAgentJobs(opts)).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
