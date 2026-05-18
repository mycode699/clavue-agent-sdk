import test from 'node:test'
import assert from 'node:assert/strict'

import { runRenderStage } from '../../src/engine/pipeline/render.ts'
import type { RenderStageInput } from '../../src/engine/pipeline/render.ts'
import type { PipelineContext } from '../../src/engine/pipeline/types.ts'
import { createDefaultToolPolicy } from '../../src/types/tools.ts'

function fakeProvider(): any {
  return {
    createMessage: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  }
}

function makeCtx(): PipelineContext {
  return {
    runId: 'r', sessionId: 's',
    provider: fakeProvider(),
    trace: {
      schema_version: '2.0.0',
      turns: [], tools: [], concurrency_batches: [],
      tool_concurrency_limit: 10, tool_concurrency_source: 'default',
      retry_count: 0, compaction_count: 0, permission_denials: [],
    },
    totalUsage: { input_tokens: 0, output_tokens: 0 },
    tools: [],
    state: {
      turnIndex: 0, apiAttempts: 0, maxOutputRecoveryAttempts: 0,
      completedNormally: false, budgetExceeded: false,
    },
  }
}

function makeConfig(model = 'claude-3-5-sonnet'): any {
  return {
    cwd: process.cwd(),
    model,
    provider: fakeProvider(),
    tools: [],
    maxTurns: 10,
    maxTokens: 1024,
    policy: createDefaultToolPolicy('trustedAutomation'),
    systemPrompt: 'be brief',  // skip the long default prompt builder path
  }
}

test('render produces requestModel + providerTools + createModelMessage', async () => {
  const ctx = makeCtx()
  const input: RenderStageInput = {
    config: makeConfig(),
    apiMessages: [{ role: 'user', content: 'hi' }] as any,
    activeSkill: undefined,
    partialQueue: [],
    releaseDrain: () => {},
  }
  const result = await runRenderStage(ctx, input)
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.requestModel, 'claude-3-5-sonnet')
    assert.ok(Array.isArray(result.value.providerTools))
    assert.equal(typeof result.value.createModelMessage, 'function')
  }
  assert.equal(ctx.trace.pipeline_stages?.render?.status, 'ok')
})

test('render uses skill model override when activeSkill present', async () => {
  const ctx = makeCtx()
  const result = await runRenderStage(ctx, {
    config: makeConfig(),
    apiMessages: [{ role: 'user', content: 'hi' }] as any,
    activeSkill: {
      kind: 'inline',
      skillName: 'test-skill',
      prompt: 'be brief',
      allowedTools: [],
      model: 'claude-3-haiku-20240307',
    } as any,
    partialQueue: [],
    releaseDrain: () => {},
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.requestModel, 'claude-3-haiku-20240307')
  }
})

test('render records duration_ms', async () => {
  const ctx = makeCtx()
  await runRenderStage(ctx, {
    config: makeConfig(),
    apiMessages: [{ role: 'user', content: 'hi' }] as any,
    activeSkill: undefined,
    partialQueue: [],
    releaseDrain: () => {},
  })
  assert.ok(typeof ctx.trace.pipeline_stages?.render?.duration_ms === 'number')
  assert.ok(ctx.trace.pipeline_stages!.render!.duration_ms >= 0)
})

test('render output exposes systemPrompt for downstream stages', async () => {
  const ctx = makeCtx()
  const result = await runRenderStage(ctx, {
    config: makeConfig(),
    apiMessages: [{ role: 'user', content: 'hi' }] as any,
    activeSkill: undefined,
    partialQueue: [],
    releaseDrain: () => {},
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(typeof result.value.systemPrompt, 'string')
    assert.ok(result.value.systemPrompt.length > 0)
  }
})

test('render preserves config.fallbackModel in turn request', async () => {
  const ctx = makeCtx()
  const cfg = makeConfig()
  cfg.fallbackModel = 'claude-3-haiku-20240307'
  const result = await runRenderStage(ctx, {
    config: cfg,
    apiMessages: [{ role: 'user', content: 'hi' }] as any,
    activeSkill: undefined,
    partialQueue: [],
    releaseDrain: () => {},
  })
  assert.equal(result.kind, 'ok')
  if (result.kind === 'ok') {
    assert.equal(result.value.fallbackModel, 'claude-3-haiku-20240307')
  }
})
