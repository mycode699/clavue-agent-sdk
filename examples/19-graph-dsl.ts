/**
 * Example 19: Multi-Agent Graph DSL (v3.1 prototype)
 *
 * Wires the smallest meaningful pipeline using all 5 node kinds:
 *
 *   plan ──► fan(parallel) ─┬─► fe ─┐
 *                            └─► be ─┴─► verify ──► route ──► fix ──► verify (loop)
 *                                                                  │
 *                                                                  └─► review(human) ──► gate ──► (stop on approve)
 *
 * Uses stub agents, a flaky StaticVerifier, and an auto-approve human node —
 * NO real LLM call. Run:
 *
 *   npx tsx examples/19-graph-dsl.ts
 *
 * @module
 */

import { runGraph, StaticVerifier } from '../src/index.js'
import type { AgentGraph, GraphAgentLike } from '../src/index.js'

const stub = (label: string): GraphAgentLike => ({
  async prompt(text) {
    return { text: `${label}(${text})` }
  },
})

async function main() {
  console.log('--- Example 19: Graph DSL prototype ---\n')

  let attempt = 0
  const verifier = new StaticVerifier(() => {
    attempt += 1
    return attempt < 2
      ? [{ name: 'tests', status: 'failed', summary: 'one red' }]
      : [{ name: 'tests', status: 'passed' }]
  })

  const graph: AgentGraph = {
    entry: 'plan',
    nodes: [
      { kind: 'agent', id: 'plan', agent: stub('planned'), prompt: (ctx) => ctx.input },
      { kind: 'parallel', id: 'fan', branches: ['fe', 'be'], join: 'all' },
      { kind: 'agent', id: 'fe', agent: stub('frontend') },
      { kind: 'agent', id: 'be', agent: stub('backend') },
      { kind: 'verifier', id: 'verify', verifier },
      {
        kind: 'router',
        id: 'route',
        route: (ctx) => {
          const gates = ctx.gates.verify
          const passed = gates?.every((g) => g.status === 'passed') ?? false
          return passed ? 'review' : 'fix'
        },
      },
      { kind: 'agent', id: 'fix', agent: stub('patched') },
      {
        kind: 'human',
        id: 'review',
        ask: async () => ({ approved: true, note: 'auto-approved by example' }),
      },
      {
        kind: 'router',
        id: 'gate',
        route: (ctx) => {
          const r = ctx.outputs.review
          return r?.kind === 'human' && r.approved ? null : 'fix'
        },
      },
    ],
    edges: [
      { from: 'plan', to: 'fan' },
      { from: 'fan', to: 'verify' },
      { from: 'verify', to: 'route' },
      { from: 'fix', to: 'verify' },
      { from: 'review', to: 'gate' },
    ],
  }

  const trace: string[] = []
  const result = await runGraph(graph, { input: 'fix-bug-42' }, {
    onStep: (step) => {
      trace.push(`${step.nodeId}[${step.kind}/${step.status}]`)
    },
  })

  console.log('status         :', result.status)
  console.log('finalNodeId    :', result.finalNodeId)
  console.log('history (path) :', result.history.map((s) => s.nodeId).join(' → '))
  console.log('telemetry trace:', trace.join(' → '))
  console.log('gates.verify   :', result.gates.verify)
  console.log('review output  :', result.outputs.review)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
