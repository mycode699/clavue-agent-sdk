/**
 * Example 28: RAG graph — retriever node kind (RFC D4, v3.5 integration)
 *
 * Demonstrates the new `kind: 'retriever'` graph node:
 *
 *   question → [retriever] → [agent (reads hits from ctx)] → answer
 *
 * No LLM call — the "agent" is a stub so the example runs fully offline.
 * Swap `InMemoryRetriever` with pgvector / Qdrant / Pinecone behind the
 * same `Retriever` interface for real deployments. Swap the stub agent
 * with `new Agent({…}).prompt` for real inference.
 *
 * Run:
 *
 *   npx tsx examples/28-rag-graph.ts
 *
 * @module
 */

import { runGraph, InMemoryRetriever, TraceStore, eventToOtelSpan } from '../src/index.js'
import type { AgentGraph, GraphAgentLike } from '../src/index.js'

const stub = (label: string): GraphAgentLike => ({
  async prompt(text) {
    return { text: `${label}: ${text}` }
  },
})

/** Toy embedder. Stable token-bag hashing — zero dependencies, zero network. */
function toyEmbed(text: string): number[] {
  const dim = 24
  const v = new Array<number>(dim).fill(0)
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0
    for (let i = 0; i < tok.length; i += 1) h = (h * 31 + tok.charCodeAt(i)) >>> 0
    v[h % dim] += 1
  }
  return v
}

async function main() {
  console.log('--- Example 28: RAG graph (v3.5 retriever node) ---\n')

  const retriever = new InMemoryRetriever({ embed: toyEmbed })
  await retriever.add([
    { id: 'doc-fr', text: 'The capital of France is Paris.', metadata: { lang: 'en' } },
    { id: 'doc-de', text: 'The capital of Germany is Berlin.', metadata: { lang: 'en' } },
    { id: 'doc-jp', text: 'The capital of Japan is Tokyo.', metadata: { lang: 'en' } },
    { id: 'doc-fr-fr', text: 'La capitale de la France est Paris.', metadata: { lang: 'fr' } },
  ])

  const store = new TraceStore()
  const runId = store.startRun({ scenario: 'rag-graph-v3.5' })

  const graph: AgentGraph = {
    entry: 'rag',
    nodes: [
      {
        kind: 'retriever',
        id: 'rag',
        retriever,
        topK: 2,
        where: { lang: 'en' },
      },
      {
        kind: 'agent',
        id: 'qa',
        agent: stub('answer'),
        prompt: (ctx) => {
          const r = ctx.outputs.rag
          if (r?.kind !== 'retrieval') return ctx.input
          const ctxBlock = r.hits
            .map((h, i) => `  [${i + 1}] ${h.text}  (score=${h.score.toFixed(3)})`)
            .join('\n')
          return `Q: ${ctx.input}\nContext:\n${ctxBlock}`
        },
      },
    ],
    edges: [{ from: 'rag', to: 'qa' }],
  }

  const result = await runGraph(graph, { input: 'capital of France' }, { trace: store })
  store.endRun(runId)

  console.log('graph status:', result.status)
  console.log('visited:', result.history.map((h) => `${h.nodeId}(${h.kind}/${h.status})`).join(' → '))
  console.log()

  const ragOut = result.outputs.rag
  if (ragOut?.kind === 'retrieval') {
    console.log(`retrieved ${ragOut.hits.length} hit(s) for query "${ragOut.query}":`)
    for (const h of ragOut.hits) {
      console.log(`  - ${h.id}  score=${h.score.toFixed(3)}  "${h.text}"`)
    }
  }
  console.log()

  const qaOut = result.outputs.qa
  if (qaOut?.kind === 'text') {
    console.log('final answer:')
    console.log(qaOut.text)
  }
  console.log()

  // Show trace → OTel spans — the retriever step is a first-class OTel span
  // with graph.step.retriever name and retrieval.hit_count attribute.
  console.log('=== OTel spans ===')
  for (const span of store.query(runId).map(eventToOtelSpan)) {
    const attrs = Object.entries(span.attributes)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join(' ')
    console.log(`  ${span.name.padEnd(24)}  ${attrs}`)
  }

  console.log('\n— done —')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
