import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function createMemoryDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-agent-sdk-improvement-'))
}

test('CLI env self-improvement applies memory defaults like the flag', async () => {
  const { parseArgs } = await import('../src/cli.ts')
  const cwd = join(tmpdir(), 'clavue-agent-sdk-cli-cwd')

  const fromEnv = parseArgs(['--cwd', cwd, 'review release'], {
    CLAVUE_AGENT_SELF_IMPROVEMENT: 'true',
  })
  const fromFlag = parseArgs(['--cwd', cwd, '--self-improvement', 'review release'], {})

  assert.equal(fromEnv.options.selfImprovement, true)
  assert.deepEqual(fromEnv.options.memory, fromFlag.options.memory)
  assert.equal(fromEnv.options.memory?.enabled, true)
  assert.equal(fromEnv.options.memory?.autoInject, true)
  assert.equal(fromEnv.options.memory?.repoPath, cwd)
})

test('CLI parses named toolsets', async () => {
  const { parseArgs } = await import('../src/cli.ts')

  const parsed = parseArgs(['--toolset', 'repo-readonly,research', 'review release'], {})

  assert.deepEqual(parsed.options.toolsets, ['repo-readonly', 'research'])
})

test('CLI parses autonomy mode from env and flag', async () => {
  const { parseArgs } = await import('../src/cli.ts')

  const fromEnv = parseArgs(['review release'], {
    CLAVUE_AGENT_AUTONOMY: 'autonomous',
  })
  const fromFlag = parseArgs(['--autonomy', 'proactive', 'review release'], {
    CLAVUE_AGENT_AUTONOMY: 'supervised',
  })

  assert.equal(fromEnv.options.autonomyMode, 'autonomous')
  assert.equal(fromFlag.options.autonomyMode, 'proactive')
})

test('CLI parses permission mode from env and flag', async () => {
  const { parseArgs } = await import('../src/cli.ts')

  const fromEnv = parseArgs(['review release'], {
    CLAVUE_AGENT_PERMISSION_MODE: 'acceptEdits',
  })
  const fromFlag = parseArgs(['--permission-mode', 'trustedAutomation', 'review release'], {
    CLAVUE_AGENT_PERMISSION_MODE: 'default',
  })

  assert.equal(fromEnv.options.permissionMode, 'acceptEdits')
  assert.equal(fromFlag.options.permissionMode, 'trustedAutomation')
})

test('CLI rejects unknown autonomy mode', async () => {
  const { parseArgs } = await import('../src/cli.ts')

  assert.throws(
    () => parseArgs(['--autonomy', 'reckless', 'review release'], {}),
    /--autonomy must be supervised, proactive, or autonomous/,
  )
})

test('CLI rejects unknown permission mode', async () => {
  const { parseArgs } = await import('../src/cli.ts')

  assert.throws(
    () => parseArgs(['--permission-mode', 'reckless', 'review release'], {}),
    /--permission-mode must be trustedAutomation, auto, default, acceptEdits, dontAsk, bypassPermissions, or plan/,
  )
})

test('CLI rejects unknown toolsets', async () => {
  const { parseArgs } = await import('../src/cli.ts')

  assert.throws(
    () => parseArgs(['--toolset', 'unknown', 'review release'], {}),
    /Unknown toolset: unknown/,
  )
})

test('extractRunImprovementCandidates captures failed tool signals without secrets', async () => {
  const { extractRunImprovementCandidates } = await import('../src/index.ts')
  type AgentRunResult = import('../src/index.ts').AgentRunResult

  const run: AgentRunResult = {
    id: 'run-1',
    session_id: 'session-1',
    status: 'completed',
    subtype: 'success',
    text: 'done',
    usage: { input_tokens: 1, output_tokens: 1 },
    num_turns: 1,
    duration_ms: 10,
    duration_api_ms: 5,
    total_cost_usd: 0,
    stop_reason: null,
    started_at: '2026-04-25T00:00:00.000Z',
    completed_at: '2026-04-25T00:00:01.000Z',
    messages: [
      {
        type: 'user',
        uuid: 'u1',
        timestamp: '2026-04-25T00:00:00.000Z',
        message: { role: 'user', content: 'verify package release' },
      },
    ],
    events: [
      {
        type: 'tool_result',
        result: {
          tool_use_id: 'toolu-1',
          tool_name: 'Bash',
          output: 'Error: command failed with api_key=sk-secretsecret123456',
        },
      },
    ],
  }

  const candidates = extractRunImprovementCandidates(run, {}, {
    cwd: '/tmp/repo-a',
    sessionId: 'session-1',
  })

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.type, 'improvement')
  assert.equal(candidates[0]?.title, 'Tool failure: Bash')
  assert.match(candidates[0]?.content || '', /verify package release/)
  assert.match(candidates[0]?.content || '', /\[REDACTED\]/)
  assert.doesNotMatch(candidates[0]?.content || '', /sk-secretsecret/)
})

test('runSelfImprovement persists capped improvement memories', async () => {
  const dir = await createMemoryDir()
  const { runSelfImprovement, queryMemories } = await import('../src/index.ts')
  type AgentRunResult = import('../src/index.ts').AgentRunResult

  const run: AgentRunResult = {
    id: 'run-2',
    session_id: 'session-2',
    status: 'errored',
    subtype: 'error_max_turns',
    text: '',
    usage: { input_tokens: 1, output_tokens: 1 },
    num_turns: 10,
    duration_ms: 10,
    duration_api_ms: 5,
    total_cost_usd: 0,
    stop_reason: null,
    started_at: '2026-04-25T00:00:00.000Z',
    completed_at: '2026-04-25T00:00:01.000Z',
    messages: [
      {
        type: 'user',
        uuid: 'u2',
        timestamp: '2026-04-25T00:00:00.000Z',
        message: { role: 'user', content: 'finish automation loop' },
      },
    ],
    events: [],
    errors: ['max turns reached'],
  }

  try {
    const result = await runSelfImprovement(run, {
      memory: {
        dir,
        repoPath: '/tmp/repo-a',
        maxEntriesPerRun: 1,
      },
    }, {
      cwd: '/tmp/repo-a',
      sessionId: 'session-2',
    })

    const memories = await queryMemories({
      repoPath: '/tmp/repo-a',
      type: 'improvement',
      text: 'automation loop error_max_turns',
      limit: 5,
    }, { dir })

    assert.equal(result.savedMemories.length, 1)
    assert.equal(memories.length, 1)
    assert.equal(memories[0]?.title, 'Run ended with error_max_turns')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runSelfImprovement can include skill retro evaluators in self-improvement cycles', async () => {
  const dir = await createMemoryDir()
  const { runSelfImprovement, createSkillManifest } = await import('../src/index.ts')
  type AgentRunResult = import('../src/index.ts').AgentRunResult

  const run: AgentRunResult = {
    id: 'run-skill-retro-1',
    session_id: 'session-skill-retro-1',
    status: 'completed',
    subtype: 'success',
    text: 'done',
    usage: { input_tokens: 1, output_tokens: 1 },
    num_turns: 1,
    duration_ms: 10,
    duration_api_ms: 5,
    total_cost_usd: 0,
    stop_reason: null,
    started_at: '2026-04-25T00:00:00.000Z',
    completed_at: '2026-04-25T00:00:01.000Z',
    messages: [],
    events: [],
  }

  try {
    const result = await runSelfImprovement(run, {
      memory: { enabled: false },
      retro: {
        enabled: true,
        targetName: 'skill-retro-target',
        cwd: dir,
        ledger: { dir },
        skills: [createSkillManifest({
          name: 'Draft Skill',
          description: 'Incomplete draft skill fixture.',
          allowedTools: ['Read'],
          qualityGates: ['manual-review'],
        })],
      },
    }, {
      cwd: dir,
      sessionId: 'session-skill-retro-1',
    })

    assert.equal(result.retroCycle?.trace.skillTargetCount, 1)
    assert.equal(result.retroCycle?.run.run_metadata.skillTargetCount, 1)
    assert.ok(result.retroCycle?.run.findings.some((finding) => finding.title === 'Skill prompt process metadata is incomplete'))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runSelfImprovement returns retroLoop when bounded loop is enabled', async () => {
  const dir = await createMemoryDir()
  const { runSelfImprovement, loadRetroCycle } = await import('../src/index.ts')
  type AgentRunResult = import('../src/index.ts').AgentRunResult

  const run: AgentRunResult = {
    id: 'run-loop-1',
    session_id: 'session-loop-1',
    status: 'completed',
    subtype: 'success',
    text: 'done',
    usage: { input_tokens: 1, output_tokens: 1 },
    num_turns: 1,
    duration_ms: 10,
    duration_api_ms: 5,
    total_cost_usd: 0,
    stop_reason: null,
    started_at: '2026-04-25T00:00:00.000Z',
    completed_at: '2026-04-25T00:00:01.000Z',
    messages: [],
    events: [],
  }

  try {
    const result = await runSelfImprovement(run, {
      memory: { enabled: false },
      retro: {
        enabled: true,
        targetName: 'loop-target',
        cwd: dir,
        ledger: { dir },
        gates: [
          {
            name: 'verify-ok',
            command: 'node',
            args: ['-e', 'process.stdout.write("ok")'],
          },
        ],
        loop: {
          enabled: true,
          maxAttempts: 2,
        },
      },
    }, {
      cwd: dir,
      sessionId: 'session-loop-1',
    })

    assert.ok(result.retroLoop)
    assert.equal(result.retroLoop?.summary.completedAttempts, 2)
    assert.equal(result.retroCycle, result.retroLoop?.finalCycle)

    const savedCycle = await loadRetroCycle(result.retroLoop?.finalCycle.savedCycleId || '', { dir })
    assert.equal(savedCycle?.trace.sourceRunId, 'run-loop-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('runSelfImprovement passes retry hook results through retro loop', async () => {
  const dir = await createMemoryDir()
  const { runSelfImprovement } = await import('../src/index.ts')
  type AgentRunResult = import('../src/index.ts').AgentRunResult

  const run: AgentRunResult = {
    id: 'run-loop-2',
    session_id: 'session-loop-2',
    status: 'completed',
    subtype: 'success',
    text: 'done',
    usage: { input_tokens: 1, output_tokens: 1 },
    num_turns: 1,
    duration_ms: 10,
    duration_api_ms: 5,
    total_cost_usd: 0,
    stop_reason: null,
    started_at: '2026-04-25T00:00:00.000Z',
    completed_at: '2026-04-25T00:00:01.000Z',
    messages: [],
    events: [],
  }
  let retryCalls = 0

  try {
    const result = await runSelfImprovement(run, {
      memory: { enabled: false },
      retro: {
        enabled: true,
        targetName: 'loop-target',
        cwd: dir,
        ledger: { dir },
        gates: [
          {
            name: 'verify-ok',
            command: 'node',
            args: ['-e', 'process.stdout.write("ok")'],
          },
        ],
        policy: {
          allowedActions: ['attempt_fix'],
        },
        loop: {
          enabled: true,
          maxAttempts: 2,
        },
      },
    }, {
      cwd: dir,
      sessionId: 'session-loop-2',
      onAttemptRetry: () => {
        retryCalls += 1
        return {
          summary: 'retry produced a new source run',
          sourceRun: {
            id: 'run-loop-2-retry',
            session_id: 'session-loop-2',
            status: 'completed',
            subtype: 'success',
            started_at: '2026-04-25T00:00:02.000Z',
            completed_at: '2026-04-25T00:00:03.000Z',
            duration_ms: 20,
            duration_api_ms: 10,
            total_cost_usd: 0,
            num_turns: 1,
            stop_reason: null,
            usage: { input_tokens: 2, output_tokens: 2 },
          },
        }
      },
    })

    assert.equal(retryCalls, 1)
    assert.equal(result.retroLoop?.summary.completedAttempts, 2)
    assert.equal(result.retroLoop?.cycles[0]?.retryStep?.sourceRun?.id, 'run-loop-2-retry')
    assert.equal(result.retroLoop?.finalCycle.trace.sourceRunId, 'run-loop-2-retry')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('Agent.run executes retro loop retries with nested self-improvement disabled', async () => {
  const dir = await createMemoryDir()
  const { Agent } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const

    async createMessage() {
      return {
        content: [{ type: 'text', text: 'stub response' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    }
  }

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [],
  })
  ;(agent as any).provider = new StubProvider()

  const originalRun = agent.run.bind(agent)
  const calls: Array<{ text: string; selfImprovement: unknown }> = []
  agent.run = async (text, overrides) => {
    calls.push({ text, selfImprovement: overrides?.selfImprovement })
    return originalRun(text, overrides)
  }

  try {
    const run = await agent.run('initial prompt', {
      selfImprovement: {
        memory: { enabled: false },
        retro: {
          enabled: true,
          targetName: 'loop-target',
          cwd: dir,
          ledger: { dir },
          gates: [
            {
              name: 'verify-ok',
              command: 'node',
              args: ['-e', 'process.stdout.write("ok")'],
            },
          ],
          policy: {
            allowedActions: ['attempt_fix'],
          },
          loop: {
            enabled: true,
            maxAttempts: 2,
            retryPrompt: 'retry prompt',
          },
        },
      },
    })

    assert.ok(run.self_improvement?.retroLoop)
    assert.equal(calls.length, 2)
    assert.equal(calls[0]?.text, 'initial prompt')
    assert.equal(calls[1]?.text, 'retry prompt')
    assert.equal(calls[1]?.selfImprovement, false)
    assert.ok(run.self_improvement?.retroLoop?.cycles[0]?.retryStep?.sourceRun?.id)
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test('Agent.run attaches self-improvement artifacts when enabled', async () => {
  const dir = await createMemoryDir()
  const { Agent, queryMemories } = await import('../src/index.ts')

  class StubProvider {
    readonly apiType = 'openai-completions' as const

    async createMessage() {
      return {
        content: [{ type: 'tool_use', id: 'toolu-1', name: 'FailingTool', input: {} }],
        stopReason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    }
  }

  const failingTool = {
    name: 'FailingTool',
    description: 'Always returns a failure result',
    inputSchema: { type: 'object' as const, properties: {} },
    call: async () => ({
      type: 'tool_result' as const,
      tool_use_id: 'toolu-1',
      content: 'Error: deterministic failure',
      is_error: true,
    }),
  }

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [failingTool],
    maxTurns: 1,
    memory: {
      enabled: true,
      dir,
      repoPath: '/tmp/repo-a',
    },
    selfImprovement: {
      memory: {
        dir,
        repoPath: '/tmp/repo-a',
      },
    },
  })
  ;(agent as any).provider = new StubProvider()

  try {
    const run = await agent.run('trigger failing tool')
    assert.ok(run.self_improvement)
    assert.ok((run.self_improvement?.savedMemories.length || 0) > 0)

    const memories = await queryMemories({
      repoPath: '/tmp/repo-a',
      type: 'improvement',
      text: 'FailingTool deterministic failure',
      limit: 5,
    }, { dir })

    assert.ok(memories.some((memory) => memory.title === 'Tool failure: FailingTool'))
  } finally {
    await agent.close()
    await rm(dir, { recursive: true, force: true })
  }
})
