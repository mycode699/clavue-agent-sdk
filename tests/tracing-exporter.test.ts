import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ConsoleExporter,
  JsonlExporter,
  TraceStore,
  eventToOtelSpan,
} from '../src/tracing/index.ts'
import { runGraph } from '../src/graph/index.ts'
import { GuardrailRegistry } from '../src/guardrails/index.ts'
import type { AgentGraph, GraphAgentLike } from '../src/graph/index.ts'

const stub = (label: string): GraphAgentLike => ({
  async prompt(text) {
    return { text: `${label}(${text})` }
  },
})

test('eventToOtelSpan: graph_step → graph.step.<kind> with semconv attrs', () => {
  const span = eventToOtelSpan({
    kind: 'graph_step',
    at: 1000,
    runId: 'r1',
    spanId: 'plan',
    data: {
      step: {
        nodeId: 'plan',
        kind: 'agent',
        status: 'ok',
        startedAt: 100,
        endedAt: 200,
        output: { kind: 'text', text: 'hi' },
      },
    },
  })
  assert.equal(span.name, 'graph.step.agent')
  assert.equal(span.traceId, 'r1')
  assert.equal(span.spanId, 'plan')
  assert.equal(span.startTime, 100)
  assert.equal(span.endTime, 200)
  assert.equal(span.attributes['graph.node_id'], 'plan')
  assert.equal(span.attributes['graph.status'], 'ok')
  assert.equal(span.attributes['graph.output.kind'], 'text')
  assert.equal(span.status?.code, 'ok')
})

test('eventToOtelSpan: failed graph_step → status=error', () => {
  const span = eventToOtelSpan({
    kind: 'graph_step',
    at: 1,
    runId: 'r',
    data: {
      step: {
        nodeId: 'x', kind: 'agent', status: 'failed',
        startedAt: 0, endedAt: 1,
      },
    },
  })
  assert.equal(span.status?.code, 'error')
})

test('eventToOtelSpan: guardrail → guardrail.<scope> + violation count', () => {
  const span = eventToOtelSpan({
    kind: 'guardrail',
    at: 100,
    runId: 'r',
    data: {
      scope: 'output',
      evaluation: {
        passed: false,
        violations: [
          { guardrail: 'no_secret', scope: 'output', blocking: true },
        ],
      },
      agentId: 'plan',
    },
  })
  assert.equal(span.name, 'guardrail.output')
  assert.equal(span.attributes['guardrail.scope'], 'output')
  assert.equal(span.attributes['guardrail.passed'], false)
  assert.equal(span.attributes['guardrail.violation_count'], 1)
  assert.equal(span.attributes['guardrail.violations'], 'no_secret')
  assert.equal(span.attributes['agent.id'], 'plan')
  assert.equal(span.status?.code, 'error')
})

test('eventToOtelSpan: tool_call → tool.<phase>.<name>', () => {
  const span = eventToOtelSpan({
    kind: 'tool_call',
    at: 50,
    runId: 'r',
    data: { toolName: 'Bash', phase: 'request', input: { cmd: 'ls' } },
  })
  assert.equal(span.name, 'tool.request.Bash')
  assert.equal(span.attributes['tool.name'], 'Bash')
  assert.equal(span.attributes['tool.phase'], 'request')
})

test('eventToOtelSpan: unknown kind → trace.<kind> passthrough', () => {
  const span = eventToOtelSpan({
    kind: 'note',
    at: 1,
    runId: 'r',
    data: { msg: 'hello' },
  })
  assert.equal(span.name, 'trace.note')
  assert.deepEqual(span.attributes['trace.data'], { msg: 'hello' })
})

test('eventToOtelSpan: missing runId → traceId=<no-run>', () => {
  const span = eventToOtelSpan({
    kind: 'note',
    at: 1,
    data: { msg: 'x' },
  })
  assert.equal(span.traceId, '<no-run>')
})

test('JsonlExporter: collects one JSON line per span; drain empties buffer', () => {
  const exp = new JsonlExporter()
  exp.export([
    { name: 'a', traceId: 't', startTime: 1, attributes: { k: 1 } },
    { name: 'b', traceId: 't', startTime: 2, attributes: {} },
  ])
  assert.equal(exp.size(), 2)
  const out = exp.drain()
  assert.equal(exp.size(), 0)
  const lines = out.split('\n')
  assert.equal(lines.length, 2)
  assert.deepEqual(JSON.parse(lines[0]!).name, 'a')
})

test('ConsoleExporter: writes one formatted line per span', () => {
  const lines: string[] = []
  const exp = new ConsoleExporter((l) => lines.push(l))
  exp.export([
    {
      name: 'graph.step.agent',
      traceId: 'r1',
      startTime: 100,
      endTime: 250,
      attributes: { 'graph.node_id': 'plan', 'graph.status': 'ok' },
      status: { code: 'ok' },
    },
  ])
  assert.equal(lines.length, 1)
  const line = lines[0]!
  assert.match(line, /\[OK \]/)
  assert.match(line, /graph\.step\.agent/)
  assert.match(line, /dur=\s*150ms/)
  assert.match(line, /graph\.node_id=plan/)
})

test('ConsoleExporter: error status renders as [ERR]', () => {
  const lines: string[] = []
  const exp = new ConsoleExporter((l) => lines.push(l))
  exp.export([
    { name: 'x', traceId: 't', startTime: 0, attributes: {}, status: { code: 'error' } },
  ])
  assert.match(lines[0]!, /\[ERR\]/)
})

test('end-to-end: TraceStore → exporter ships every event as a span', async () => {
  const store = new TraceStore()
  const runId = store.startRun({ graph: 'demo' })

  const reg = new GuardrailRegistry().add({
    name: 'pass',
    scope: 'output',
    check: () => ({ pass: true }),
  })

  const graph: AgentGraph = {
    entry: 'a',
    nodes: [
      { kind: 'agent', id: 'a', agent: stub('A') },
      { kind: 'agent', id: 'b', agent: stub('B') },
    ],
    edges: [{ from: 'a', to: 'b' }],
  }

  await runGraph(graph, { input: 'go' }, { trace: store, guardrails: reg })
  store.endRun(runId)

  const events = store.query(runId)
  // 2 graph_step + 2 guardrail (one after each agent step)
  assert.equal(events.length, 4)

  const exp = new JsonlExporter()
  exp.export(events.map(eventToOtelSpan))
  const lines = exp.drain().split('\n').map((l) => JSON.parse(l) as { name: string; traceId: string })
  assert.deepEqual(lines.map((s) => s.name), [
    'graph.step.agent',
    'guardrail.output',
    'graph.step.agent',
    'guardrail.output',
  ])
  // Every span carries the run id as traceId.
  for (const s of lines) assert.equal(s.traceId, runId)
})
