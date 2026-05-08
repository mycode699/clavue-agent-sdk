/**
 * Example 21: Live Tracing + Replay (v3.3 prototype)
 *
 * Records every graph step + guardrail evaluation into an in-memory TraceStore,
 * then serializes the whole run to JSON and replays it from a fresh store.
 *
 * The replay step is the v3.3 differentiator vs openai-agents tracing dashboard:
 * peer can view past runs, only clavue can re-emit events deterministically into
 * any consumer (UI, OTel exporter, regression harness …).
 *
 * No real LLM call. Run:
 *
 *   npx tsx examples/21-tracing-replay.ts
 *
 * @module
 */

import {
  GuardrailRegistry,
  StaticVerifier,
  TraceStore,
  runGraph,
} from '../src/index.js'
import type { AgentGraph, GraphAgentLike } from '../src/index.js'

const stub = (label: string): GraphAgentLike => ({
  async prompt(text) {
    return { text: `${label}(${text})` }
  },
})

async function main() {
  console.log('--- Example 21: Live Tracing + Replay ---\n')

  const store = new TraceStore()
  const runId = store.startRun({ graph: 'plan-verify-fix', model: 'stub' })

  // Pre-flight guardrail on the user prompt
  const rails = new GuardrailRegistry().add({
    name: 'no_api_keys_in_prompt',
    scope: 'input',
    check: (p) => (/sk-[a-z0-9]{6,}/i.test(String(p)) ? { pass: false, message: 'leak' } : { pass: true }),
  })
  const userPrompt = 'fix-bug-42'
  const inputEv = await rails.evaluate('input', userPrompt)
  store.appendGuardrail('input', inputEv)

  // Graph
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

  await runGraph(graph, { input: userPrompt }, {
    onStep: (step) => {
      store.appendGraphStep(step)
    },
  })

  store.endRun(runId)

  // ---- Inspect ----------------------------------------------------------
  const allEvents = store.query(runId)
  console.log('captured events:', allEvents.length)
  for (const e of allEvents) {
    console.log(`  ${e.kind.padEnd(11)}  span=${e.spanId ?? '-'}`)
  }

  // ---- Round-trip serialize → fresh store → replay ----------------------
  const json = store.serialize(runId)
  const fresh = new TraceStore()
  fresh.importRun(TraceStore.deserialize(json))

  console.log('\nreplay (graph_step only):')
  await fresh.replay(
    runId,
    (e, idx) => {
      const step = (e.data as { step: { nodeId: string; status: string } }).step
      console.log(`  ${String(idx).padStart(2)}. ${step.nodeId} [${step.status}]`)
    },
    { kinds: ['graph_step'] },
  )

  console.log(`\nJSON size: ${json.length} bytes`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
