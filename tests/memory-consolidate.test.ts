import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  consolidateMemories,
  findDuplicateMemories,
  listMemories,
  loadMemory,
  saveMemory,
} from '../src/index.ts'
import type { EmbedderLike } from '../src/memory/embedder-adapter.ts'

async function createMemoryDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-agent-sdk-consolidate-'))
}

test('findDuplicateMemories is a non-destructive preview (dry_run=true)', async () => {
  const dir = await createMemoryDir()
  try {
    await saveMemory({
      id: 'fb-1',
      type: 'feedback',
      scope: 'repo',
      title: 'Minimize confirmation prompts',
      content: 'Run continuously; pause only for destructive actions.',
      tags: ['autonomy'],
      repoPath: '/tmp/repo',
    }, { dir })
    await saveMemory({
      id: 'fb-2',
      type: 'feedback',
      scope: 'repo',
      title: 'Minimize confirmation prompts',
      content: 'Same rule, slightly different wording about continuous execution.',
      tags: ['workflow'],
      repoPath: '/tmp/repo',
    }, { dir })
    await saveMemory({
      id: 'fb-3',
      type: 'project',
      scope: 'repo',
      title: 'Migration to v3',
      content: 'Different memory entirely.',
      repoPath: '/tmp/repo',
    }, { dir })

    const report = await findDuplicateMemories({ dir })
    assert.equal(report.dry_run, true)
    assert.equal(report.scanned, 3)
    assert.equal(report.duplicate_groups, 1)
    assert.equal(report.removed, 1)

    const after = await listMemories({ dir })
    assert.equal(after.length, 3, 'dry-run must not mutate the store')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('consolidateMemories merges duplicates by identity key (type+scope+title+repoPath)', async () => {
  const dir = await createMemoryDir()
  try {
    await saveMemory({
      id: 'a',
      type: 'feedback',
      scope: 'repo',
      title: 'Minimize confirmation prompts',
      content: 'Original content.',
      tags: ['autonomy'],
      confidence: 'medium',
      repoPath: '/tmp/r',
    }, { dir })
    // Sleep to ensure different updatedAt timestamps for deterministic ordering.
    await new Promise((r) => setTimeout(r, 5))
    await saveMemory({
      id: 'b',
      type: 'feedback',
      scope: 'repo',
      title: 'Minimize confirmation prompts',
      content: 'Newer content with extra detail.\nWhy: came up after a session.',
      tags: ['workflow', 'autonomy'],
      confidence: 'high',
      repoPath: '/tmp/r',
      lastValidatedAt: '2026-05-01',
    }, { dir })

    const report = await consolidateMemories({ dir })
    assert.equal(report.dry_run, false)
    assert.equal(report.duplicate_groups, 1)
    assert.equal(report.removed, 1)
    assert.equal(report.groups[0]!.kept_id, 'b', 'newest updatedAt wins')
    assert.deepEqual(report.groups[0]!.removed_ids, ['a'])

    const remaining = await listMemories({ dir })
    assert.equal(remaining.length, 1)
    const merged = remaining[0]!
    assert.equal(merged.id, 'b')
    assert.equal(merged.confidence, 'high', 'max-rank confidence wins')
    assert.deepEqual(merged.tags, ['autonomy', 'workflow'], 'tags unioned + sorted')
    assert.equal(merged.lastValidatedAt, '2026-05-01')
    assert.match(merged.content, /Newer content with extra detail/)
    assert.match(merged.content, /Original content/, 'unique line from older entry preserved')
    assert.match(merged.content, /Why:/)

    const orphan = await loadMemory('a', { dir })
    assert.equal(orphan, null, 'older entry deleted from disk')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('consolidateMemories does NOT merge across different scope / repoPath / sessionId', async () => {
  const dir = await createMemoryDir()
  try {
    await saveMemory({
      id: 'r1',
      type: 'feedback', scope: 'repo', title: 'X', content: '1', repoPath: '/a',
    }, { dir })
    await saveMemory({
      id: 'r2',
      type: 'feedback', scope: 'repo', title: 'X', content: '2', repoPath: '/b',
    }, { dir })
    await saveMemory({
      id: 'g1',
      type: 'feedback', scope: 'global', title: 'X', content: '3',
    }, { dir })
    await saveMemory({
      id: 's1',
      type: 'feedback', scope: 'session', title: 'X', content: '4', sessionId: 'sess-1',
    }, { dir })
    await saveMemory({
      id: 's2',
      type: 'feedback', scope: 'session', title: 'X', content: '5', sessionId: 'sess-2',
    }, { dir })

    const report = await consolidateMemories({ dir })
    assert.equal(report.duplicate_groups, 0, 'every entry is uniquely keyed')
    assert.equal(report.removed, 0)
    const remaining = await listMemories({ dir })
    assert.equal(remaining.length, 5)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('consolidateMemories normalizes title whitespace + case for matching', async () => {
  const dir = await createMemoryDir()
  try {
    await saveMemory({
      id: 'a', type: 'feedback', scope: 'global',
      title: 'Migration  to V3', content: 'first',
    }, { dir })
    await new Promise((r) => setTimeout(r, 5))
    await saveMemory({
      id: 'b', type: 'feedback', scope: 'global',
      title: 'migration to v3', content: 'second',
    }, { dir })

    const report = await consolidateMemories({ dir })
    assert.equal(report.duplicate_groups, 1)
    assert.equal(report.removed, 1)
    assert.equal(report.groups[0]!.kept_id, 'b')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('consolidateMemories with embedder splits cluster below similarity threshold', async () => {
  const dir = await createMemoryDir()
  try {
    await saveMemory({
      id: 'a', type: 'feedback', scope: 'global',
      title: 'Same Title', content: 'cats are great',
    }, { dir })
    await new Promise((r) => setTimeout(r, 5))
    await saveMemory({
      id: 'b', type: 'feedback', scope: 'global',
      title: 'Same Title', content: 'unrelated quantum mechanics notes',
    }, { dir })

    // Stub embedder: returns orthogonal vectors so cosine ≈ 0 → below 0.5
    // → entries should NOT be merged even though identity keys match.
    const embedder: EmbedderLike = {
      embed: async (text: string) => (text.includes('quantum') ? [0, 1] : [1, 0]),
    }

    const report = await consolidateMemories({ dir, embedder, similarityThreshold: 0.5 })
    assert.equal(report.duplicate_groups, 0, 'embedder gate prevented merge')
    assert.equal((await listMemories({ dir })).length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('consolidateMemories with embedder keeps cluster when similarity passes threshold', async () => {
  const dir = await createMemoryDir()
  try {
    await saveMemory({
      id: 'a', type: 'feedback', scope: 'global',
      title: 'Same Title', content: 'cats are great',
    }, { dir })
    await new Promise((r) => setTimeout(r, 5))
    await saveMemory({
      id: 'b', type: 'feedback', scope: 'global',
      title: 'Same Title', content: 'cats are wonderful',
    }, { dir })

    // Stub embedder: returns the same vector → cosine = 1 ≥ threshold.
    const embedder: EmbedderLike = {
      embed: async () => [1, 0],
    }

    const report = await consolidateMemories({ dir, embedder, similarityThreshold: 0.9 })
    assert.equal(report.duplicate_groups, 1)
    assert.equal(report.removed, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('consolidateMemories preserves earliest createdAt across the cluster', async () => {
  const dir = await createMemoryDir()
  try {
    const earliest = await saveMemory({
      id: 'a', type: 'feedback', scope: 'global', title: 'T', content: 'old',
    }, { dir })
    await new Promise((r) => setTimeout(r, 10))
    await saveMemory({
      id: 'b', type: 'feedback', scope: 'global', title: 'T', content: 'newer',
    }, { dir })

    await consolidateMemories({ dir })
    const merged = await loadMemory('b', { dir })
    assert.ok(merged)
    assert.equal(merged!.createdAt, earliest.createdAt, 'audit history retained')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('consolidateMemories returns empty groups when no duplicates', async () => {
  const dir = await createMemoryDir()
  try {
    await saveMemory({
      id: 'only', type: 'feedback', scope: 'global', title: 'Solo', content: 'lonely',
    }, { dir })
    const report = await consolidateMemories({ dir })
    assert.equal(report.duplicate_groups, 0)
    assert.equal(report.removed, 0)
    assert.equal(report.scanned, 1)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
