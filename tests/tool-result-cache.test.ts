import test from 'node:test'
import assert from 'node:assert/strict'

import { ToolResultCache, stableInputKey } from '../src/engine/tool-result-cache.ts'
import type { ToolResult } from '../src/types.ts'

function ok(content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: 'x', content, is_error: false }
}

function err(content: string): ToolResult {
  return { type: 'tool_result', tool_use_id: 'x', content, is_error: true }
}

test('stableInputKey is order-independent across object keys', () => {
  const a = stableInputKey({ b: 2, a: 1, c: { y: 1, x: 2 } })
  const b = stableInputKey({ a: 1, c: { x: 2, y: 1 }, b: 2 })
  assert.equal(a, b)
})

test('stableInputKey preserves array order (semantic difference)', () => {
  assert.notEqual(stableInputKey([1, 2, 3]), stableInputKey([3, 2, 1]))
})

test('stableInputKey survives non-serializable input by falling back to String', () => {
  const cyclic: any = { a: 1 }
  cyclic.self = cyclic
  const key = stableInputKey(cyclic)
  assert.equal(typeof key, 'string')
})

test('getOrCompute records a miss for the first caller and a hit for the duplicate', async () => {
  const cache = new ToolResultCache()
  let computeCalls = 0
  const compute = async () => {
    computeCalls++
    return ok('value')
  }
  const a = await cache.getOrCompute('Read', { path: '/a' }, compute)
  const b = await cache.getOrCompute('Read', { path: '/a' }, compute)
  assert.equal(computeCalls, 1)
  assert.equal(a.cached, false)
  assert.equal(b.cached, true)
  assert.deepEqual(cache.stats(), { hits: 1, misses: 1, size: 1 })
})

test('getOrCompute hits on equivalent input regardless of key order', async () => {
  const cache = new ToolResultCache()
  let computeCalls = 0
  const compute = async () => {
    computeCalls++
    return ok('A')
  }
  await cache.getOrCompute('Read', { path: '/a', limit: 10 }, compute)
  const second = await cache.getOrCompute('Read', { limit: 10, path: '/a' }, compute)
  assert.equal(computeCalls, 1)
  assert.equal(second.result.content, 'A')
  assert.equal(second.cached, true)
})

test('getOrCompute namespaces by tool name', async () => {
  const cache = new ToolResultCache()
  await cache.getOrCompute('Read', { path: '/a' }, async () => ok('R'))
  let bashCalled = 0
  await cache.getOrCompute('Bash', { path: '/a' }, async () => {
    bashCalled++
    return ok('B')
  })
  assert.equal(bashCalled, 1, 'different tool name = different cache slot')
})

test('getOrCompute does not retain is_error results — next call re-runs compute', async () => {
  const cache = new ToolResultCache()
  let i = 0
  const compute = async () => {
    i++
    return i === 1 ? err('boom') : ok('recovered')
  }
  const first = await cache.getOrCompute('Read', { path: '/x' }, compute)
  assert.equal(first.result.is_error, true)
  assert.equal(first.cached, false)

  const second = await cache.getOrCompute('Read', { path: '/x' }, compute)
  assert.equal(second.result.is_error, false)
  assert.equal(second.result.content, 'recovered')
  assert.equal(second.cached, false, 'is_error must not be retained')
})

test('getOrCompute dedupes concurrent duplicate callers', async () => {
  const cache = new ToolResultCache()
  let inflight = 0
  let peak = 0
  let computeCalls = 0
  const compute = async () => {
    computeCalls++
    inflight++
    peak = Math.max(peak, inflight)
    await new Promise((r) => setTimeout(r, 5))
    inflight--
    return ok('shared')
  }

  // Four concurrent duplicate callers — should resolve to one compute().
  const results = await Promise.all([
    cache.getOrCompute('Read', { path: '/p' }, compute),
    cache.getOrCompute('Read', { path: '/p' }, compute),
    cache.getOrCompute('Read', { path: '/p' }, compute),
    cache.getOrCompute('Read', { path: '/p' }, compute),
  ])
  assert.equal(computeCalls, 1, 'only one compute should run for racing duplicates')
  assert.equal(peak, 1)
  assert.equal(results.filter((r) => r.cached).length, 3, 'three duplicates marked cached')
  assert.equal(results.filter((r) => !r.cached).length, 1, 'one producer marked uncached')
})
