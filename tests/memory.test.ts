import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function createMemoryDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-agent-sdk-memory-'))
}

test('saveMemory and loadMemory persist structured entries', async () => {
  const dir = await createMemoryDir()
  const {
    saveMemory,
    loadMemory,
    getMemoryStoreInfo,
  } = await import('../src/index.ts')

  try {
    const saved = await saveMemory(
      {
        id: 'user-preference-1',
        type: 'feedback',
        scope: 'repo',
        title: 'Minimize confirmation prompts',
        content: 'Default to continuous execution and only stop for destructive or branching decisions.',
        tags: ['user', 'autonomy', 'workflow'],
        confidence: 'high',
        repoPath: '/tmp/repo-a',
        source: 'explicit user request',
        lastValidatedAt: '2026-04-24',
      },
      { dir },
    )

    const loaded = await loadMemory('user-preference-1', { dir })
    const info = await getMemoryStoreInfo({ dir })

    assert.equal(saved.id, 'user-preference-1')
    assert.deepEqual(saved.tags, ['autonomy', 'user', 'workflow'])
    assert.equal(loaded?.title, 'Minimize confirmation prompts')
    assert.equal(loaded?.confidence, 'high')
    assert.equal(info.count, 1)
    assert.equal(info.dir, dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('queryMemories ranks repo and text matches ahead of unrelated memories', async () => {
  const dir = await createMemoryDir()
  const {
    saveMemory,
    queryMemories,
    listMemories,
    deleteMemory,
  } = await import('../src/index.ts')

  try {
    await saveMemory(
      {
        id: 'repo-decision-1',
        type: 'decision',
        scope: 'repo',
        title: 'Prefer bundled PRs',
        content: 'For this repo, one bundled PR is better than splitting related refactors.',
        tags: ['pr', 'workflow'],
        repoPath: '/tmp/repo-a',
        confidence: 'high',
      },
      { dir },
    )

    await saveMemory(
      {
        id: 'repo-reference-1',
        type: 'reference',
        scope: 'repo',
        title: 'Latency dashboard',
        content: 'Grafana board for request latency incidents.',
        tags: ['grafana', 'latency'],
        repoPath: '/tmp/repo-b',
        confidence: 'medium',
      },
      { dir },
    )

    await saveMemory(
      {
        id: 'global-user-1',
        type: 'user',
        scope: 'global',
        title: 'Backend-focused user',
        content: 'User has deep backend experience and prefers concise explanations.',
        tags: ['user', 'backend'],
        confidence: 'medium',
      },
      { dir },
    )

    const repoResults = await queryMemories(
      {
        repoPath: '/tmp/repo-a',
        text: 'bundled PR workflow',
        limit: 5,
      },
      { dir },
    )

    const tagResults = await queryMemories(
      {
        type: ['user', 'feedback', 'decision'],
        tags: ['workflow'],
        limit: 5,
      },
      { dir },
    )

    const all = await listMemories({ dir })
    const deleted = await deleteMemory('repo-reference-1', { dir })
    const afterDelete = await listMemories({ dir })

    assert.equal(repoResults[0]?.id, 'repo-decision-1')
    assert.equal(tagResults[0]?.id, 'repo-decision-1')
    assert.equal(all.length, 3)
    assert.equal(deleted, true)
    assert.equal(afterDelete.length, 2)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('queryMemories includes partial text matches so operational lessons can be recalled', async () => {
  const dir = await createMemoryDir()
  const {
    saveMemory,
    queryMemories,
  } = await import('../src/index.ts')

  try {
    await saveMemory(
      {
        id: 'improvement-1',
        type: 'improvement',
        scope: 'repo',
        title: 'Tool failure: Bash',
        content: 'Tool Bash returned a timeout while running package verification.',
        tags: ['self-improvement', 'tool-failure'],
        repoPath: '/tmp/repo-a',
        confidence: 'medium',
      },
      { dir },
    )

    const results = await queryMemories(
      {
        repoPath: '/tmp/repo-a',
        text: 'future task should remember bash timeout verification',
        limit: 5,
      },
      { dir },
    )

    assert.equal(results[0]?.id, 'improvement-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('extractSessionMemoryCandidates identifies durable feedback and decisions from user messages', async () => {
  const {
    extractSessionMemoryCandidates,
  } = await import('../src/index.ts')

  const candidates = extractSessionMemoryCandidates(
    [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-04-23T00:00:00.000Z',
        message: {
          role: 'user',
          content: 'Remember that we prefer concise responses. Use the OpenAI-compatible provider instead of Anthropic for this repo.',
        },
      },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: '2026-04-23T00:00:01.000Z',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'acknowledged' }],
        },
      },
    ],
    {
      repoPath: '/tmp/repo-a',
      sessionId: 'session-1',
    },
  )

  assert.equal(candidates.length, 2)
  assert.deepEqual(
    candidates.map((candidate) => candidate.type),
    ['feedback', 'decision'],
  )
  assert.equal(candidates[0]?.title, 'Prefer concise responses')
  assert.equal(candidates[0]?.repoPath, '/tmp/repo-a')
  assert.equal(candidates[0]?.sessionId, 'session-1')
  assert.ok(candidates[0]?.tags?.includes('concise'))
  assert.equal(candidates[1]?.title, 'Use OpenAI-compatible provider')
  assert.ok(candidates[1]?.tags?.includes('openai'))
  assert.equal(candidates[1]?.confidence, 'high')
})
