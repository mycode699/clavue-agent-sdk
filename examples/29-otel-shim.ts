/**
 * Example 29: OTel SDK shim — bridge TraceStore → real OTel tracer.
 *
 * Demonstrates how a host wires the SDK into an existing OpenTelemetry
 * pipeline. The "tracer" here is a tiny in-memory stub so the example
 * runs offline; production hosts pass `trace.getTracer('my-app')` from
 * `@opentelemetry/api` instead — same shape, no code changes.
 *
 * Pipeline:
 *
 *   graph run → TraceStore events
 *             → eventToOtelSpan (already OTel-shaped)
 *             → OtelTraceExporter
 *             → host's real OTel tracer
 *             → Jaeger / Tempo / vendor backend
 *
 * Run:
 *
 *   npx tsx examples/29-otel-shim.ts
 *
 * @module
 */

import {
  GuardrailRegistry,
  OtelTraceExporter,
  TraceStore,
  eventToOtelSpan,
  runGraph,
} from '../src/index.js'
import type {
  AgentGraph,
  GraphAgentLike,
  OtelSpanHandleLike,
  OtelTracerLike,
} from '../src/index.js'

const stub = (label: string): GraphAgentLike => ({
  async prompt(text) {
    return { text: `${label}(${text})` }
  },
})

interface RecordedSpan {
  name: string
  start?: number
  end?: number
  attributes: Record<string, unknown>
  status?: { code: number; message?: string }
}

/** Minimal in-memory tracer that prints what a real OTel SDK would record. */
function createConsoleTracer(): { tracer: OtelTracerLike; spans: RecordedSpan[] } {
  const spans: RecordedSpan[] = []
  const tracer: OtelTracerLike = {
    startSpan(name, options) {
      const span: RecordedSpan = {
        name,
        ...(options?.startTime !== undefined ? { start: options.startTime } : {}),
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
        end(t) {
          if (t !== undefined) span.end = t
        },
      }
      return handle
    },
  }
  return { tracer, spans }
}

async function main() {
  console.log('--- Example 29: OTel SDK shim ---\n')

  // Build a small graph that emits one agent step + one guardrail event.
  const guardrails = new GuardrailRegistry().add({
    name: 'no_secret',
    scope: 'output',
    check: (text) =>
      typeof text === 'string' && /sk-[a-z0-9]+/i.test(text)
        ? { pass: false, message: 'API key in output' }
        : { pass: true },
  })

  const store = new TraceStore()
  const runId = store.startRun({ scenario: 'otel-shim-demo' })

  const graph: AgentGraph = {
    entry: 'plan',
    nodes: [
      { kind: 'agent', id: 'plan', agent: stub('plan') },
      { kind: 'agent', id: 'execute', agent: stub('execute') },
    ],
    edges: [{ from: 'plan', to: 'execute' }],
  }

  await runGraph(graph, { input: 'ship the feature' }, { trace: store, guardrails })
  store.endRun(runId)

  // Wire the host's OTel tracer (here: a console stub) through the shim.
  const { tracer, spans } = createConsoleTracer()
  const exporter = new OtelTraceExporter(tracer)
  const otelShape = store.query(runId).map(eventToOtelSpan)

  // One call exports every recorded span to the host SDK.
  exporter.export(otelShape)

  console.log(`Wrote ${spans.length} spans to the host OTel tracer:\n`)
  for (const s of spans) {
    const dur = s.start !== undefined && s.end !== undefined ? `${s.end - s.start}ms` : '-'
    const status =
      s.status === undefined ? '   ' : s.status.code === 2 ? 'ERR' : 'OK '
    const attrs = Object.entries(s.attributes)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ')
    console.log(`  [${status}] ${s.name.padEnd(28)} dur=${dur.padStart(6)}  ${attrs}`)
  }

  console.log('\n— done —')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
