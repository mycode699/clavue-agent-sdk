/**
 * End-to-end tests for `runIssueWorkflowWithAgent` — the v2 real LLM-driven
 * issue workflow loop.
 *
 * These tests use a mock Agent (no LLM call) and StaticVerifier so the loop
 * executes deterministically. They prove:
 *   1. A passing first iteration completes after one build, no review.
 *   2. A failing run loops `build → review → fix → ...` up to maxIterations.
 *   3. Eventual success terminates early and writes a passing proof-of-work.
 *   4. Reaching maxIterations records `max_iterations` status.
 *   5. Required gates control the success criteria.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runIssueWorkflowWithAgent, StaticVerifier, normalizeIssueInput } from '../src/index.ts'
import type { AgentLike } from '../src/index.ts'
import { AGENT_RUN_RESULT_SCHEMA_VERSION } from '../src/types.ts'
import type { AgentRunResult, QualityGateResult } from '../src/types.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-issue-real-'))
}

function makeAgentResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    schema_version: AGENT_RUN_RESULT_SCHEMA_VERSION,
    id: `run_${Math.random().toString(36).slice(2, 10)}`,
    session_id: 'sess_test',
    status: 'completed',
    subtype: 'success',
    text: 'mock agent output',
    usage: { input_tokens: 0, output_tokens: 0 },
    num_turns: 1,
    duration_ms: 1,
    duration_api_ms: 1,
    total_cost_usd: 0,
    cost: 0,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    events: [],
    ...overrides,
  } as AgentRunResult
}

interface RecordedCall {
  prompt: string
  cwd?: string
}

function makeMockAgent(responses: string[]): { agent: AgentLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  let index = 0
  const agent: AgentLike = {
    async run(text, overrides) {
      calls.push({ prompt: text, cwd: overrides?.cwd })
      const response = responses[index] ?? `mock response ${index}`
      index += 1
      return makeAgentResult({ text: response })
    },
  }
  return { agent, calls }
}

test('runIssueWorkflowWithAgent: rejects missing agent', async () => {
  await assert.rejects(
    runIssueWorkflowWithAgent({
      issue: normalizeIssueInput('test\n\nbody'),
      agent: undefined as any,
      verifier: new StaticVerifier([]),
      cwd: '/tmp',
    }),
    /requires an Agent/,
  )
})

test('runIssueWorkflowWithAgent: rejects missing verifier', async () => {
  await assert.rejects(
    runIssueWorkflowWithAgent({
      issue: normalizeIssueInput('test\n\nbody'),
      agent: { run: async () => makeAgentResult() },
      verifier: undefined as any,
      cwd: '/tmp',
    }),
    /requires a Verifier/,
  )
})

test('runIssueWorkflowWithAgent: passes on first iteration with single build call', async () => {
  const cwd = await makeTempDir()
  try {
    const { agent, calls } = makeMockAgent(['Done — modified src/foo.ts'])
    const verifier = new StaticVerifier([
      { name: 'tests', status: 'passed' },
    ])
    const result = await runIssueWorkflowWithAgent({
      issue: normalizeIssueInput('Fix the streaming bug\n\nWhen X happens, Y should be Z.'),
      agent,
      verifier,
      cwd,
      requiredGates: ['tests'],
      maxIterations: 3,
    }, { storeRoot: cwd })

    assert.equal(result.status, 'completed')
    assert.equal(result.finalScore, 80)
    assert.equal(result.unresolvedFindings.length, 0)
    assert.ok(result.quality_gates.find((g) => g.name === 'tests' && g.status === 'passed'))
    assert.equal(calls.length, 1, 'should not call the reviewer when the first build passes')
    assert.match(calls[0]!.prompt, /Fix the streaming bug/)
    assert.equal(calls[0]!.cwd, cwd)
    assert.equal(result.proof_of_work.status, 'passed')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runIssueWorkflowWithAgent: loops build→review→fix until verifier passes', async () => {
  const cwd = await makeTempDir()
  try {
    const { agent, calls } = makeMockAgent([
      'attempt 1 — initial build',         // build iter 1
      'review feedback — try harder',      // review iter 1
      'attempt 2 — applied fix plan',      // build iter 2 (fixer)
    ])
    let iterationSeen = 0
    const verifier = new StaticVerifier(() => {
      iterationSeen += 1
      const status = iterationSeen >= 2 ? 'passed' : 'failed'
      return [{ name: 'tests', status, summary: `iter ${iterationSeen}` }] as QualityGateResult[]
    })

    const result = await runIssueWorkflowWithAgent({
      issue: normalizeIssueInput('Bug X\n\nY should not crash.'),
      agent,
      verifier,
      cwd,
      requiredGates: ['tests'],
      maxIterations: 5,
    }, { storeRoot: cwd })

    assert.equal(result.status, 'completed')
    assert.equal(calls.length, 3, '1 build + 1 review + 1 fix-build')
    assert.match(calls[0]!.prompt, /This is iteration 1|Implement the changes/)
    assert.match(calls[1]!.prompt, /Verification failed/)
    assert.match(calls[1]!.prompt, /tests — failed/)
    // Iteration 2 builder should receive the reviewer feedback verbatim.
    assert.match(calls[2]!.prompt, /This is iteration 2/)
    assert.match(calls[2]!.prompt, /review feedback — try harder/)

    // quality_gates should accumulate ALL iterations (not just the last one).
    assert.ok(result.quality_gates.length >= 2)
    assert.equal(result.quality_gates[result.quality_gates.length - 1]!.status, 'passed')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runIssueWorkflowWithAgent: returns max_iterations when budget runs out', async () => {
  const cwd = await makeTempDir()
  try {
    const responses: string[] = []
    for (let i = 0; i < 20; i++) responses.push(`response ${i}`)
    const { agent, calls } = makeMockAgent(responses)
    const verifier = new StaticVerifier([
      { name: 'tests', status: 'failed', summary: 'red' },
    ])

    const result = await runIssueWorkflowWithAgent({
      issue: normalizeIssueInput('Hard issue\n\nNever passes.'),
      agent,
      verifier,
      cwd,
      requiredGates: ['tests'],
      maxIterations: 2,
    }, { storeRoot: cwd })

    assert.equal(result.status, 'max_iterations')
    assert.equal(result.finalScore, undefined)
    assert.ok(result.unresolvedFindings.length > 0)
    // 2 iterations × (build + review) = 4 agent calls
    assert.equal(calls.length, 4)
    assert.match(result.proof_of_work.next_actions?.[0] ?? '', /maxIterations=2/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runIssueWorkflowWithAgent: clamps maxIterations to safe bounds', async () => {
  const cwd = await makeTempDir()
  try {
    const { agent } = makeMockAgent(['ok'])
    const verifier = new StaticVerifier([{ name: 'tests', status: 'passed' }])

    const result = await runIssueWorkflowWithAgent({
      issue: normalizeIssueInput('test\n\nbody'),
      agent,
      verifier,
      cwd,
      requiredGates: ['tests'],
      maxIterations: 9999, // hard cap is 10
    }, { storeRoot: cwd })

    assert.equal(result.status, 'completed')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runIssueWorkflowWithAgent: defaults to all-gates-must-pass when requiredGates omitted', async () => {
  const cwd = await makeTempDir()
  try {
    const { agent, calls } = makeMockAgent(['build', 'review', 'fix-build'])
    let attempt = 0
    const verifier = new StaticVerifier(() => {
      attempt += 1
      // First attempt: 1 of 2 gates fails. Second attempt: both pass.
      return attempt === 1
        ? [
            { name: 'tests', status: 'passed' },
            { name: 'lint', status: 'failed', summary: 'one warning' },
          ]
        : [
            { name: 'tests', status: 'passed' },
            { name: 'lint', status: 'passed' },
          ]
    })

    const result = await runIssueWorkflowWithAgent({
      issue: normalizeIssueInput('topic\n\nbody'),
      agent,
      verifier,
      cwd,
      // requiredGates omitted on purpose
      maxIterations: 3,
    }, { storeRoot: cwd })

    assert.equal(result.status, 'completed')
    assert.equal(calls.length, 3)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runIssueWorkflowWithAgent: failing-gate without remaining iterations returns failed_gate', async () => {
  const cwd = await makeTempDir()
  try {
    const { agent } = makeMockAgent(['build', 'review'])
    const verifier = new StaticVerifier([
      { name: 'tests', status: 'failed', summary: 'red' },
    ])

    const result = await runIssueWorkflowWithAgent({
      issue: normalizeIssueInput('test\n\nbody'),
      agent,
      verifier,
      cwd,
      requiredGates: ['tests'],
      maxIterations: 1,
    }, { storeRoot: cwd })

    assert.equal(result.status, 'max_iterations')
    assert.ok(result.unresolvedFindings[0]!.message.includes('tests'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runIssueWorkflowWithAgent: custom prompts are honored', async () => {
  const cwd = await makeTempDir()
  try {
    const { agent, calls } = makeMockAgent(['ok'])
    const verifier = new StaticVerifier([{ name: 'tests', status: 'passed' }])

    await runIssueWorkflowWithAgent({
      issue: normalizeIssueInput('issue title\n\nbody'),
      agent,
      verifier,
      cwd,
      requiredGates: ['tests'],
      prompts: {
        build: ({ issue, iteration }) => `CUSTOM BUILD #${iteration}: ${issue.title}`,
      },
    }, { storeRoot: cwd })

    assert.equal(calls[0]!.prompt, 'CUSTOM BUILD #1: issue title')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
