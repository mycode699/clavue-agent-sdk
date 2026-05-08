/**
 * OTel SDK shim test (v3.3 follow-up).
 *
 * Verifies `OtelTraceExporter` forwards `OtelSpanLike` records into a
 * host-supplied tracer in the same shape that `@opentelemetry/api`
 * expects. We stub the tracer surface — no real OTel install needed.
 *
 * @module
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  OtelTraceExporter,
  TraceStore,
  eventToOtelSpan,
  runGraph,
  type AgentGraph,
  type GraphAgentLike,
  type OtelSpanHandleLike,
  type OtelTracerLike,
} from '../src/index.ts'

interface RecordedSpan {
  name: string
  startTime?: number
  endTime?: number
  attributes: Record<string, unknown>
  status?: { code: number; message?: string }
}

function stubTracer(): { tracer: OtelTracerLike; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = []
  const tracer: OtelTracerLike = {
    startSpan(name, options) {
      const span: RecordedSpan = {
        name,
        ...(options?.startTime !== undefined ? { startTime: options.startTime } : {}),
        attributes: { ...(options?.attributes ?? {}) },
      }
      spans.push(span)
      const handle: OtelSpanHandleLike = {
        setAttribute(key, value) {
          span.attributes[key] = value
          return handle
        },
        setStatus(status) {
          span.status = { ...status }
          return handle
        },
        end(endTime) {
          if (endTime !== undefined) span.endTime = endTime
        },
      }
      return handle
    },
  }
  return { tracer, spans }
}

const stubAgent = (label: string): GraphAgentLike => ({
  async prompt(text) {
    return { text: `${label}(${text})` }
  },
})

test('OtelTraceExporter forwards a single span with status code OK', () => {
  const { tracer, spans } = stubTracer()
  const exporter = new OtelTraceExporter(tracer)

  exporter.export([
    {
      name: 'graph.step.agent',
      traceId: 't1',
      startTime: 1_000,
      endTime: 1_050,
      attributes: { 'graph.node_id': 'node-a', 'graph.kind': 'agent' },
      status: { code: 'ok' },
    },
  ])

  assert.equal(spans.length, 1)
  const s = spans[0]!
  assert.equal(s.name, 'graph.step.agent')
  assert.equal(s.startTime, 1_000)
  assert.equal(s.endTime, 1_050)
  assert.equal(s.attributes['graph.node_id'], 'node-a')
  assert.equal(s.attributes['graph.kind'], 'agent')
  assert.equal(s.status?.code, 1) // OTel SpanStatusCode.OK
})

test('OtelTraceExporter maps status=error to OTel ERROR (code=2) with message', () => {
  const { tracer, spans } = stubTracer()
  const exporter = new OtelTraceExporter(tracer)

  exporter.export([
    {
      name: 'guardrail.tool_input',
      traceId: 't2',
      startTime: 2_000,
      attributes: { 'guardrail.scope': 'tool_input', 'guardrail.passed': false },
      status: { code: 'error', message: 'API key in input' },
    },
  ])

  assert.equal(spans.length, 1)
  const s = spans[0]!
  assert.equal(s.status?.code, 2) // OTel SpanStatusCode.ERROR
  assert.equal(s.status?.message, 'API key in input')
})

test('OtelTraceExporter survives setAttribute/setStatus exceptions (telemetry never breaks runs)', () => {
  const spans: RecordedSpan[] = []
  const tracer: OtelTracerLike = {
    startSpan(name) {
      const span: RecordedSpan = { name, attributes: {} }
      spans.push(span)
      return {
        setAttribute() {
          throw new Error('attr explode')
        },
        setStatus() {
          throw new Error('status explode')
        },
        end() {
          // ok
        },
      }
    },
  }

  const exporter = new OtelTraceExporter(tracer)
  // Must not throw — telemetry pipeline is best-effort.
  exporter.export([
    {
      name: 'tool.request.bash',
      traceId: 't3',
      startTime: 3_000,
      attributes: { 'tool.name': 'bash' },
      status: { code: 'error' },
    },
  ])

  assert.equal(spans.length, 1)
})

test('OtelTraceExporter rejects null/invalid tracer at construction', () => {
  assert.throws(() => new OtelTraceExporter(null as unknown as OtelTracerLike), /tracer\.startSpan/)
  assert.throws(() => new OtelTraceExporter({} as unknown as OtelTracerLike), /tracer\.startSpan/)
})

test('end-to-end: graph run → TraceStore → eventToOtelSpan → OtelTraceExporter emits real spans', async () => {
  const { tracer, spans } = stubTracer()
  const store = new TraceStore()
  const runId = store.startRun({ scenario: 'otel-shim' })

  const graph: AgentGraph = {
    entry: 'a',
    nodes: [{ kind: 'agent', id: 'a', agent: stubAgent('hello') }],
    edges: [],
  }

  await runGraph(graph, { input: 'world' }, { trace: store })
  store.endRun(runId)

  const exporter = new OtelTraceExporter(tracer)
  exporter.export(store.query(runId).map(eventToOtelSpan))

  assert.equal(spans.length, 1)
  assert.equal(spans[0]!.name, 'graph.step.agent')
  assert.equal(spans[0]!.attributes['graph.node_id'], 'a')
  assert.equal(spans[0]!.status?.code, 1)
})
