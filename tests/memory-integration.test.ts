import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function createMemoryDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-agent-sdk-memory-int-'))
}

test('query injects relevant memory into the system prompt', async () => {
  const dir = await createMemoryDir()
  const { Agent, saveMemory } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const
    public lastSystem = ''

    async createMessage(params: { system?: string }) {
      this.lastSystem = params.system || ''
      return {
        content: [{ type: 'text', text: 'memory-aware response' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 5 },
      }
    }
  }

  const provider = new StubProvider()
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [],
    memory: {
      enabled: true,
      dir,
      repoPath: '/tmp/repo-a',
      maxInjectedEntries: 3,
    },
  })
  ;(agent as any).provider = provider

  try {
    await saveMemory({
      id: 'pref-1',
      type: 'feedback',
      scope: 'repo',
      title: 'Minimize confirmations',
      content: 'Keep moving unless an action is destructive or changes shared state.',
      repoPath: '/tmp/repo-a',
      tags: ['workflow', 'autonomy'],
      confidence: 'high',
    }, { dir })

    await agent.prompt('continue workflow autonomy improvements')
    assert.match(provider.lastSystem, /# Relevant Memory/)
    assert.match(provider.lastSystem, /Minimize confirmations/)
    assert.match(provider.lastSystem, /autonomy, workflow/)
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('close auto-saves a session summary memory entry when enabled', async () => {
  const dir = await createMemoryDir()
  const { Agent, loadMemory } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const

    async createMessage() {
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 },
      }
    }
  }

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [],
    sessionId: 'session-memory-test',
    memory: {
      enabled: true,
      dir,
      repoPath: '/tmp/repo-a',
      autoSaveSessionSummary: true,
    },
  })
  ;(agent as any).provider = new StubProvider()

  try {
    await agent.prompt('Remember that we prefer concise responses')
  } finally {
    await agent.close()
  }

  const saved = await loadMemory('session-session-memory-test', { dir })
  assert.equal(saved?.scope, 'session')
  assert.equal(saved?.type, 'decision')
  assert.match(saved?.content || '', /Remember that we prefer concise responses/)

  await rm(dir, { recursive: true, force: true })
})

test('close auto-extracts durable repo memories from user messages', async () => {
  const dir = await createMemoryDir()
  const { Agent, queryMemories } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const

    async createMessage() {
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 4, output_tokens: 2 },
      }
    }
  }

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [],
    sessionId: 'session-memory-extract',
    memory: {
      enabled: true,
      dir,
      repoPath: '/tmp/repo-a',
      autoSaveSessionSummary: true,
    },
  })
  ;(agent as any).provider = new StubProvider()

  try {
    await agent.prompt('Remember that we prefer concise responses. Use the OpenAI-compatible provider instead of Anthropic for this repo.')
  } finally {
    await agent.close()
  }

  const feedback = await queryMemories({
    repoPath: '/tmp/repo-a',
    type: 'feedback',
    text: 'concise responses',
    limit: 5,
  }, { dir })
  const decision = await queryMemories({
    repoPath: '/tmp/repo-a',
    type: 'decision',
    text: 'OpenAI-compatible provider instead of Anthropic',
    limit: 5,
  }, { dir })

  assert.equal(feedback[0]?.scope, 'repo')
  assert.equal(feedback[0]?.title, 'Prefer concise responses')
  assert.equal(feedback[0]?.sessionId, 'session-memory-extract')
  assert.ok(feedback[0]?.tags?.includes('concise'))
  assert.equal(decision[0]?.scope, 'repo')
  assert.equal(decision[0]?.title, 'Use OpenAI-compatible provider')
  assert.equal(decision[0]?.confidence, 'high')
  assert.ok(decision[0]?.tags?.includes('openai'))

  await rm(dir, { recursive: true, force: true })
})
