/**
 * Example 27: Trace exporter — OTel-shape spans + console + JSONL (v3.3 ext)
 *
 * Wires v3.1 Graph + v3.4 Guardrails + v3.3 Tracing into a run, then ships
 * the recorded events as OpenTelemetry-shape spans through:
 *   1. ConsoleExporter — one human-readable line per span
 *   2. JsonlExporter   — one JSON line per span (vendor-neutral, ready for
 *                         file → Loki / Splunk / Tempo / Datadog)
 *
 * The OtelSpanLike shape mirrors OpenTelemetry's ReadableSpan without
 * importing @opentelemetry/api. Hosts wrap it with their real OTel SDK.
 *
 * Run:
 *
 *   npx tsx examples/27-trace-exporter.ts
 *
 * @module
 */

import {
  ConsoleExporter,
  GuardrailRegistry,
  JsonlExporter,
  StaticVerifier,
  TraceStore,
  eventToOtelSpan,
  runGraph,
} from '../src/index.js'
import type { AgentGraph, GraphAgentLike } from '../src/index.js'

const stub = (label: string): GraphAgentLike => ({
  async prompt(text) {
    return { text: `${label}(${text})` }
  },
})

async function main() {
  console.log('--- Example 27: Trace exporter (OTel-shape spans) ---\n')

  const store = new TraceStore()
  const runId = store.startRun({ graph: 'plan-verify-fix', stack: 'v3.1+v3.3+v3.4' })

  const rails = new GuardrailRegistry().add({
    name: 'no_api_keys',
    scope: 'output',
    check: (text) =>
      /sk-[a-z0-9]{6,}/i.test(String(text))
        ? { pass: false, message: 'leak' }
        : { pass: true },
  })

  let attempt = 0
  const verifier = new StaticVerifier(() => {
    attempt += 1
    return attempt < 2
      ? [{ name: 'tests', status: 'failed', summary: 'red' }]
      : [{ name: 'tests', status: 'passed' }]
  })

  const graph: AgentGraph = {
    entry: 'plan',
    nodes: [
      { kind: 'agent', id: 'plan', agent: stub('planned') },
      { kind: 'verifier', id: 'verify', verifier },
      {
        kind: 'router',
        id: 'route',
        route: (ctx) => {
          const g = ctx.gates.verify
          return g?.every((x) => x.status === 'passed') ? null : 'fix'
        },
      },
      { kind: 'agent', id: 'fix', agent: stub('patched') },
    ],
    edges: [
      { from: 'plan', to: 'verify' },
      { from: 'verify', to: 'route' },
      { from: 'fix', to: 'verify' },
    ],
  }

  await runGraph(graph, { input: 'fix-bug-42' }, {
    trace: store,
    guardrails: rails,
  })
  store.endRun(runId)

  const events = store.query(runId)
  const spans = events.map(eventToOtelSpan)
  console.log(`captured ${events.length} events → ${spans.length} OTel spans\n`)

  // 1. Console exporter
  console.log('=== ConsoleExporter ===')
  const consoleExp = new ConsoleExporter()
  consoleExp.export(spans)

  // 2. JSONL exporter
  console.log('\n=== JsonlExporter (ready for Loki / Splunk / Tempo / Datadog) ===')
  const jsonl = new JsonlExporter()
  jsonl.export(spans)
  const blob = jsonl.drain()
  const lines = blob.split('\n')
  console.log(`${lines.length} JSON lines, ${blob.length} bytes total. First line:\n`)
  console.log(JSON.stringify(JSON.parse(lines[0]!), null, 2))

  console.log('\n— done —')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
