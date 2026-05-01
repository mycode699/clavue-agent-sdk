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
      source: 'explicit user preference',
      lastValidatedAt: '2026-04-28',
    }, { dir })

    const result = await agent.run('continue workflow autonomy improvements')
    assert.match(provider.lastSystem, /# Relevant Memory/)
    assert.match(provider.lastSystem, /Minimize confirmations/)
    assert.match(provider.lastSystem, /autonomy, workflow/)
    assert.deepEqual(result.trace?.memory?.[0]?.selected_ids, ['pref-1'])
    assert.deepEqual(result.trace?.memory?.[0]?.selected, [{
      id: 'pref-1',
      type: 'feedback',
      scope: 'repo',
      title: 'Minimize confirmations',
      score: 12,
      score_reasons: ['repo_path', 'text:workflow', 'text:autonomy', 'confidence:high', 'validated'],
      validation_state: 'validated',
      tags: ['autonomy', 'workflow'],
      source: 'explicit user preference',
      confidence: 'high',
      last_validated_at: '2026-04-28',
      repo_path: '/tmp/repo-a',
      session_id: undefined,
    }])
    assert.equal(result.trace?.memory?.[0]?.policy, 'autoInject')
    assert.equal(result.trace?.memory?.[0]?.injected_count, 1)
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('memory policy off skips injection and traces retrieval policy', async () => {
  const dir = await createMemoryDir()
  const { Agent, saveMemory } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const
    public lastSystem = ''

    async createMessage(params: { system?: string }) {
      this.lastSystem = params.system || ''
      return {
        content: [{ type: 'text', text: 'memory-off response' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 8, output_tokens: 4 },
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
      policy: { mode: 'off' },
    },
  })
  ;(agent as any).provider = provider

  try {
    await saveMemory({
      id: 'pref-off',
      type: 'feedback',
      scope: 'repo',
      title: 'Hidden preference',
      content: 'This memory should not be injected when policy is off.',
      repoPath: '/tmp/repo-a',
      confidence: 'high',
    }, { dir })

    const result = await agent.run('continue workflow autonomy improvements')
    assert.doesNotMatch(provider.lastSystem, /# Relevant Memory/)
    assert.doesNotMatch(provider.lastSystem, /Hidden preference/)
    assert.equal(result.trace?.memory?.[0]?.policy, 'off')
    assert.equal(result.trace?.memory?.[0]?.injected_count, 0)
    assert.deepEqual(result.trace?.memory?.[0]?.selected_ids, [])
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('brainFirst memory policy injects before the first provider call and traces retrieval', async () => {
  const dir = await createMemoryDir()
  const { Agent, saveMemory } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const
    public calls = 0
    public firstSystem = ''

    async createMessage(params: { system?: string }) {
      this.calls++
      if (this.calls === 1) this.firstSystem = params.system || ''
      return {
        content: [{ type: 'text', text: 'brain-first response' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 4 },
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
      policy: { mode: 'brainFirst' },
    },
  })
  ;(agent as any).provider = provider

  try {
    await saveMemory({
      id: 'pref-brain-first',
      type: 'feedback',
      scope: 'repo',
      title: 'Brain-first preference',
      content: 'Retrieve memory before the first model call.',
      repoPath: '/tmp/repo-a',
      tags: ['memory'],
      confidence: 'high',
    }, { dir })

    const result = await agent.run('use brain-first memory preference')
    assert.equal(provider.calls, 1)
    assert.match(provider.firstSystem, /# Relevant Memory/)
    assert.match(provider.firstSystem, /Brain-first preference/)
    assert.equal(result.trace?.memory?.[0]?.policy, 'brainFirst')
    assert.equal(result.trace?.memory?.[0]?.retrieved_before_first_model_call, true)
    assert.deepEqual(result.trace?.memory?.[0]?.selected_ids, ['pref-brain-first'])
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('memory trace records retrieval reasons, validation state, injection status, and selection source', async () => {
  const dir = await createMemoryDir()
  const { Agent, saveMemory } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const

    async createMessage() {
      return {
        content: [{ type: 'text', text: 'memory trace response' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 4 },
      }
    }
  }

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [],
    memory: {
      enabled: true,
      dir,
      repoPath: '/tmp/repo-a',
      policy: { mode: 'brainFirst' },
    },
  })
  ;(agent as any).provider = new StubProvider()

  try {
    await saveMemory({
      id: 'pref-trace-details',
      type: 'feedback',
      scope: 'repo',
      title: 'Validated memory reasons',
      content: 'Use score reason trace fields.',
      repoPath: '/tmp/repo-a',
      tags: ['memory'],
      confidence: 'high',
      source: 'explicit user preference',
      lastValidatedAt: '2026-04-30',
    }, { dir })

    const result = await agent.run('use validated memory reasons')
    const memoryTrace = result.trace?.memory?.[0]

    assert.equal(memoryTrace?.injection_status, 'injected')
    assert.equal(memoryTrace?.selection_source, 'targeted')
    assert.equal(memoryTrace?.retrieval_steps?.[0]?.source, 'targeted')
    assert.equal(memoryTrace?.retrieval_steps?.[0]?.query, 'use validated memory reasons')
    assert.equal(memoryTrace?.retrieval_steps?.[0]?.repo_path, '/tmp/repo-a')
    assert.equal(memoryTrace?.retrieval_steps?.[0]?.candidate_count, 1)
    assert.equal(memoryTrace?.retrieval_steps?.[0]?.selected_count, 1)
    assert.deepEqual(memoryTrace?.selected?.[0]?.score_reasons, [
      'repo_path',
      'text:use',
      'text:validated',
      'text:memory',
      'text:reasons',
      'confidence:high',
      'validated',
    ])
    assert.equal(memoryTrace?.selected?.[0]?.validation_state, 'validated')
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('brainFirst memory trace records retrieval provenance, timing, filters, stale state, and redaction status', async () => {
  const dir = await createMemoryDir()
  const { Agent, saveMemory } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const

    async createMessage() {
      return {
        content: [{ type: 'text', text: 'rich memory trace response' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 4 },
      }
    }
  }

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [],
    memory: {
      enabled: true,
      dir,
      repoPath: '/tmp/repo-a',
      maxInjectedEntries: 1,
      policy: { mode: 'brainFirst' },
    },
  })
  ;(agent as any).provider = new StubProvider()

  try {
    await saveMemory({
      id: 'pref-rich-memory-trace',
      type: 'feedback',
      scope: 'repo',
      title: 'Rich memory trace',
      content: 'Use rich memory trace provenance before acting.',
      repoPath: '/tmp/repo-a',
      tags: ['memory', 'trace'],
      confidence: 'high',
      source: 'explicit user preference',
      lastValidatedAt: '2026-04-01',
    }, { dir })
    await saveMemory({
      id: 'pref-rich-memory-distractor',
      type: 'feedback',
      scope: 'repo',
      title: 'Memory distractor',
      content: 'A weaker memory trace distractor.',
      repoPath: '/tmp/repo-a',
      tags: ['memory'],
      confidence: 'medium',
    }, { dir })

    const result = await agent.run('use rich memory trace provenance')
    const memoryTrace = result.trace?.memory?.[0]
    const step = memoryTrace?.retrieval_steps?.[0]
    const selected = memoryTrace?.selected?.[0]

    assert.match(memoryTrace?.retrieval_id || '', /^memret_[a-f0-9-]+$/)
    assert.equal(memoryTrace?.strategy, 'brain_first')
    assert.ok(Number(memoryTrace?.duration_ms) >= 0)
    assert.equal(memoryTrace?.store?.configured, true)
    assert.equal(memoryTrace?.store?.dir, dir)
    assert.deepEqual(memoryTrace?.filters, {
      repo_path: '/tmp/repo-a',
      text: 'use rich memory trace provenance',
      limit: 1,
    })
    assert.equal(step?.candidate_count, 1)
    assert.equal(step?.selected_count, 1)
    assert.ok(Number(step?.duration_ms) >= 0)
    assert.deepEqual(step?.filters, memoryTrace?.filters)
    assert.equal(selected?.id, 'pref-rich-memory-trace')
    assert.equal(selected?.matched_fields?.includes('title'), true)
    assert.equal(selected?.matched_fields?.includes('content'), true)
    assert.equal(selected?.matched_fields?.includes('tags'), true)
    assert.deepEqual(selected?.score_components, [
      { reason: 'repo_path', score: 6 },
      { reason: 'text:use', score: 2 },
      { reason: 'text:rich', score: 2 },
      { reason: 'text:memory', score: 2 },
      { reason: 'text:trace', score: 2 },
      { reason: 'text:provenance', score: 2 },
      { reason: 'confidence:high', score: 1 },
      { reason: 'validated', score: 1 },
    ])
    assert.equal(selected?.stale, true)
    assert.equal(selected?.redaction_status, 'not_required')
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('brainFirst memory policy still injects when a custom system prompt is supplied', async () => {
  const dir = await createMemoryDir()
  const { Agent, saveMemory } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const
    public firstSystem = ''

    async createMessage(params: { system?: string }) {
      this.firstSystem = params.system || ''
      return {
        content: [{ type: 'text', text: 'custom prompt memory response' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 9, output_tokens: 4 },
      }
    }
  }

  const provider = new StubProvider()
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [],
    systemPrompt: 'Custom host instructions.',
    memory: {
      enabled: true,
      dir,
      repoPath: '/tmp/repo-a',
      policy: { mode: 'brainFirst' },
    },
  })
  ;(agent as any).provider = provider

  try {
    await saveMemory({
      id: 'pref-custom-system',
      type: 'feedback',
      scope: 'repo',
      title: 'Custom prompt memory',
      content: 'Custom system prompts still need memory context.',
      repoPath: '/tmp/repo-a',
      confidence: 'high',
    }, { dir })

    const result = await agent.run('use custom prompt memory')
    assert.match(provider.firstSystem, /Custom host instructions\./)
    assert.match(provider.firstSystem, /# Relevant Memory/)
    assert.match(provider.firstSystem, /Custom prompt memory/)
    assert.equal(result.trace?.memory?.[0]?.policy, 'brainFirst')
    assert.equal(result.trace?.memory?.[0]?.injection_status, 'injected')
    assert.equal(result.trace?.memory?.[0]?.retrieved_before_first_model_call, true)
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
