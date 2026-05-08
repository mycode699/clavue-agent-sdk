import test from 'node:test'
import assert from 'node:assert/strict'

import { TraceStore } from '../src/tracing/index.ts'
import { runGraph } from '../src/graph/index.ts'
import { GuardrailRegistry } from '../src/guardrails/index.ts'
import type { AgentGraph, GraphAgentLike } from '../src/graph/index.ts'

const stub = (label: string): GraphAgentLike => ({
  async prompt(text) {
    return { text: `${label}(${text})` }
  },
})

test('startRun creates a run and records meta + active state', () => {
  const store = new TraceStore()
  const id = store.startRun({ graph: 'demo', model: 'stub' })
  const run = store.getRun(id)
  assert.equal(run?.id, id)
  assert.equal(run?.meta.graph, 'demo')
  assert.equal(typeof run?.startedAt, 'number')
  assert.equal(run?.events.length, 0)
})

test('startRun rejects duplicate ids', () => {
  const store = new TraceStore()
  store.startRun({}, 'fixed-id')
  assert.throws(() => store.startRun({}, 'fixed-id'), /already exists/)
})

test('append before startRun throws; appends record runId + spanId', () => {
  const store = new TraceStore()
  assert.throws(
    () => store.append({ kind: 'note', data: {} }),
    /no active run/,
  )
  const id = store.startRun()
  const idx = store.append({ kind: 'note', data: { msg: 'hi' }, spanId: 'agent-a' })
  assert.equal(idx, 0)
  const events = store.query(id)
  assert.equal(events.length, 1)
  assert.equal(events[0]!.runId, id)
  assert.equal(events[0]!.spanId, 'agent-a')
  const data = events[0]!.data as { msg: string }
  assert.equal(data.msg, 'hi')
})

test('query filters by kind and span and index range', () => {
  const store = new TraceStore()
  const id = store.startRun()
  store.append({ kind: 'a', data: 1, spanId: 's1' })
  store.append({ kind: 'b', data: 2, spanId: 's2' })
  store.append({ kind: 'a', data: 3, spanId: 's1' })
  store.append({ kind: 'a', data: 4, spanId: 's2' })

  const aOnly = store.query(id, { kinds: ['a'] })
  assert.equal(aOnly.length, 3)

  const s1Only = store.query(id, { spanId: 's1' })
  assert.deepEqual(s1Only.map((e) => e.data), [1, 3])

  const aS2 = store.query(id, { kinds: ['a'], spanId: 's2' })
  assert.deepEqual(aS2.map((e) => e.data), [4])

  const sliced = store.query(id, { fromIndex: 1, toIndex: 3 })
  assert.equal(sliced.length, 2)
})

test('appendGraphStep / appendGuardrail / appendToolCall write structured events', () => {
  const store = new TraceStore()
  const runId = store.startRun()
  store.appendGraphStep({
    nodeId: 'plan',
    kind: 'agent',
    status: 'ok',
    startedAt: 1,
    endedAt: 2,
    output: { kind: 'text', text: 'planned' },
  })
  store.appendGuardrail(
    'tool_input',
    { passed: false, violations: [{ guardrail: 'no_rm', scope: 'tool_input', blocking: true }] },
    { toolName: 'Bash' },
  )
  store.appendToolCall({ toolName: 'Read', phase: 'request', input: { file: 'x' } })

  const events = store.query(runId)
  assert.deepEqual(events.map((e) => e.kind), ['graph_step', 'guardrail', 'tool_call'])
  assert.equal(events[0]!.spanId, 'plan')
  assert.equal(events[1]!.spanId, 'tool:Bash')
  assert.equal(events[2]!.spanId, 'tool:Read')
})

test('replay re-emits events in order, supports from / kinds filter, returns count', async () => {
  const store = new TraceStore()
  store.startRun({}, 'r1')
  store.append({ kind: 'a', data: 1 })
  store.append({ kind: 'b', data: 2 })
  store.append({ kind: 'a', data: 3 })
  store.append({ kind: 'b', data: 4 })

  const seenAll: number[] = []
  const replayedAll = await store.replay('r1', (e) => {
    seenAll.push((e.data as number))
  })
  assert.equal(replayedAll, 4)
  assert.deepEqual(seenAll, [1, 2, 3, 4])

  const seenA: number[] = []
  const replayedA = await store.replay(
    'r1',
    (e) => {
      seenA.push(e.data as number)
    },
    { kinds: ['a'] },
  )
  assert.equal(replayedA, 2)
  assert.deepEqual(seenA, [1, 3])

  const seenFrom: number[] = []
  await store.replay('r1', (e) => {
    seenFrom.push(e.data as number)
  }, { from: 2 })
  assert.deepEqual(seenFrom, [3, 4])
})

test('serialize → deserialize round-trip yields identical events', () => {
  const store = new TraceStore()
  const id = store.startRun({ graph: 'g' }, 'rrr')
  store.append({ kind: 'graph_step', data: { foo: 1 } })
  store.append({ kind: 'tool_call', data: { bar: 2 }, spanId: 'tool:Bash' })
  store.endRun(id)

  const json = store.serialize(id)
  const parsed = TraceStore.deserialize(json)
  assert.equal(parsed.id, id)
  assert.equal(parsed.events.length, 2)

  // import into a fresh store and re-query
  const fresh = new TraceStore()
  fresh.importRun(parsed)
  const out = fresh.query('rrr')
  assert.equal(out.length, 2)
  assert.equal(out[1]!.spanId, 'tool:Bash')
})

test('TraceStore.deserialize rejects malformed payload', () => {
  assert.throws(() => TraceStore.deserialize('null'), /malformed payload/)
  assert.throws(() => TraceStore.deserialize('{"id":"x"}'), /malformed payload/)
})

test('endRun is idempotent and clears active', () => {
  const store = new TraceStore()
  const id = store.startRun()
  store.endRun(id)
  store.endRun(id)
  const run = store.getRun(id)
  assert.equal(typeof run?.endedAt, 'number')
  assert.throws(() => store.append({ kind: 'late', data: {} }), /no active run/)
})

test('integration: graph onStep feeds TraceStore, replay reproduces history', async () => {
  const store = new TraceStore()
  const runId = store.startRun({ graph: 'plan-build' })

  const graph: AgentGraph = {
    entry: 'plan',
    nodes: [
      { kind: 'agent', id: 'plan', agent: stub('planned') },
      { kind: 'agent', id: 'build', agent: stub('built') },
    ],
    edges: [{ from: 'plan', to: 'build' }],
  }

  const result = await runGraph(graph, { input: 'go' }, {
    onStep: (step) => {
      store.appendGraphStep(step)
    },
  })
  store.endRun(runId)

  assert.equal(result.status, 'completed')
  const events = store.query(runId, { kinds: ['graph_step'] })
  assert.deepEqual(
    events.map((e) => (e.data as { step: { nodeId: string } }).step.nodeId),
    ['plan', 'build'],
  )

  // Replay reconstructs the same node order (peer dashboards cannot do this)
  const replayed: string[] = []
  await store.replay(runId, (e) => {
    if (e.kind !== 'graph_step') return
    replayed.push((e.data as { step: { nodeId: string } }).step.nodeId)
  })
  assert.deepEqual(replayed, ['plan', 'build'])
})

test('integration: guardrail evaluation can be appended verbatim', async () => {
  const store = new TraceStore()
  const id = store.startRun()
  const reg = new GuardrailRegistry().add({
    name: 'no_secrets',
    scope: 'input',
    check: (p) => (/sk-/.test(String(p)) ? { pass: false, message: 'secret' } : { pass: true }),
  })
  const ev = await reg.evaluate('input', 'use sk-key-here')
  store.appendGuardrail('input', ev)

  const events = store.query(id, { kinds: ['guardrail'] })
  assert.equal(events.length, 1)
  const data = events[0]!.data as { evaluation: { passed: boolean } }
  assert.equal(data.evaluation.passed, false)
})

test('integration: runGraph(trace) auto-appends graph_step events', async () => {
  const store = new TraceStore()
  const runId = store.startRun({ graph: 'auto-trace' })

  const graph: AgentGraph = {
    entry: 'a',
    nodes: [
      { kind: 'agent', id: 'a', agent: stub('A') },
      { kind: 'agent', id: 'b', agent: stub('B') },
    ],
    edges: [{ from: 'a', to: 'b' }],
  }

  // No onStep wiring — `trace` option alone is enough.
  const result = await runGraph(graph, { input: 'go' }, { trace: store })
  store.endRun(runId)

  assert.equal(result.status, 'completed')
  const events = store.query(runId, { kinds: ['graph_step'] })
  assert.deepEqual(
    events.map((e) => (e.data as { step: { nodeId: string } }).step.nodeId),
    ['a', 'b'],
  )
})

test('integration: runGraph(trace + onStep) feeds both sinks', async () => {
  const store = new TraceStore()
  store.startRun()

  const seen: string[] = []
  const graph: AgentGraph = {
    entry: 'x',
    nodes: [{ kind: 'agent', id: 'x', agent: stub('X') }],
    edges: [],
  }

  await runGraph(graph, { input: 'go' }, {
    trace: store,
    onStep: (s) => seen.push(s.nodeId),
  })

  // Both sinks see the step.
  assert.deepEqual(seen, ['x'])
  const events = store.query(store.listRunIds()[0]!, { kinds: ['graph_step'] })
  assert.equal(events.length, 1)
})

test('integration: runGraph(guardrails) aborts on output violation by default', async () => {
  const reg = new (await import('../src/guardrails/index.ts')).GuardrailRegistry().add({
    name: 'no_planned',
    scope: 'output',
    check: (text) =>
      String(text).includes('planned') ? { pass: false, message: 'forbidden' } : { pass: true },
  })

  const graph: AgentGraph = {
    entry: 'plan',
    nodes: [
      { kind: 'agent', id: 'plan', agent: stub('planned') },
      { kind: 'agent', id: 'next', agent: stub('next') },
    ],
    edges: [{ from: 'plan', to: 'next' }],
  }

  const result = await runGraph(graph, { input: 'go' }, { guardrails: reg })
  assert.equal(result.status, 'aborted')
  assert.match(String(result.reason), /no_planned/)
  // Should NOT have visited 'next'.
  assert.deepEqual(result.history.map((s) => s.nodeId), ['plan'])
})

test('integration: runGraph(guardrails + onViolation=continue) keeps running', async () => {
  const reg = new (await import('../src/guardrails/index.ts')).GuardrailRegistry().add({
    name: 'noisy',
    scope: 'output',
    check: () => ({ pass: false, message: 'always fail' }),
  })

  const graph: AgentGraph = {
    entry: 'a',
    nodes: [
      { kind: 'agent', id: 'a', agent: stub('A') },
      { kind: 'agent', id: 'b', agent: stub('B') },
    ],
    edges: [{ from: 'a', to: 'b' }],
  }

  const violations: string[] = []
  const result = await runGraph(graph, { input: 'go' }, {
    guardrails: reg,
    onViolation: (ev, step) => {
      violations.push(`${step.nodeId}:${ev.violations[0]!.guardrail}`)
      return 'continue'
    },
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(violations, ['a:noisy', 'b:noisy'])
  assert.deepEqual(result.history.map((s) => s.nodeId), ['a', 'b'])
})

test('integration: runGraph(guardrails + trace) auto-appends guardrail events', async () => {
  const reg = new (await import('../src/guardrails/index.ts')).GuardrailRegistry().add({
    name: 'pass_through',
    scope: 'output',
    check: () => ({ pass: true }),
  })
  const store = new TraceStore()
  const runId = store.startRun()

  const graph: AgentGraph = {
    entry: 'only',
    nodes: [{ kind: 'agent', id: 'only', agent: stub('only') }],
    edges: [],
  }

  await runGraph(graph, { input: 'go' }, { guardrails: reg, trace: store })
  store.endRun(runId)

  const events = store.query(runId)
  // 1 graph_step + 1 guardrail (output scope on the agent step).
  assert.deepEqual(events.map((e) => e.kind), ['graph_step', 'guardrail'])
  const guardrailData = events[1]!.data as { scope: string; agentId?: string }
  assert.equal(guardrailData.scope, 'output')
  assert.equal(guardrailData.agentId, 'only')
})

test('integration: onViolation thrown error → abort (defensive)', async () => {
  const reg = new (await import('../src/guardrails/index.ts')).GuardrailRegistry().add({
    name: 'fail',
    scope: 'output',
    check: () => ({ pass: false, message: 'x' }),
  })

  const graph: AgentGraph = {
    entry: 'a',
    nodes: [{ kind: 'agent', id: 'a', agent: stub('A') }],
    edges: [],
  }

  const result = await runGraph(graph, { input: 'go' }, {
    guardrails: reg,
    onViolation: () => {
      throw new Error('policy bug')
    },
  })
  assert.equal(result.status, 'aborted')
})
