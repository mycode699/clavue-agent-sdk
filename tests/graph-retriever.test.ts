/**
 * Graph DSL ↔ Retriever (RFC D4) integration test.
 *
 * Locks acceptance: new node kind `retriever`, `RetrievalHit[]` lands in
 * outputs, downstream agents see hits via context, OTel exporter maps
 * `graph.step.retriever` with `retrieval.hit_count` attribute.
 *
 * @module
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { runGraph } from '../src/graph/index.ts'
import type { AgentGraph, GraphAgentLike } from '../src/graph/index.ts'
import { InMemoryRetriever } from '../src/rag/index.ts'
import type { Retriever } from '../src/rag/index.ts'
import { TraceStore, eventToOtelSpan } from '../src/tracing/index.ts'

/**
 * Toy embedder: maps each unique token (case-insensitive) to a hash-derived
 * one-hot offset. Stable, no LLM dependency, good enough for cosine ranking.
 */
function toyEmbed(text: string): number[] {
  const dim = 16
  const v = new Array<number>(dim).fill(0)
  for (const tok of text.toLowerCase().split(/\W+/).filter(Boolean)) {
    let h = 0
    for (let i = 0; i < tok.length; i += 1) {
      h = (h * 31 + tok.charCodeAt(i)) >>> 0
    }
    v[h % dim] += 1
  }
  return v
}

const stub = (label: string): GraphAgentLike => ({
  async prompt(text) {
    return { text: `${label}(${text})` }
  },
})

test('retriever node populates outputs[id] with kind=retrieval + hits + query', async () => {
  const retriever = new InMemoryRetriever({ embed: toyEmbed })
  await retriever.add([
    { id: 'a', text: 'the quick brown fox' },
    { id: 'b', text: 'the lazy dog' },
    { id: 'c', text: 'fox news today' },
  ])

  const graph: AgentGraph = {
    entry: 'rag',
    nodes: [{ kind: 'retriever', id: 'rag', retriever, topK: 2 }],
    edges: [],
  }

  const result = await runGraph(graph, { input: 'fox' })
  assert.equal(result.status, 'completed')
  const out = result.outputs.rag
  assert.ok(out, 'retriever step should populate outputs')
  assert.equal(out.kind, 'retrieval')
  if (out.kind !== 'retrieval') return
  assert.equal(out.query, 'fox')
  assert.equal(out.hits.length, 2)
  // 'a' and 'c' both contain "fox" — they must rank above "the lazy dog"
  const ids = out.hits.map((h) => h.id).sort()
  assert.ok(ids.includes('a') || ids.includes('c'))
  assert.ok(!out.hits.some((h) => h.id === 'b'))
})

test('retrieve → agent: agent prompt builder reads retrieval output from ctx', async () => {
  const retriever = new InMemoryRetriever({ embed: toyEmbed })
  await retriever.add([
    { id: 'doc1', text: 'capital of france is paris' },
    { id: 'doc2', text: 'capital of germany is berlin' },
  ])

  const graph: AgentGraph = {
    entry: 'rag',
    nodes: [
      { kind: 'retriever', id: 'rag', retriever, topK: 1 },
      {
        kind: 'agent',
        id: 'qa',
        agent: stub('answered'),
        prompt: (ctx) => {
          const r = ctx.outputs.rag
          if (r?.kind !== 'retrieval') return ctx.input
          const top = r.hits[0]
          return `Q: ${ctx.input} | CTX: ${top?.text ?? ''}`
        },
      },
    ],
    edges: [{ from: 'rag', to: 'qa' }],
  }

  const result = await runGraph(graph, { input: 'capital of france' })
  assert.equal(result.status, 'completed')
  const qa = result.outputs.qa
  assert.equal(qa?.kind, 'text')
  if (qa?.kind === 'text') {
    assert.match(qa.text, /capital of france/)
    assert.match(qa.text, /paris/)
  }
})

test('retriever throws → run aborts with the error propagating', async () => {
  const broken: Retriever = {
    async retrieve() {
      throw new Error('vector store offline')
    },
  }

  const graph: AgentGraph = {
    entry: 'rag',
    nodes: [{ kind: 'retriever', id: 'rag', retriever: broken }],
    edges: [],
  }

  await assert.rejects(
    () => runGraph(graph, { input: 'x' }),
    /vector store offline/,
  )
})

test('OTel exporter: retriever step → graph.step.retriever + retrieval.hit_count', async () => {
  const retriever = new InMemoryRetriever({ embed: toyEmbed })
  await retriever.add([
    { id: 'a', text: 'alpha bravo' },
    { id: 'b', text: 'charlie delta' },
    { id: 'c', text: 'alpha echo' },
  ])

  const store = new TraceStore()
  const runId = store.startRun({ scenario: 'rag-otel' })
  const graph: AgentGraph = {
    entry: 'rag',
    nodes: [{ kind: 'retriever', id: 'rag', retriever, topK: 3 }],
    edges: [],
  }
  await runGraph(graph, { input: 'alpha' }, { trace: store })
  store.endRun(runId)

  const spans = store.query(runId).map(eventToOtelSpan)
  assert.equal(spans.length, 1)
  const span = spans[0]!
  assert.equal(span.name, 'graph.step.retriever')
  assert.equal(span.attributes['graph.node_id'], 'rag')
  assert.equal(span.attributes['graph.kind'], 'retriever')
  assert.equal(span.attributes['graph.output.kind'], 'retrieval')
  assert.equal(span.attributes['retrieval.hit_count'], 3)
  assert.equal(span.status?.code, 'ok')
})

test('topK defaults to 5 when omitted; respects metadata where filter', async () => {
  const retriever = new InMemoryRetriever({ embed: toyEmbed })
  await retriever.add([
    { id: 'a', text: 'fox', metadata: { lang: 'en' } },
    { id: 'b', text: 'fox', metadata: { lang: 'fr' } },
    { id: 'c', text: 'fox', metadata: { lang: 'en' } },
  ])

  const graph: AgentGraph = {
    entry: 'rag',
    nodes: [
      { kind: 'retriever', id: 'rag', retriever, where: { lang: 'en' } },
    ],
    edges: [],
  }

  const result = await runGraph(graph, { input: 'fox' })
  const out = result.outputs.rag
  assert.equal(out?.kind, 'retrieval')
  if (out?.kind === 'retrieval') {
    assert.equal(out.hits.length, 2)
    assert.ok(out.hits.every((h) => h.metadata?.['lang'] === 'en'))
  }
})
