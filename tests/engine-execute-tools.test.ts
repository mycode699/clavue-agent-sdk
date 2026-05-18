/**
 * M2 — `executeToolsImpl` / `executeSingleToolImpl` extraction guard tests.
 *
 * These exercise the deps-injected helpers directly (no Agent / Provider
 * involved) so the contract is locked outside of the engine wrapper:
 *   1. empty tool_use list → no work, no trace mutation
 *   2. happy-path single read-only tool → tool.call() runs, PostToolUse hook
 *      fires, side-effects ingested, trace.tools gets a row
 *   3. policy.canUseTool returns 'deny' → buildErrorToolResult, push to
 *      trace.permission_denials, no tool.call()
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  executeToolsImpl,
  type ExecuteToolsDeps,
} from '../src/engine/execute-tools.ts'
import { createStaticConcurrencyController } from '../src/engine/concurrency-controller.ts'
import type {
  AgentRunTrace,
  Evidence,
  QualityGateResult,
  ToolDefinition,
  ToolResult,
} from '../src/types.ts'
import type { CanUseToolResult, ToolPolicy } from '../src/types/tools.ts'

interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: any
}

function emptyTrace(): AgentRunTrace {
  return {
    schema_version: '2.0.0',
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

function makeReadTool(counter: { calls: number }): ToolDefinition {
  return {
    name: 'read_kv',
    description: 'Read.',
    inputSchema: { type: 'object', properties: { key: { type: 'string' } } },
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

function buildDeps(overrides: Partial<ExecuteToolsDeps> & {
  tools: ToolDefinition[]
  policy?: ToolPolicy
}): { deps: ExecuteToolsDeps; trace: AgentRunTrace; evidence: Evidence[]; gates: QualityGateResult[]; hookCalls: string[] } {
  const trace = emptyTrace()
  const evidence: Evidence[] = []
  const gates: QualityGateResult[] = []
  const hookCalls: string[] = []
  const policy: ToolPolicy =
    overrides.policy ??
    {
      permissionMode: 'trustedAutomation',
      canUseTool: async () => ({ behavior: 'allow', source: 'permission_mode' }) as CanUseToolResult,
    }

  const deps: ExecuteToolsDeps = {
    config: {
      tools: overrides.tools,
      policy,
      cwd: '/tmp',
      provider: { apiType: 'openai-completions', createMessage: async () => ({} as any) },
      model: 'test-model',
      // guardrails / trace / onToolViolation intentionally unset
    } as any,
    trace,
    maxToolConcurrency: 10,
    concurrencyController: createStaticConcurrencyController(10),
    evidence,
    qualityGates: gates,
    forkedSkills: [],
    getActiveSkill: () => undefined,
    setActiveSkill: () => {},
    getRequiredSkillQualityGates: () => [],
    setRequiredSkillQualityGates: () => {},
    executeHooks: async (event) => {
      hookCalls.push(event)
      return []
    },
    parseSkillActivation: () => undefined,
    recordPolicyDecision: () => {},
    ...overrides,
  }

  return { deps, trace, evidence, gates, hookCalls }
}

test('executeToolsImpl: empty blocks → returns [] and leaves trace untouched', async () => {
  const tool = makeReadTool({ calls: 0 })
  const { deps, trace } = buildDeps({ tools: [tool] })
  const before = JSON.stringify(trace)

  const results = await executeToolsImpl(deps, [])

  assert.deepEqual(results, [])
  assert.equal(JSON.stringify(trace), before, 'trace must not be mutated')
})

test('executeToolsImpl: happy-path single read-only tool runs, hooks fire, trace updated', async () => {
  const counter = { calls: 0 }
  const tool = makeReadTool(counter)
  const { deps, trace, hookCalls } = buildDeps({ tools: [tool] })

  const blocks: ToolUseBlock[] = [
    { type: 'tool_use', id: 't-1', name: 'read_kv', input: { key: 'foo' } },
  ]
  const results = await executeToolsImpl(deps, blocks)

  assert.equal(counter.calls, 1, 'tool.call() must run exactly once')
  assert.equal(results.length, 1)
  assert.equal(results[0]!.tool_use_id, 't-1')
  assert.equal(results[0]!.tool_name, 'read_kv')
  assert.equal((results[0]!.content as string), 'value-for-foo')
  assert.equal(results[0]!.is_error, undefined)

  // PreToolUse + PostToolUse must have fired exactly once each.
  assert.deepEqual(hookCalls, ['PreToolUse', 'PostToolUse'])

  // trace.tools should have one entry for this tool.
  assert.equal(trace.tools.length, 1)
  assert.equal(trace.tools[0]!.tool_name, 'read_kv')
  assert.equal(trace.tools[0]!.is_error, false)
})

test('executeToolsImpl: policy deny → permission_denials row, error result, no tool.call()', async () => {
  const counter = { calls: 0 }
  const tool = makeReadTool(counter)
  const policyCalls: Array<{ behavior: string; source: string }> = []
  const { deps, trace } = buildDeps({
    tools: [tool],
    policy: {
      permissionMode: 'plan',
      canUseTool: async () =>
        ({
          behavior: 'deny',
          message: 'plan mode forbids writes',
          source: 'permission_mode',
        }) as CanUseToolResult,
    },
    recordPolicyDecision: (entry: any) => {
      policyCalls.push({ behavior: entry.behavior, source: entry.source })
    },
  })

  const blocks: ToolUseBlock[] = [
    { type: 'tool_use', id: 't-1', name: 'read_kv', input: { key: 'foo' } },
  ]
  const results = await executeToolsImpl(deps, blocks)

  assert.equal(counter.calls, 0, 'tool.call() must NOT run on deny')
  assert.equal(results.length, 1)
  assert.equal(results[0]!.is_error, true)
  assert.match(String(results[0]!.content), /plan mode forbids writes/)

  assert.equal(trace.permission_denials.length, 1)
  assert.equal(trace.permission_denials[0]!.tool, 'read_kv')

  assert.deepEqual(policyCalls, [{ behavior: 'deny', source: 'permission_mode' }])
})
