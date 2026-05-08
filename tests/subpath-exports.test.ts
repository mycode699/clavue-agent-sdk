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
