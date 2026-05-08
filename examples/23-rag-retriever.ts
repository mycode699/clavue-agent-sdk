/**
 * Example 23: RAG retriever (v3.5 prototype)
 *
 * Provider-agnostic Retriever interface + reference InMemoryRetriever.
 * Demonstrates ingestion, semantic search, metadata filter, and how the
 * same Retriever surface lets callers swap pgvector / Qdrant / Pinecone
 * without changing call sites.
 *
 * No real LLM call. Toy embedding hashes tokens into a tiny dense vector
 * — good enough to show ranking, not for production.
 *
 * Run:
 *
 *   npx tsx examples/23-rag-retriever.ts
 *
 * @module
 */

import { InMemoryRetriever } from '../src/index.js'
import type { Retriever } from '../src/index.js'

function toyEmbed(text: string): number[] {
  const dims = 16
  const v = new Array<number>(dims).fill(0)
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)) {
    let h = 0
    for (let i = 0; i < word.length; i += 1) h = (h * 31 + word.charCodeAt(i)) & 0xffffffff
    v[Math.abs(h) % dims] += 1
  }
  return v
}

async function showHits(label: string, retriever: Retriever, query: { text: string; topK?: number; where?: Record<string, unknown> }) {
  const hits = await retriever.retrieve(query)
  console.log(`\n${label}`)
  console.log(`  query: "${query.text}"${query.where ? `  where=${JSON.stringify(query.where)}` : ''}`)
  for (const h of hits) {
    console.log(`  ${h.score.toFixed(3)}  ${h.id.padEnd(16)}  ${h.text}`)
  }
}

async function main() {
  console.log('--- Example 23: RAG retriever ---')

  const retriever = new InMemoryRetriever({ embed: toyEmbed })

  await retriever.add([
    {
      id: 'graph-dsl',
      text: 'Graph DSL adds verifier, router, parallel, and human nodes to extend openai handoffs',
      metadata: { axis: 'v3.1', visibility: 'public' },
    },
    {
      id: 'guardrails',
      text: 'Guardrails support 4 scopes: input, output, tool_input, tool_output',
      metadata: { axis: 'v3.4', visibility: 'public' },
    },
    {
      id: 'tracing',
      text: 'TraceStore records graph_step, guardrail, tool_call events and supports replay',
      metadata: { axis: 'v3.3', visibility: 'public' },
    },
    {
      id: 'sandbox',
      text: 'Capability tokens grant fs.read or net.fetch with maxUses, expiresAt, revoke',
      metadata: { axis: 'v3.2', visibility: 'public' },
    },
    {
      id: 'internal-design',
      text: 'Internal note: graph router decisions are pure functions, not LLM calls',
      metadata: { axis: 'v3.1', visibility: 'private' },
    },
  ])
  console.log(`\ningested ${retriever.count()} docs`)

  await showHits('1. semantic search (top-3)', retriever, {
    text: 'how do I plug guardrails into tool calls',
    topK: 3,
  })

  await showHits('2. metadata filter (visibility=public)', retriever, {
    text: 'router and verifier nodes',
    topK: 5,
    where: { visibility: 'public' },
  })

  await showHits('3. metadata filter (axis=v3.1)', retriever, {
    text: 'graph',
    topK: 5,
    where: { axis: 'v3.1' },
  })

  console.log('\n— done —')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
