import test from 'node:test'
import assert from 'node:assert/strict'

import { CapabilityRegistry, matchResource } from '../src/sandbox/index.ts'

test('matchResource: exact, single-segment *, recursive **', () => {
  // exact
  assert.equal(matchResource('file:///a/b', 'file:///a/b'), true)
  assert.equal(matchResource('file:///a/b', 'file:///a/c'), false)
  // single segment
  assert.equal(matchResource('file:///repo/*', 'file:///repo/src'), true)
  assert.equal(matchResource('file:///repo/*', 'file:///repo/src/index.ts'), false)
  // recursive
  assert.equal(matchResource('file:///repo/**', 'file:///repo/src/index.ts'), true)
  assert.equal(matchResource('file:///repo/**', 'file:///repo'), true)
  // catch-all
  assert.equal(matchResource('*', 'anything'), true)
  assert.equal(matchResource('**', 'a/b/c'), true)
})

test('matchResource: regex metacharacters in pattern are literal', () => {
  assert.equal(matchResource('cmd:git status', 'cmd:git status'), true)
  // dot is literal, not "any char"
  assert.equal(matchResource('host:api.example.com', 'host:apiXexample.com'), false)
  // parens / pipes literal
  assert.equal(matchResource('foo(bar|baz)', 'foo(bar|baz)'), true)
  assert.equal(matchResource('foo(bar|baz)', 'foobar'), false)
})

test('mint requires capability and resource', () => {
  const reg = new CapabilityRegistry()
  // @ts-expect-error
  assert.throws(() => reg.mint({ resource: 'x' }), /capability required/)
  // @ts-expect-error
  assert.throws(() => reg.mint({ capability: 'fs.read' }), /resource required/)
})

test('mint rejects duplicate token id', () => {
  const reg = new CapabilityRegistry()
  reg.mint({ capability: 'fs.read', resource: 'file:///a/**' }, 'tok-1')
  assert.throws(
    () => reg.mint({ capability: 'fs.read', resource: 'file:///b/**' }, 'tok-1'),
    /already exists/,
  )
})

test('check: allow on first matching token, increments usedCount', () => {
  const reg = new CapabilityRegistry()
  const t = reg.mint({ capability: 'fs.read', resource: 'file:///repo/**', maxUses: 3 })
  const d1 = reg.check('fs.read', 'file:///repo/src/index.ts')
  assert.equal(d1.allowed, true)
  assert.equal(d1.tokenId, t.id)
  assert.equal(reg.get(t.id)?.usedCount, 1)
  reg.check('fs.read', 'file:///repo/a')
  assert.equal(reg.get(t.id)?.usedCount, 2)
})

test('check: capability_mismatch when no token has the capability', () => {
  const reg = new CapabilityRegistry()
  reg.mint({ capability: 'fs.read', resource: '**' })
  const d = reg.check('net.fetch', 'https://example.com/x')
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'capability_mismatch')
})

test('check: resource_mismatch when capability matches but resource does not', () => {
  const reg = new CapabilityRegistry()
  reg.mint({ capability: 'fs.read', resource: 'file:///allowed/**' })
  const d = reg.check('fs.read', 'file:///forbidden/x')
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'resource_mismatch')
})

test('check: revoked token blocks; reason="revoked"', () => {
  const reg = new CapabilityRegistry()
  const t = reg.mint({ capability: 'fs.read', resource: '**' })
  assert.equal(reg.revoke(t.id), true)
  assert.equal(reg.revoke(t.id), false) // idempotent: already revoked
  const d = reg.check('fs.read', 'file:///x')
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'revoked')
})

test('check: expired token blocks; reason="expired"', () => {
  const reg = new CapabilityRegistry()
  reg.mint({
    capability: 'net.fetch',
    resource: 'https://**',
    expiresAt: Date.now() - 1000,
  })
  const d = reg.check('net.fetch', 'https://api.example.com/x')
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'expired')
})

test('check: exhausted token blocks; reason="exhausted"', () => {
  const reg = new CapabilityRegistry()
  reg.mint({ capability: 'fs.write', resource: 'file:///tmp/**', maxUses: 2 })
  assert.equal(reg.check('fs.write', 'file:///tmp/a').allowed, true)
  assert.equal(reg.check('fs.write', 'file:///tmp/b').allowed, true)
  const d = reg.check('fs.write', 'file:///tmp/c')
  assert.equal(d.allowed, false)
  assert.equal(d.reason, 'exhausted')
})

test('check: a fresh second token still allows even if first is revoked', () => {
  const reg = new CapabilityRegistry()
  const t1 = reg.mint({ capability: 'fs.read', resource: 'file:///r/**' })
  reg.mint({ capability: 'fs.read', resource: 'file:///r/**' })
  reg.revoke(t1.id)
  const d = reg.check('fs.read', 'file:///r/x')
  assert.equal(d.allowed, true)
  // Winner is the second (fresh) token, not the revoked one.
  assert.notEqual(d.tokenId, t1.id)
})

test('list: filters revoked / expired / capability / resource', () => {
  const reg = new CapabilityRegistry()
  reg.mint({ capability: 'fs.read', resource: 'file:///a/**' }, 'a')
  const b = reg.mint({ capability: 'fs.read', resource: 'file:///b/**' }, 'b')
  reg.revoke(b.id)
  reg.mint({
    capability: 'net.fetch',
    resource: 'https://**',
    expiresAt: Date.now() - 1,
  }, 'c')

  const fresh = reg.list()
  assert.deepEqual(fresh.map((t) => t.id).sort(), ['a'])

  const all = reg.list({ includeRevoked: true, includeExpired: true })
  assert.equal(all.length, 3)

  const fsOnly = reg.list({ capability: 'fs.read' })
  assert.deepEqual(fsOnly.map((t) => t.id), ['a'])

  // resource filter: matches tokens whose pattern accepts the resource
  const matchingA = reg.list({ resource: 'file:///a/inside/x' })
  assert.deepEqual(matchingA.map((t) => t.id), ['a'])
})

test('get returns a clone — caller cannot mutate registry state', () => {
  const reg = new CapabilityRegistry()
  const t = reg.mint({ capability: 'fs.read', resource: '**', meta: { owner: 'agent-a' } })
  const snap = reg.get(t.id)!
  ;(snap.meta as Record<string, unknown>).owner = 'mutated'
  const fresh = reg.get(t.id)!
  assert.equal((fresh.meta as Record<string, unknown>).owner, 'agent-a')
})
