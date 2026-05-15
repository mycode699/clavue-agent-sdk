/**
 * Tier A #1 — `tool_cache` TraceEvent contract.
 *
 * Locks three things that round-5 must keep stable:
 *   1. `TraceStore.appendToolCache` writes a `kind: 'tool_cache'`
 *      event with the documented payload + `tool:<name>` spanId.
 *   2. `eventToOtelSpan` maps the event to a `tool.cache.<outcome>`
 *      span with `tool.cache.outcome` + `tool.use_id` attributes.
 *   3. The engine emits one event per cacheable dispatch (hit OR
 *      miss), and zero events for non-cacheable tools.
 *
 * Together these give OTel/JSONL consumers per-call cache visibility
 * to complement the `AgentRunTrace.tool_cache` aggregate.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TraceStore,
  eventToOtelSpan,
  JsonlExporter,
} from '../src/tracing/index.ts'
import type { ToolCacheEventData } from '../src/tracing/index.ts'
import { Agent } from '../src/index.ts'
import type {
  CreateMessageParams,
  CreateMessageResponse,
  LLMProvider,
  ToolDefinition,
} from '../src/index.ts'

class StubProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  calls: CreateMessageParams[] = []
  constructor(private readonly responses: CreateMessageResponse[]) {}
  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.calls.push(params)
    return this.responses.shift() ?? {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

function readKvTool(counter: { calls: number }): ToolDefinition {
  return {
    name: 'read_kv',
    description: 'Read a key.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async (input: any) => {
      counter.calls++
      return { type: 'tool_result', tool_use_id: '', content: `value-for-${input.key}` }
    },
  }
}

function readsResponse(blocks: Array<{ id: string; input: unknown }>): CreateMessageResponse {
  return {
    content: blocks.map((b) => ({ type: 'tool_use', id: b.id, name: 'read_kv', input: b.input })),
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

function textResponse(text: string): CreateMessageResponse {
  return {
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
}

test('TraceStore.appendToolCache writes kind=tool_cache with tool:<name> spanId', () => {
  const store = new TraceStore()
  const runId = store.startRun()
  const idx = store.appendToolCache({ toolName: 'read_kv', toolUseId: 't-1', outcome: 'miss' })
  assert.equal(idx, 0)

  const events = store.query(runId, { kinds: ['tool_cache'] })
  assert.equal(events.length, 1)
  const evt = events[0]!
  assert.equal(evt.kind, 'tool_cache')
  assert.equal(evt.spanId, 'tool:read_kv')
  const payload = evt.data as ToolCacheEventData
  assert.equal(payload.toolName, 'read_kv')
  assert.equal(payload.toolUseId, 't-1')
  assert.equal(payload.outcome, 'miss')
})

test('eventToOtelSpan maps tool_cache to tool.cache.<outcome> with documented attributes', () => {
  const span = eventToOtelSpan({
    kind: 'tool_cache',
    at: 100,
    runId: 'run_x',
    spanId: 'tool:read_kv',
    data: { toolName: 'read_kv', toolUseId: 't-2', outcome: 'hit' } satisfies ToolCacheEventData,
  })
  assert.equal(span.name, 'tool.cache.hit')
  assert.equal(span.traceId, 'run_x')
  assert.equal(span.spanId, 'tool:read_kv')
  assert.equal(span.attributes['tool.name'], 'read_kv')
  assert.equal(span.attributes['tool.cache.outcome'], 'hit')
  assert.equal(span.attributes['tool.use_id'], 't-2')

  const miss = eventToOtelSpan({
    kind: 'tool_cache',
    at: 100,
    runId: 'run_x',
    data: { toolName: 'read_kv', toolUseId: 't-3', outcome: 'miss' } satisfies ToolCacheEventData,
  })
  assert.equal(miss.name, 'tool.cache.miss')
  assert.equal(miss.attributes['tool.cache.outcome'], 'miss')
})

test('engine emits one tool_cache event per cacheable dispatch (1 miss + 1 hit)', async () => {
  const counter = { calls: 0 }
  const tool = readKvTool(counter)
  const store = new TraceStore()
  const runId = store.startRun({}, 'engine-cache-run-1')

  const provider = new StubProvider([
    readsResponse([
      { id: 't-1', input: { key: 'k' } },
      { id: 't-2', input: { key: 'k' } }, // duplicate → cache hit
    ]),
    textResponse('done'),
  ])

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool], trace: store })
  ;(agent as any).provider = provider

  try {
    await agent.run('go')
    assert.equal(counter.calls, 1)
    const events = store.query(runId, { kinds: ['tool_cache'] })
    assert.equal(events.length, 2, 'one event per cacheable dispatch')
    const outcomes = events.map((e) => (e.data as ToolCacheEventData).outcome)
    assert.deepEqual(outcomes, ['miss', 'hit'])
    const ids = events.map((e) => (e.data as ToolCacheEventData).toolUseId)
    assert.deepEqual(ids, ['t-1', 't-2'])
  } finally {
    await agent.close()
  }
})

test('engine emits no tool_cache event for non-cacheable tools', async () => {
  const counter = { calls: 0 }
  // No isReadOnly / isConcurrencySafe → bypass.
  const tool: ToolDefinition = {
    name: 'mutate',
    description: 'mutate',
    inputSchema: { type: 'object', properties: { k: { type: 'string' } }, required: ['k'] },
    call: async (input: any) => {
      counter.calls++
      return { type: 'tool_result', tool_use_id: '', content: `wrote-${input.k}` }
    },
  }
  const store = new TraceStore()
  const runId = store.startRun({}, 'engine-cache-run-2')

  const provider = new StubProvider([
    {
      content: [
        { type: 'tool_use', id: 't-1', name: 'mutate', input: { k: 'a' } },
        { type: 'tool_use', id: 't-2', name: 'mutate', input: { k: 'a' } },
      ],
      stopReason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    textResponse('done'),
  ])

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool], trace: store })
  ;(agent as any).provider = provider

  try {
    await agent.run('go')
    assert.equal(counter.calls, 2)
    const events = store.query(runId, { kinds: ['tool_cache'] })
    assert.equal(events.length, 0, 'non-cacheable tools must not emit tool_cache events')
  } finally {
    await agent.close()
  }
})

test('JsonlExporter receives tool.cache spans correlated to tool:<name> spanId', () => {
  const store = new TraceStore()
  const runId = store.startRun({}, 'jsonl-run')
  store.appendToolCall({ toolName: 'read_kv', phase: 'request', input: { key: 'k' } })
  store.appendToolCache({ toolName: 'read_kv', toolUseId: 't-1', outcome: 'miss' })
  store.appendToolCall({ toolName: 'read_kv', phase: 'result', output: 'value-for-k' })
  store.appendToolCache({ toolName: 'read_kv', toolUseId: 't-2', outcome: 'hit' })

  const exporter = new JsonlExporter()
  const events = store.query(runId)
  exporter.export(events.map(eventToOtelSpan))
  const lines = exporter.drain().split('\n').map((l) => JSON.parse(l))
  assert.equal(lines.length, 4)

  // All four spans share the same tool:<name> spanId — host-side correlation works.
  const spanIds = lines.map((l) => l.spanId)
  assert.deepEqual(spanIds, ['tool:read_kv', 'tool:read_kv', 'tool:read_kv', 'tool:read_kv'])

  const cacheSpans = lines.filter((l) => l.name.startsWith('tool.cache.'))
  assert.equal(cacheSpans.length, 2)
  assert.equal(cacheSpans[0].name, 'tool.cache.miss')
  assert.equal(cacheSpans[1].name, 'tool.cache.hit')
})
