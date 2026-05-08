/**
 * Verifies the new package.json subpath exports resolve and surface the
 * right symbols. Run via `npx tsx --test tests/subpath-exports.test.ts`.
 *
 * Imports use the dist-relative paths declared in package.json `exports`,
 * but for in-tree testing we resolve through the built dist tree
 * directly (the package is not yet linked under its own name).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

test('subpath/core exports the high-level Agent API', async () => {
  const mod = await import('../dist/subpath/core.js')
  assert.equal(typeof mod.Agent, 'function')
  assert.equal(typeof mod.createAgent, 'function')
  assert.equal(typeof mod.query, 'function')
  assert.equal(typeof mod.run, 'function')
  assert.equal(typeof mod.QueryEngine, 'function')
})

test('subpath/core exports provider + token primitives', async () => {
  const mod = await import('../dist/subpath/core.js')
  assert.equal(typeof mod.AnthropicProvider, 'function')
  assert.equal(typeof mod.OpenAIProvider, 'function')
  assert.equal(typeof mod.estimateMessagesTokens, 'function')
  assert.equal(typeof mod.estimateCost, 'function')
  assert.equal(typeof mod.AUTOCOMPACT_BUFFER_FRACTION, 'number')
  assert.equal(typeof mod.withRetry, 'function')
  assert.equal(typeof mod.isRetryableError, 'function')
})

test('subpath/tools exports tool helpers', async () => {
  const mod = await import('../dist/subpath/tools.js')
  assert.equal(typeof mod.tool, 'function')
  assert.equal(typeof mod.sdkToolToToolDefinition, 'function')
  assert.equal(typeof mod.createSdkMcpServer, 'function')
})

test('subpath/contracts exports contract APIs', async () => {
  const mod = await import('../dist/subpath/contracts.js')
  assert.equal(typeof mod.PROOF_OF_WORK_SCHEMA_VERSION, 'string')
  assert.equal(typeof mod.createProofOfWork, 'function')
  assert.equal(typeof mod.createEvaluationLoopContract, 'function')
  assert.equal(typeof mod.normalizeEvaluationLoopContract, 'function')
})

test('subpath/workflow exports issue-workflow + verifier', async () => {
  const mod = await import('../dist/subpath/workflow.js')
  assert.equal(typeof mod.runIssueWorkflow, 'function')
  assert.equal(typeof mod.runIssueWorkflowWithAgent, 'function')
  assert.equal(typeof mod.CommandVerifier, 'function')
  assert.equal(typeof mod.StaticVerifier, 'function')
})

test('subpath/retro exports improvement helpers', async () => {
  const mod = await import('../dist/subpath/retro.js')
  assert.equal(typeof mod.extractRunImprovementCandidates, 'function')
  assert.equal(typeof mod.runSelfImprovement, 'function')
})

test('subpath/testing exports doctor + benchmark', async () => {
  const mod = await import('../dist/subpath/testing.js')
  assert.equal(typeof mod.doctor, 'function')
  assert.equal(typeof mod.runBenchmarks, 'function')
  assert.equal(typeof mod.CommandVerifier, 'function')
})

test('package.json declares all 7 subpath exports', async () => {
  const fs = await import('node:fs/promises')
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const exports = pkg.exports
  assert.ok(exports['.'], 'root export present')
  for (const sub of ['./core', './tools', './contracts', './workflow', './retro', './testing']) {
    assert.ok(exports[sub], `subpath ${sub} present`)
    assert.ok(exports[sub].types, `subpath ${sub} types path present`)
    assert.ok(exports[sub].import, `subpath ${sub} import path present`)
  }
})

// v3 seven-axis subpaths: graph / guardrails / tracing / sandbox / rag / genui / voice

test('package.json declares all 7 v3 axis subpaths', async () => {
  const fs = await import('node:fs/promises')
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const exports = pkg.exports
  for (const sub of ['./graph', './guardrails', './tracing', './sandbox', './rag', './genui', './voice']) {
    assert.ok(exports[sub], `v3 subpath ${sub} present`)
    assert.ok(exports[sub].types, `v3 subpath ${sub} types path present`)
    assert.ok(exports[sub].import, `v3 subpath ${sub} import path present`)
  }
})

test('every package.json exports entry resolves to an existing dist file', async () => {
  const fs = await import('node:fs/promises')
  const path = await import('node:path')
  const pkg = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const repoRoot = path.dirname(new URL('../package.json', import.meta.url).pathname)
  const missing: string[] = []
  for (const [name, entry] of Object.entries(pkg.exports as Record<string, { types: string; import: string }>)) {
    for (const target of [entry.types, entry.import]) {
      const abs = path.join(repoRoot, target)
      try {
        await fs.access(abs)
      } catch {
        missing.push(`${name} → ${target}`)
      }
    }
  }
  assert.deepEqual(missing, [], `Unresolved exports:\n  ${missing.join('\n  ')}`)
})

test('subpath/graph exports v3 graph runtime', async () => {
  const mod = await import('../dist/graph/index.js')
  assert.equal(typeof mod.runGraph, 'function')
})

test('subpath/guardrails exports GuardrailRegistry', async () => {
  const mod = await import('../dist/guardrails/index.js')
  assert.equal(typeof mod.GuardrailRegistry, 'function')
})

test('subpath/tracing exports TraceStore + OtelTraceExporter', async () => {
  const mod = await import('../dist/tracing/index.js')
  assert.equal(typeof mod.TraceStore, 'function')
  assert.equal(typeof mod.OtelTraceExporter, 'function')
})

test('subpath/rag exports retriever primitives', async () => {
  const mod = await import('../dist/rag/index.js')
  assert.equal(typeof mod.InMemoryRetriever, 'function')
  assert.equal(typeof mod.PgvectorRetriever, 'function')
})

test('subpath/voice exports stub + real provider adapters', async () => {
  const mod = await import('../dist/voice/index.js')
  assert.equal(typeof mod.StubAsrProvider, 'function')
  assert.equal(typeof mod.StubTtsProvider, 'function')
  assert.equal(typeof mod.DeepgramAsrProvider, 'function')
  assert.equal(typeof mod.WhisperOpenAiAsrProvider, 'function')
  assert.equal(typeof mod.ElevenLabsTtsProvider, 'function')
})
