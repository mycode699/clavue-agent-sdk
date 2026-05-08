/**
 * Example 26: Integrated v3 stack — Graph + Guardrail + Tracing composed.
 *
 * Demonstrates the three v3 axes wired together in one run, no engine
 * touch required. This is the composition story peer SDKs can't tell:
 *
 *   - v3.4 Guardrail: pre-flight `input` scope on the user prompt.
 *   - v3.1 Graph DSL: plan → verify → route → fix loop with stub agents.
 *   - v3.3 Live Tracing: TraceStore receives both the guardrail evaluation
 *                        AND every graph_step (auto-fed via `runGraph({ trace })`).
 *
 * The same TraceStore can then be serialized → shipped to a peer process →
 * replayed. Peer dashboards (openai-agents tracing) can only view; ours
 * can re-emit the run deterministically.
 *
 * Run:
 *
 *   npx tsx examples/26-integrated-stack.ts
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
  console.log('--- Example 26: Integrated Graph + Guardrail + Tracing ---\n')

  const store = new TraceStore()
  const runId = store.startRun({ graph: 'plan-verify-fix', stack: 'v3.1+v3.3+v3.4' })

  // 1. v3.4 Guardrail — pre-flight ------------------------------------------
  const rails = new GuardrailRegistry().add({
    name: 'no_api_keys_in_prompt',
    scope: 'input',
    check: (p) =>
      /sk-[a-z0-9]{6,}/i.test(String(p))
        ? { pass: false, message: 'API key in prompt' }
        : { pass: true },
  })

  const userPrompt = 'fix-bug-42'
  const inputEv = await rails.evaluate('input', userPrompt)
  store.appendGuardrail('input', inputEv)
  console.log(`guardrail(input) → passed=${inputEv.passed}`)

  // 2. v3.1 Graph + v3.3 Trace — auto-wired via runGraph({ trace }) --------
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

  // Notice: NO onStep wiring. `trace` alone composes graph + tracing.
  const result = await runGraph(graph, { input: userPrompt }, { trace: store })
  store.endRun(runId)
  console.log(`graph status: ${result.status}, history length: ${result.history.length}`)

  // 3. Inspect the trace -----------------------------------------------------
  const events = store.query(runId)
  console.log(`\ncaptured events (${events.length} total):`)
  for (const e of events) {
    console.log(`  ${e.kind.padEnd(11)}  span=${e.spanId ?? '-'}`)
  }

  // 4. Round-trip serialize → fresh store → replay --------------------------
  const json = store.serialize(runId)
  const fresh = new TraceStore()
  fresh.importRun(TraceStore.deserialize(json))

  console.log('\nreplay (graph_step only) on fresh store:')
  await fresh.replay(
    runId,
    (e, idx) => {
      const step = (e.data as { step: { nodeId: string; status: string } }).step
      console.log(`  ${String(idx).padStart(2)}. ${step.nodeId} [${step.status}]`)
    },
    { kinds: ['graph_step'] },
  )

  console.log(`\nJSON size: ${json.length} bytes`)
  console.log('\n— done —')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
