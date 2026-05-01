import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  Agent,
  SDK_EVENT_SCHEMA_VERSION,
  AGENT_RUN_RESULT_SCHEMA_VERSION,
  AGENT_RUN_TRACE_SCHEMA_VERSION,
  AGENT_JOB_RECORD_SCHEMA_VERSION,
  MEMORY_TRACE_SCHEMA_VERSION,
  createAgentJob,
  getAgentJob,
  getControlledExecutionContract,
} from '../src/index.ts'

class TextOnlyProvider {
  readonly apiType = 'openai-completions' as const

  async createMessage() {
    return {
      content: [{ type: 'text' as const, text: 'schema stable' }],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 3, output_tokens: 2 },
    }
  }
}

class OneToolProvider {
  readonly apiType = 'openai-completions' as const
  private calls = 0

  async createMessage() {
    this.calls += 1
    if (this.calls === 1) {
      return {
        content: [{ type: 'tool_use' as const, id: 'tool-1', name: 'capture', input: { value: 'phase order' } }],
        stopReason: 'tool_use' as const,
        usage: { input_tokens: 4, output_tokens: 3 },
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'tool complete' }],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 5, output_tokens: 4 },
    }
  }
}

test('text-only runs include schema metadata on final event and run result', async () => {
  const agent = new Agent({ model: 'gpt-5.4', tools: [] })
  ;(agent as any).provider = new TextOnlyProvider()

  try {
    const result = await agent.run('Say hello')
    const finalEvent = result.events.find((event) => event.type === 'result')

    assert.equal(finalEvent?.type, 'result')
    assert.equal(finalEvent.schema_version, SDK_EVENT_SCHEMA_VERSION)
    assert.equal(result.schema_version, AGENT_RUN_RESULT_SCHEMA_VERSION)
    assert.equal(result.trace?.schema_version, AGENT_RUN_TRACE_SCHEMA_VERSION)
    assert.equal(finalEvent.trace?.schema_version, AGENT_RUN_TRACE_SCHEMA_VERSION)
    assert.equal(result.trace?.memory?.[0]?.schema_version, MEMORY_TRACE_SCHEMA_VERSION)
  } finally {
    await agent.close()
  }
})

test('one-tool runs emit additive phase events in lifecycle order', async () => {
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [{
      name: 'capture',
      description: 'Capture a value for phase event testing',
      inputSchema: {
        type: 'object',
        properties: { value: { type: 'string' } },
        required: ['value'],
      },
      call: async () => ({
        type: 'tool_result' as const,
        tool_use_id: 'tool-1',
        content: 'captured',
      }),
    }],
  })
  ;(agent as any).provider = new OneToolProvider()

  try {
    const events = []
    for await (const event of agent.query('Use the capture tool')) {
      events.push(event)
    }

    const phases = events
      .filter((event) => event.type === 'system' && event.subtype === 'phase')
      .map((event) => ({ phase: event.phase, tool_use_id: event.tool_use_id }))

    assert.equal(events[0]?.type, 'system')
    assert.equal(events[0]?.subtype, 'init')
    assert.deepEqual(phases.map((event) => event.phase), [
      'intake',
      'context',
      'model_request',
      'model_response',
      'tool_execution',
      'model_request',
      'model_response',
      'verification',
      'finalize',
    ])
    assert.equal(phases.find((event) => event.phase === 'tool_execution')?.tool_use_id, 'tool-1')
    assert.ok(events.every((event) => event.type !== 'system' || event.subtype !== 'phase' || event.run_id))
  } finally {
    await agent.close()
  }
})

test('controlled execution contract exposes public schema versions', () => {
  assert.deepEqual(getControlledExecutionContract().schemaVersions, {
    sdk_event: SDK_EVENT_SCHEMA_VERSION,
    agent_run_result: AGENT_RUN_RESULT_SCHEMA_VERSION,
    agent_run_trace: AGENT_RUN_TRACE_SCHEMA_VERSION,
    agent_job_record: AGENT_JOB_RECORD_SCHEMA_VERSION,
    memory_trace: MEMORY_TRACE_SCHEMA_VERSION,
  })
})

test('agent jobs add schema metadata while old stored jobs remain readable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-agent-sdk-event-schema-'))
  try {
    const options = { dir, runtimeNamespace: 'event-schema-test', staleAfterMs: -1 }
    const job = await createAgentJob({ kind: 'subagent', prompt: 'new job' }, options)
    assert.equal(job.schema_version, AGENT_JOB_RECORD_SCHEMA_VERSION)
    assert.equal((await getAgentJob(job.id, options))?.schema_version, AGENT_JOB_RECORD_SCHEMA_VERSION)

    const oldJobId = 'legacy_agent_job'
    const namespace = Buffer.from(options.runtimeNamespace, 'utf8').toString('base64url')
    await writeFile(join(dir, namespace, `${oldJobId}.json`), JSON.stringify({
      id: oldJobId,
      kind: 'subagent',
      status: 'completed',
      runtimeNamespace: options.runtimeNamespace,
      prompt: 'old job',
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
    }), 'utf-8')

    const oldJob = await getAgentJob(oldJobId, options)
    assert.equal(oldJob?.id, oldJobId)
    assert.equal(oldJob?.schema_version, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
