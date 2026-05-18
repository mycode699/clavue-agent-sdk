import test from 'node:test'
import assert from 'node:assert/strict'

import { runToolsStage } from '../../src/engine/pipeline/tools.ts'
import type { ToolsStageInput } from '../../src/engine/pipeline/tools.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import type { CreateMessageResponse } from '../../src/providers/types.ts'

function makeCtx(): PipelineContext {
  return {
    runId: 'r', sessionId: 's', provider: {} as any,
    trace: {
      schema_version: '2.0.0', turns: [], tools: [],
      concurrency_batches: [], tool_concurrency_limit: 10,
      tool_concurrency_source: 'default', retry_count: 0,
      compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

function makeInput(over: Partial<ToolsStageInput> = {}): ToolsStageInput {
  return {
    response: {
      content: [{ type: 'text', text: 'no tools' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
    config: { tools: [], policy: { permissionMode: 'auto' as any } } as any,
    activeSkill: undefined,
    maxToolConcurrency: 10,
    toolResultCache: { get: () => undefined, set: () => {} } as any,
    concurrencyController: { current: () => 10, recordBatchOutcome: () => {} } as any,
    executeTools: async () => [],
    ...over,
  }
}

test('tools stage returns empty + status=skipped when no tool_use blocks', async () => {
  const ctx = makeCtx()
  const result = await runToolsStage(ctx, makeInput())
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.toolUseBlocks.length, 0)
    assert.equal(result.value.toolResults.length, 0)
  }
  assert.equal(ctx.trace.pipeline_stages?.tools?.status, 'skipped')
})

test('tools stage extracts tool_use blocks and dispatches them', async () => {
  const ctx = makeCtx()
  const response: CreateMessageResponse = {
    content: [
      { type: 'tool_use', id: 't1', name: 'foo', input: { x: 1 } } as any,
      { type: 'text', text: 'going to call foo' },
    ],
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  let dispatched = 0
  const result = await runToolsStage(ctx, makeInput({
    response,
    executeTools: async (blocks) => {
      dispatched = blocks.length
      return blocks.map((b) => ({
        type: 'tool_result' as const,
        tool_use_id: b.id,
        content: 'done',
        is_error: false,
        tool_name: b.name,
      }))
    },
  }))
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.toolUseBlocks.length, 1)
    assert.equal(result.value.toolResults.length, 1)
    assert.equal(result.value.toolResults[0]!.content, 'done')
    assert.equal(dispatched, 1)
  }
  assert.equal(ctx.trace.pipeline_stages?.tools?.status, 'ok')
})

test('tools stage propagates GuardrailAbortError + records status=error', async () => {
  const ctx = makeCtx()
  const { GuardrailAbortError } = await import('../../src/guardrails/errors.ts')
  const response: CreateMessageResponse = {
    content: [{ type: 'tool_use', id: 't1', name: 'foo', input: {} } as any],
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  let thrown: unknown
  try {
    await runToolsStage(ctx, makeInput({
      response,
      executeTools: async () => {
        throw new GuardrailAbortError(
          'blocked',
          { decision: 'abort', confidence: 1 } as any,
          'foo',
          'tool_input',
        )
      },
    }))
  } catch (err) {
    thrown = err
  }
  assert.ok(thrown instanceof GuardrailAbortError)
  assert.equal(ctx.trace.pipeline_stages?.tools?.status, 'error')
})

test('tools stage records duration_ms regardless of outcome', async () => {
  const ctx = makeCtx()
  await runToolsStage(ctx, makeInput())
  assert.ok(typeof ctx.trace.pipeline_stages?.tools?.duration_ms === 'number')
  assert.ok(ctx.trace.pipeline_stages!.tools!.duration_ms >= 0)
})

test('tools stage preserves block order and ignores non tool_use content', async () => {
  const ctx = makeCtx()
  const response: CreateMessageResponse = {
    content: [
      { type: 'text', text: 'prelude' },
      { type: 'tool_use', id: 'a', name: 'tool-a', input: {} } as any,
      { type: 'text', text: 'mid' },
      { type: 'tool_use', id: 'b', name: 'tool-b', input: {} } as any,
    ],
    stopReason: 'tool_use',
    usage: { input_tokens: 1, output_tokens: 1 },
  }
  const result = await runToolsStage(ctx, makeInput({
    response,
    executeTools: async (blocks) => blocks.map((b) => ({
      type: 'tool_result' as const,
      tool_use_id: b.id,
      content: 'ok',
      is_error: false,
      tool_name: b.name,
    })),
  }))
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.toolUseBlocks.length, 2)
    assert.equal(result.value.toolUseBlocks[0]!.id, 'a')
    assert.equal(result.value.toolUseBlocks[1]!.id, 'b')
  }
})
