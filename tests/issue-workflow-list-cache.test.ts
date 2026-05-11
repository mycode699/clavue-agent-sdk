/**
 * In-memory listIssueWorkflowRuns cache tests.
 *
 * Mirrors `tests/agent-jobs-list-cache.test.ts`. Verifies cache hits,
 * write-path invalidation (create / stop / explicit write), explicit
 * `invalidateIssueWorkflowRunsCache(dir?)`, and that callers can mutate
 * the returned array without poisoning the cache.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

import {
  createIssueWorkflowRun,
  invalidateIssueWorkflowRunsCache,
  listIssueWorkflowRuns,
  normalizeIssueInput,
  stopIssueWorkflowRun,
  type IssueWorkflowRecord,
} from '../src/index.ts'

async function mkRunsRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-issue-runs-cache-'))
}

function issueRunsDir(root: string, namespace: string): string {
  return join(root, 'issue-runs', Buffer.from(namespace, 'utf8').toString('base64url'))
}

function makeIssue(id: string, title: string): IssueWorkflowRecord {
  return normalizeIssueInput(`---\nid: ${id}\n---\n# ${title}\n\nbody`)
}

const RUN_OPTIONS = (dir: string, namespace: string) => ({
  dir,
  runtimeNamespace: namespace,
})

test('listIssueWorkflowRuns returns cached results without re-reading files', async () => {
  const dir = await mkRunsRoot()
  const namespace = 'cache-hit'
  try {
    const opts = RUN_OPTIONS(dir, namespace)
    await createIssueWorkflowRun({ issue: makeIssue('first', 'First'), cwd: '/tmp' }, opts)

    const first = await listIssueWorkflowRuns(opts)
    assert.equal(first.length, 1)

    // Drop a raw run file outside the public API. Cache must still
    // return the stale one-entry snapshot.
    const runsDir = issueRunsDir(dir, namespace)
    await writeFile(
      join(runsDir, 'issue_run_external.json'),
      JSON.stringify({
        schema_version: '1.0.0',
        id: 'issue_run_external',
        issue: makeIssue('ext', 'External'),
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        correlation_id: 'issue_run_external',
        batch_id: 'b-external',
        workspace: { cwd: '/tmp', runtimeNamespace: namespace, isolation: 'local' },
        jobs: [],
        requiredGates: [],
        passingScore: 80,
      }),
      'utf-8',
    )
    const second = await listIssueWorkflowRuns(opts)
    assert.equal(second.length, 1, 'stale cache returned')

    invalidateIssueWorkflowRunsCache(runsDir)
    const third = await listIssueWorkflowRuns(opts)
    assert.equal(third.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('createIssueWorkflowRun invalidates the cache for its namespace', async () => {
  const dir = await mkRunsRoot()
  const namespace = 'cache-create'
  try {
    const opts = RUN_OPTIONS(dir, namespace)
    await createIssueWorkflowRun({ issue: makeIssue('a', 'A'), cwd: '/tmp' }, opts)
    assert.equal((await listIssueWorkflowRuns(opts)).length, 1)

    await createIssueWorkflowRun({ issue: makeIssue('b', 'B'), cwd: '/tmp' }, opts)
    assert.equal((await listIssueWorkflowRuns(opts)).length, 2, 'create invalidated cache')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('stopIssueWorkflowRun invalidates the cache (status flips to cancelled)', async () => {
  const dir = await mkRunsRoot()
  const namespace = 'cache-stop'
  try {
    const opts = RUN_OPTIONS(dir, namespace)
    const run = await createIssueWorkflowRun({ issue: makeIssue('x', 'X'), cwd: '/tmp' }, opts)
    const before = await listIssueWorkflowRuns(opts)
    assert.equal(before[0]!.status, 'queued')

    await stopIssueWorkflowRun(run.id, 'no-op', opts)
    const after = await listIssueWorkflowRuns(opts)
    assert.equal(after.length, 1)
    assert.equal(after[0]!.status, 'cancelled', 'cache reflected status update')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('invalidateIssueWorkflowRunsCache() with no argument clears all directories', async () => {
  const dirA = await mkRunsRoot()
  const dirB = await mkRunsRoot()
  const ns = 'cache-global'
  try {
    const optsA = RUN_OPTIONS(dirA, ns)
    const optsB = RUN_OPTIONS(dirB, ns)
    await createIssueWorkflowRun({ issue: makeIssue('a', 'A'), cwd: '/tmp' }, optsA)
    await createIssueWorkflowRun({ issue: makeIssue('b', 'B'), cwd: '/tmp' }, optsB)
    await listIssueWorkflowRuns(optsA)
    await listIssueWorkflowRuns(optsB)

    const writeRaw = async (root: string, id: string) => {
      const runsDir = issueRunsDir(root, ns)
      await writeFile(
        join(runsDir, `${id}.json`),
        JSON.stringify({
          schema_version: '1.0.0',
          id,
          issue: makeIssue(id, id),
          status: 'queued',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          correlation_id: id,
          batch_id: `b-${id}`,
          workspace: { cwd: '/tmp', runtimeNamespace: ns, isolation: 'local' },
          jobs: [],
          requiredGates: [],
          passingScore: 80,
        }),
        'utf-8',
      )
    }
    await writeRaw(dirA, 'issue_run_a2')
    await writeRaw(dirB, 'issue_run_b2')

    invalidateIssueWorkflowRunsCache()
    assert.equal((await listIssueWorkflowRuns(optsA)).length, 2)
    assert.equal((await listIssueWorkflowRuns(optsB)).length, 2)
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('listIssueWorkflowRuns returns a fresh array (caller mutation is safe)', async () => {
  const dir = await mkRunsRoot()
  const namespace = 'cache-isolation'
  try {
    const opts = RUN_OPTIONS(dir, namespace)
    await createIssueWorkflowRun({ issue: makeIssue('a', 'A'), cwd: '/tmp' }, opts)

    const first = await listIssueWorkflowRuns(opts)
    first.length = 0
    const second = await listIssueWorkflowRuns(opts)
    assert.equal(second.length, 1, 'internal cache survived caller truncation')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('listIssueWorkflowRuns cache avoids re-reading files on hot path', async () => {
  const dir = await mkRunsRoot()
  const namespace = 'cache-no-disk'
  try {
    const opts = RUN_OPTIONS(dir, namespace)
    const run = await createIssueWorkflowRun({ issue: makeIssue('a', 'A'), cwd: '/tmp' }, opts)
    await listIssueWorkflowRuns(opts)

    // Remove the disk file behind the cache's back. A fresh read would
    // see zero entries — the cache should still return one entry.
    const runsDir = issueRunsDir(dir, namespace)
    await rm(join(runsDir, `${run.id}.json`))
    assert.deepEqual(await readdir(runsDir), [])

    const cached = await listIssueWorkflowRuns(opts)
    assert.equal(cached.length, 1, 'cache served without touching disk')

    invalidateIssueWorkflowRunsCache(runsDir)
    assert.equal((await listIssueWorkflowRuns(opts)).length, 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
