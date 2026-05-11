/**
 * Engine ↔ ToolResultCache (Tier A #1) integration test.
 *
 * Locks the contract: when a turn dispatches multiple tool_use blocks for
 * the same read-only concurrency-safe tool with the same input, only the
 * first call hits `tool.call()`; subsequent ones replay from the
 * turn-scoped cache. PostToolUse hooks and evidence ingestion only fire
 * on the first call.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { Agent } from '../src/index.ts'
import type {
  CreateMessageParams,
  CreateMessageResponse,
  LLMProvider,
  SDKMessage,
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
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `value-for-${input.key}`,
      }
    },
  }
}

async function collectEvents(agent: Agent, prompt = 'go'): Promise<SDKMessage[]> {
  const events: SDKMessage[] = []
  for await (const event of agent.query(prompt)) events.push(event)
  return events
}

test('duplicate read-only tool calls in one turn share a single tool.call()', async () => {
  const counter = { calls: 0 }
  const tool = readKvTool(counter)

  const provider = new StubProvider([
    readsResponse([
      { id: 't-1', input: { key: 'foo' } },
      { id: 't-2', input: { key: 'foo' } }, // duplicate of t-1
      { id: 't-3', input: { key: 'bar' } }, // distinct
      { id: 't-4', input: { key: 'foo' } }, // duplicate again
    ]),
    textResponse('done'),
  ])

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool] })
  ;(agent as any).provider = provider

  try {
    const result = await agent.run('go')
    assert.equal(counter.calls, 2, 'tool.call() should run once per distinct input')
    assert.equal(result.trace?.tool_cache?.hits, 2)
    assert.equal(result.trace?.tool_cache?.misses, 2)

    // Each tool_use_id still gets a tool_result echoed back to the model.
    const followup = provider.calls[1]
    assert.ok(followup, 'expected a follow-up provider call')
    const last = followup.messages.at(-1)
    const content = last?.content as Array<{ type: string; tool_use_id: string; content: string }>
    const ids = content.filter((c) => c.type === 'tool_result').map((c) => c.tool_use_id)
    assert.deepEqual(ids, ['t-1', 't-2', 't-3', 't-4'])

    const fooResults = content.filter((c) => c.type === 'tool_result' && c.content === 'value-for-foo')
    assert.equal(fooResults.length, 3, 'all three "foo" reads should return identical content')
  } finally {
    await agent.close()
  }
})

test('non-concurrency-safe tools bypass the cache entirely', async () => {
  const counter = { calls: 0 }
  const tool: ToolDefinition = {
    name: 'mutate',
    description: 'Mutate state.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } }, required: ['key'] },
    // Intentionally NO isReadOnly/isConcurrencySafe → cache must bypass.
    call: async (input: any) => {
      counter.calls++
      return { type: 'tool_result', tool_use_id: '', content: `wrote-${input.key}` }
    },
  }

  const provider = new StubProvider([
    {
      content: [
        { type: 'tool_use', id: 't-1', name: 'mutate', input: { key: 'foo' } },
        { type: 'tool_use', id: 't-2', name: 'mutate', input: { key: 'foo' } },
      ],
      stopReason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    textResponse('done'),
  ])

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool] })
  ;(agent as any).provider = provider

  try {
    const result = await agent.run('go')
    assert.equal(counter.calls, 2, 'mutating tools must run for every tool_use block')
    // No cache lookups happened for ineligible tools, so trace stays clean.
    assert.equal(result.trace?.tool_cache, undefined)
  } finally {
    await agent.close()
  }
})

test('cache key is order-independent across object input keys', async () => {
  const counter = { calls: 0 }
  const tool: ToolDefinition = {
    name: 'lookup',
    description: 'Lookup',
    inputSchema: {
      type: 'object',
      properties: { a: { type: 'string' }, b: { type: 'string' } },
      required: ['a', 'b'],
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    call: async () => {
      counter.calls++
      return { type: 'tool_result', tool_use_id: '', content: 'ok' }
    },
  }

  const provider = new StubProvider([
    {
      content: [
        { type: 'tool_use', id: 't-1', name: 'lookup', input: { a: '1', b: '2' } },
        { type: 'tool_use', id: 't-2', name: 'lookup', input: { b: '2', a: '1' } },
      ],
      stopReason: 'tool_use',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    textResponse('done'),
  ])

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool] })
  ;(agent as any).provider = provider

  try {
    const result = await agent.run('go')
    assert.equal(counter.calls, 1, 'identical input under different key order should hit')
    assert.equal(result.trace?.tool_cache?.hits, 1)
    assert.equal(result.trace?.tool_cache?.misses, 1)
  } finally {
    await agent.close()
  }
})

test('PostToolUse hook fires once per cached tool result, not per duplicate', async () => {
  const counter = { calls: 0 }
  const hookCalls: string[] = []
  const tool = readKvTool(counter)

  const provider = new StubProvider([
    readsResponse([
      { id: 't-1', input: { key: 'k' } },
      { id: 't-2', input: { key: 'k' } },
      { id: 't-3', input: { key: 'k' } },
    ]),
    textResponse('done'),
  ])

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [tool],
    hooks: {
      PostToolUse: [
        {
          hooks: [
            async (input: any) => {
              hookCalls.push(input.toolUseId)
              return {}
            },
          ],
        },
      ],
    },
  })
  ;(agent as any).provider = provider

  try {
    await agent.run('go')
    assert.equal(counter.calls, 1)
    assert.deepEqual(hookCalls, ['t-1'], 'PostToolUse fires only when tool.call() actually ran')
  } finally {
    await agent.close()
  }
})

test('cache resets between turns — the same input re-enters the tool', async () => {
  const counter = { calls: 0 }
  const tool = readKvTool(counter)

  const provider = new StubProvider([
    readsResponse([{ id: 't-1', input: { key: 'a' } }]),
    readsResponse([{ id: 't-2', input: { key: 'a' } }]),
    textResponse('done'),
  ])

  const agent = new Agent({ model: 'gpt-5.4', tools: [tool] })
  ;(agent as any).provider = provider

  try {
    const result = await agent.run('go')
    assert.equal(counter.calls, 2, 'cross-turn reads must re-enter the tool (no stale state)')
    // Both turns observed the same input → 2 misses, 0 hits aggregated.
    assert.equal(result.trace?.tool_cache?.hits, 0)
    assert.equal(result.trace?.tool_cache?.misses, 2)
  } finally {
    await agent.close()
  }
})
