import test from 'node:test'
import assert from 'node:assert/strict'

import { runGraph, validateGraph } from '../src/graph/index.ts'
import type { AgentGraph, GraphAgentLike } from '../src/graph/index.ts'
import { StaticVerifier } from '../src/workflow/verifier.ts'

function stubAgent(reply: string | ((prompt: string) => string)): GraphAgentLike {
  return {
    async prompt(text: string) {
      const out = typeof reply === 'function' ? reply(text) : reply
      return { text: out }
    },
  }
}

test('validateGraph rejects empty nodes / unknown entry / duplicate ids / bad edges', () => {
  assert.throws(
    () => validateGraph({ entry: 'a', nodes: [], edges: [] } as AgentGraph),
    /non-empty array/,
  )

  assert.throws(
    () =>
      validateGraph({
        entry: 'missing',
        nodes: [{ kind: 'agent', id: 'a', agent: stubAgent('') }],
        edges: [],
      }),
    /entry "missing"/,
  )

  assert.throws(
    () =>
      validateGraph({
        entry: 'a',
        nodes: [
          { kind: 'agent', id: 'a', agent: stubAgent('') },
          { kind: 'agent', id: 'a', agent: stubAgent('') },
        ],
        edges: [],
      }),
    /duplicate node id/,
  )

  assert.throws(
    () =>
      validateGraph({
        entry: 'a',
        nodes: [{ kind: 'agent', id: 'a', agent: stubAgent('') }],
        edges: [{ from: 'a', to: 'ghost' }],
      }),
    /edge\.to "ghost"/,
  )
})

test('agent node runs the prompt callback and stores text output', async () => {
  const graph: AgentGraph = {
    entry: 'plan',
    nodes: [
      {
        kind: 'agent',
        id: 'plan',
        agent: stubAgent((p) => `planned:${p}`),
        prompt: (ctx) => `do(${ctx.input})`,
      },
    ],
    edges: [],
  }
  const result = await runGraph(graph, { input: 'fix-bug-42' })
  assert.equal(result.status, 'completed')
  assert.equal(result.finalNodeId, 'plan')
  assert.deepEqual(result.outputs.plan, { kind: 'text', text: 'planned:do(fix-bug-42)' })
  assert.equal(result.history.length, 1)
  assert.equal(result.history[0]!.kind, 'agent')
  assert.equal(result.history[0]!.status, 'ok')
})

test('verifier node executes Verifier and surfaces gate results', async () => {
  const graph: AgentGraph = {
    entry: 'verify',
    nodes: [
      {
        kind: 'verifier',
        id: 'verify',
        verifier: new StaticVerifier([
          { name: 'tests', status: 'passed' },
          { name: 'lint', status: 'failed', summary: 'one warning' },
        ]),
      },
    ],
    edges: [],
  }
  const result = await runGraph(graph, { input: 'noop' })
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.gates.verify?.map((g) => g.name), ['tests', 'lint'])
  const out = result.outputs.verify
  assert.equal(out?.kind, 'gates')
  if (out?.kind === 'gates') {
    assert.equal(out.passed, false)
  }
})

test('router decides next node from gate results; loops fix→verify→done', async () => {
  let attempt = 0
  const flakyVerifier = new StaticVerifier(() => {
    attempt += 1
    return attempt < 2
      ? [{ name: 'tests', status: 'failed', summary: 'red' }]
      : [{ name: 'tests', status: 'passed' }]
  })

  const graph: AgentGraph = {
    entry: 'verify',
    nodes: [
      { kind: 'verifier', id: 'verify', verifier: flakyVerifier },
      {
        kind: 'router',
        id: 'route',
        route: (ctx) => {
          const last = ctx.gates.verify
          const allPassed = last?.every((g) => g.status === 'passed') ?? false
          return allPassed ? null : 'fix'
        },
      },
      { kind: 'agent', id: 'fix', agent: stubAgent('patched') },
    ],
    edges: [
      { from: 'verify', to: 'route' },
      { from: 'fix', to: 'verify' },
    ],
  }

  const result = await runGraph(graph, { input: 'go' })
  assert.equal(result.status, 'completed')
  // verify → route → fix → verify → route(stop)
  assert.deepEqual(
    result.history.map((s) => s.nodeId),
    ['verify', 'route', 'fix', 'verify', 'route'],
  )
  assert.equal(result.outputs.fix?.kind, 'text')
  if (result.outputs.fix?.kind === 'text') {
    assert.equal(result.outputs.fix.text, 'patched')
  }
})

test('parallel join=all fans out branches and writes each branch output', async () => {
  const graph: AgentGraph = {
    entry: 'fan',
    nodes: [
      { kind: 'parallel', id: 'fan', branches: ['fe', 'be'], join: 'all' },
      { kind: 'agent', id: 'fe', agent: stubAgent('frontend-built') },
      { kind: 'agent', id: 'be', agent: stubAgent('backend-built') },
    ],
    edges: [],
  }
  const result = await runGraph(graph, { input: 'go' })
  assert.equal(result.status, 'completed')
  assert.equal(result.outputs.fe?.kind, 'text')
  assert.equal(result.outputs.be?.kind, 'text')
  const fan = result.outputs.fan
  assert.equal(fan?.kind, 'parallel')
  if (fan?.kind === 'parallel') {
    assert.deepEqual(Object.keys(fan.branches).sort(), ['be', 'fe'])
  }
})

test('parallel join=race resolves on first completed branch', async () => {
  const graph: AgentGraph = {
    entry: 'fan',
    nodes: [
      { kind: 'parallel', id: 'fan', branches: ['fast', 'slow'], join: 'race' },
      {
        kind: 'agent',
        id: 'fast',
        agent: {
          async prompt() {
            return { text: 'fast-done' }
          },
        },
      },
      {
        kind: 'agent',
        id: 'slow',
        agent: {
          async prompt() {
            await new Promise((r) => setTimeout(r, 50))
            return { text: 'slow-done' }
          },
        },
      },
    ],
    edges: [],
  }
  const result = await runGraph(graph, { input: 'go' })
  assert.equal(result.status, 'completed')
  const fan = result.outputs.fan
  assert.equal(fan?.kind, 'parallel')
  if (fan?.kind === 'parallel') {
    // Only the winner is recorded under 'race'.
    const branchKeys = Object.keys(fan.branches)
    assert.equal(branchKeys.length, 1)
    assert.equal(branchKeys[0], 'fast')
  }
})

test('runtime aborts on excessive node revisits (cycle protection)', async () => {
  const graph: AgentGraph = {
    entry: 'a',
    nodes: [
      { kind: 'agent', id: 'a', agent: stubAgent('') },
      { kind: 'router', id: 'loop', route: () => 'a' },
    ],
    edges: [{ from: 'a', to: 'loop' }],
  }
  const result = await runGraph(graph, { input: 'go' }, { maxRevisitsPerNode: 3 })
  assert.equal(result.status, 'aborted')
  assert.match(result.reason ?? '', /visited more than 3 times/)
})

test('runtime aborts on maxSteps even without revisits', async () => {
  // Long chain: a -> b -> c, but maxSteps=2 stops before c finishes.
  const graph: AgentGraph = {
    entry: 'a',
    nodes: [
      { kind: 'agent', id: 'a', agent: stubAgent('') },
      { kind: 'agent', id: 'b', agent: stubAgent('') },
      { kind: 'agent', id: 'c', agent: stubAgent('') },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
    ],
  }
  const result = await runGraph(graph, { input: 'go' }, { maxSteps: 2 })
  assert.equal(result.status, 'aborted')
  assert.match(result.reason ?? '', /maxSteps 2/)
})

test('edge `when` guard skips and falls through to next matching edge', async () => {
  const graph: AgentGraph = {
    entry: 'plan',
    nodes: [
      { kind: 'agent', id: 'plan', agent: stubAgent('planned') },
      { kind: 'agent', id: 'cheap', agent: stubAgent('cheap-built') },
      { kind: 'agent', id: 'pro', agent: stubAgent('pro-built') },
    ],
    edges: [
      { from: 'plan', to: 'cheap', when: () => false },
      { from: 'plan', to: 'pro', when: () => true },
    ],
  }
  const result = await runGraph(graph, { input: 'go' })
  assert.equal(result.status, 'completed')
  assert.equal(result.finalNodeId, 'pro')
  assert.equal(result.outputs.cheap, undefined)
  assert.equal(result.outputs.pro?.kind, 'text')
})

test('human node yields approved/note output and feeds the router', async () => {
  const graph: AgentGraph = {
    entry: 'review',
    nodes: [
      {
        kind: 'human',
        id: 'review',
        ask: async () => ({ approved: true, note: 'lgtm' }),
      },
      {
        kind: 'router',
        id: 'gate',
        route: (ctx) => {
          const out = ctx.outputs.review
          return out?.kind === 'human' && out.approved ? null : 'reject'
        },
      },
      { kind: 'agent', id: 'reject', agent: stubAgent('rejected') },
    ],
    edges: [{ from: 'review', to: 'gate' }],
  }
  const result = await runGraph(graph, { input: 'ship?' })
  assert.equal(result.status, 'completed')
  const review = result.outputs.review
  assert.equal(review?.kind, 'human')
  if (review?.kind === 'human') {
    assert.equal(review.approved, true)
    assert.equal(review.note, 'lgtm')
  }
  // Reject branch must not have run.
  assert.equal(result.outputs.reject, undefined)
})

test('human node rejection routes to remediation branch', async () => {
  const graph: AgentGraph = {
    entry: 'review',
    nodes: [
      {
        kind: 'human',
        id: 'review',
        ask: async () => ({ approved: false, note: 'tests missing' }),
      },
      {
        kind: 'router',
        id: 'gate',
        route: (ctx) => {
          const out = ctx.outputs.review
          return out?.kind === 'human' && out.approved ? null : 'fix'
        },
      },
      { kind: 'agent', id: 'fix', agent: stubAgent('patched') },
    ],
    edges: [{ from: 'review', to: 'gate' }],
  }
  const result = await runGraph(graph, { input: 'ship?' })
  assert.equal(result.status, 'completed')
  assert.equal(result.outputs.fix?.kind, 'text')
})

test('onStep telemetry fires per node with output snapshots and survives callback errors', async () => {
  const seen: Array<{ id: string; kind: string; hasOutput: boolean }> = []
  const graph: AgentGraph = {
    entry: 'plan',
    nodes: [
      { kind: 'agent', id: 'plan', agent: stubAgent('planned') },
      { kind: 'agent', id: 'build', agent: stubAgent('built') },
    ],
    edges: [{ from: 'plan', to: 'build' }],
  }
  const result = await runGraph(
    graph,
    { input: 'go' },
    {
      onStep: (step) => {
        seen.push({ id: step.nodeId, kind: step.kind, hasOutput: step.output !== undefined })
        // Telemetry callbacks must not break the run, even when they throw.
        throw new Error('boom from telemetry')
      },
    },
  )
  assert.equal(result.status, 'completed')
  assert.deepEqual(
    seen,
    [
      { id: 'plan', kind: 'agent', hasOutput: true },
      { id: 'build', kind: 'agent', hasOutput: true },
    ],
  )
  // history has the same output snapshots
  assert.equal(result.history[0]!.output?.kind, 'text')
  assert.equal(result.history[1]!.output?.kind, 'text')
})
