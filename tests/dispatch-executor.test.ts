import test from 'node:test'
import assert from 'node:assert/strict'

import { executeDispatchPlan } from '../src/engine/dispatch-executor.ts'
import type { ToolDispatchBatch } from '../src/engine/tool-helpers.ts'
import type { AgentRunTrace, AgentRunToolTrace, ToolContext, ToolDefinition, ToolResult } from '../src/types.ts'

function makeTrace(): AgentRunTrace {
  return {
    schema_version: '1.0.0',
    turns: [],
    tools: [],
    concurrency_batches: [],
    tool_concurrency_limit: 10,
    tool_concurrency_source: 'default',
    retry_count: 0,
    compaction_count: 0,
    compactions: [],
    permission_denials: [],
    policy_decisions: [],
    memory: [],
  }
}

interface FakeBlock {
  id: string
  name: string
}

function makeContext(): ToolContext {
  return { cwd: process.cwd() }
}

function makeResult(id: string, name: string, error = false): ToolResult & { tool_name?: string } {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: `result for ${id}`,
    is_error: error,
    tool_name: name,
  }
}

test('executeDispatchPlan runs serial batches one-by-one and records concurrency_batches=1', async () => {
  const trace = makeTrace()
  const plan: ToolDispatchBatch<FakeBlock>[] = [
    { kind: 'serial', entries: [{ block: { id: 't1', name: 'Bash' }, tool: undefined }] },
    { kind: 'serial', entries: [{ block: { id: 't2', name: 'Edit' }, tool: undefined }] },
  ]

  const order: string[] = []
  const results = await executeDispatchPlan<FakeBlock>({
    plan,
    context: makeContext(),
    trace,
    maxConcurrency: 10,
    executeSingle: async (block) => {
      order.push(block.id)
      return makeResult(block.id, block.name)
    },
  })

  assert.deepEqual(order, ['t1', 't2'], 'serial order preserved')
  assert.equal(results.length, 2)
  assert.deepEqual(trace.concurrency_batches, [1, 1])
})

test('executeDispatchPlan fans out concurrent batch via Promise.all and records batch size', async () => {
  const trace = makeTrace()
  const plan: ToolDispatchBatch<FakeBlock>[] = [
    {
      kind: 'concurrent',
      entries: [
        { block: { id: 't1', name: 'Read' }, tool: undefined },
        { block: { id: 't2', name: 'Read' }, tool: undefined },
        { block: { id: 't3', name: 'Read' }, tool: undefined },
      ],
    },
  ]

  let inFlight = 0
  let peak = 0
  const results = await executeDispatchPlan<FakeBlock>({
    plan,
    context: makeContext(),
    trace,
    maxConcurrency: 10,
    executeSingle: async (block) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return makeResult(block.id, block.name)
    },
  })

  assert.equal(results.length, 3)
  assert.deepEqual(trace.concurrency_batches, [3], 'one batch of 3 recorded')
  assert.ok(peak >= 2, `expected concurrent execution; peak in-flight = ${peak}`)
})

test('executeDispatchPlan respects maxConcurrency by chunking concurrent batches', async () => {
  const trace = makeTrace()
  const plan: ToolDispatchBatch<FakeBlock>[] = [
    {
      kind: 'concurrent',
      entries: Array.from({ length: 5 }, (_, i) => ({
        block: { id: `t${i + 1}`, name: 'Read' },
        tool: undefined,
      })),
    },
  ]

  const results = await executeDispatchPlan<FakeBlock>({
    plan,
    context: makeContext(),
    trace,
    maxConcurrency: 2,
    executeSingle: async (block) => makeResult(block.id, block.name),
  })

  assert.equal(results.length, 5)
  // Concurrency cap=2 over 5 entries → batch sizes [2, 2, 1].
  assert.deepEqual(trace.concurrency_batches, [2, 2, 1])
})

test('executeDispatchPlan records batch traces for concurrent entries via callback', async () => {
  const trace = makeTrace()
  const plan: ToolDispatchBatch<FakeBlock>[] = [
    {
      kind: 'concurrent',
      entries: [
        { block: { id: 't1', name: 'Read' }, tool: undefined },
        { block: { id: 't2', name: 'Read' }, tool: undefined },
      ],
    },
  ]

  await executeDispatchPlan<FakeBlock>({
    plan,
    context: makeContext(),
    trace,
    maxConcurrency: 10,
    executeSingle: async (block, _tool, _ctx, recordTrace) => {
      const t: AgentRunToolTrace = {
        tool_use_id: block.id,
        tool_name: block.name,
        duration_ms: 10,
        is_error: false,
        concurrency_safe: true,
      }
      if (typeof recordTrace === 'function') recordTrace(t)
      return makeResult(block.id, block.name)
    },
  })

  assert.equal(trace.tools.length, 2)
  assert.equal(trace.tools[0]!.tool_use_id, 't1')
  assert.equal(trace.tools[1]!.tool_use_id, 't2')
})

test('executeDispatchPlan serial path passes recordTrace=true (engine pushes inline)', async () => {
  const trace = makeTrace()
  const plan: ToolDispatchBatch<FakeBlock>[] = [
    { kind: 'serial', entries: [{ block: { id: 't1', name: 'Bash' }, tool: undefined }] },
  ]

  let observedRecordTrace: unknown
  await executeDispatchPlan<FakeBlock>({
    plan,
    context: makeContext(),
    trace,
    maxConcurrency: 10,
    executeSingle: async (block, _tool, _ctx, recordTrace) => {
      observedRecordTrace = recordTrace
      return makeResult(block.id, block.name)
    },
  })
  assert.equal(observedRecordTrace, true, 'serial path uses the legacy true sentinel')
})

test('executeDispatchPlan returns results in plan order across mixed batches', async () => {
  const trace = makeTrace()
  const plan: ToolDispatchBatch<FakeBlock>[] = [
    {
      kind: 'concurrent',
      entries: [
        { block: { id: 't1', name: 'Read' }, tool: undefined },
        { block: { id: 't2', name: 'Read' }, tool: undefined },
      ],
    },
    { kind: 'serial', entries: [{ block: { id: 't3', name: 'Bash' }, tool: undefined }] },
    {
      kind: 'concurrent',
      entries: [
        { block: { id: 't4', name: 'Read' }, tool: undefined },
      ],
    },
  ]

  const results = await executeDispatchPlan<FakeBlock>({
    plan,
    context: makeContext(),
    trace,
    maxConcurrency: 10,
    executeSingle: async (block) => makeResult(block.id, block.name),
  })

  assert.deepEqual(results.map((r) => r.tool_use_id), ['t1', 't2', 't3', 't4'])
  // Trace records: concurrent(2), serial(1), concurrent(1).
  assert.deepEqual(trace.concurrency_batches, [2, 1, 1])
})
