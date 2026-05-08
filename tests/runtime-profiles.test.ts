import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyAgentPreset,
  createAgent,
  expandAgentPreset,
  type AgentOptions,
  type AgentPreset,
} from '../src/index.ts'

// ---------------------------------------------------------------------------
// expandAgentPreset — pure preset → defaults table.
// ---------------------------------------------------------------------------

test('expandAgentPreset: autonomous yields trustedAutomation + autoInject memory', () => {
  const expanded = expandAgentPreset('autonomous')
  assert.equal(expanded.permissionMode, 'trustedAutomation')
  assert.equal(expanded.autonomyMode, 'autonomous')
  assert.equal(expanded.memory?.enabled, true)
  assert.equal(expanded.memory?.policy?.mode, 'autoInject')
  assert.equal(expanded.maxTurns, 50)
})

test('expandAgentPreset: interactive yields plan permission + supervised + low maxTurns', () => {
  const expanded = expandAgentPreset('interactive')
  assert.equal(expanded.permissionMode, 'plan')
  assert.equal(expanded.autonomyMode, 'supervised')
  assert.equal(expanded.memory?.enabled, true)
  assert.equal(expanded.maxTurns, 10)
})

test('expandAgentPreset: sandboxed disables memory and forces repo-readonly toolset', () => {
  const expanded = expandAgentPreset('sandboxed')
  assert.equal(expanded.permissionMode, 'auto')
  assert.equal(expanded.autonomyMode, 'supervised')
  assert.deepEqual(expanded.toolsets, ['repo-readonly'])
  assert.equal(expanded.memory?.enabled, false)
  assert.equal(expanded.memory?.policy?.mode, 'off')
  assert.equal(expanded.maxTurns, 5)
})

test('expandAgentPreset: minimal disables memory and uses default permission mode', () => {
  const expanded = expandAgentPreset('minimal')
  assert.equal(expanded.permissionMode, 'default')
  assert.equal(expanded.memory?.enabled, false)
  assert.equal(expanded.memory?.policy?.mode, 'off')
  assert.equal(expanded.maxTurns, 5)
})

test('expandAgentPreset: returns a fresh object every call (caller can mutate)', () => {
  const a = expandAgentPreset('autonomous')
  const b = expandAgentPreset('autonomous')
  assert.notEqual(a, b)
  assert.notEqual(a.memory, b.memory)
  // Mutating one should not affect the other.
  ;(a.memory as { enabled: boolean }).enabled = false
  assert.equal(b.memory?.enabled, true)
})

test('expandAgentPreset: throws on unknown preset', () => {
  assert.throws(() => expandAgentPreset('nope' as unknown as AgentPreset), /Unknown agent preset/)
})

// ---------------------------------------------------------------------------
// applyAgentPreset — explicit-fields-win merge.
// ---------------------------------------------------------------------------

test('applyAgentPreset: no profile passes through unchanged', () => {
  const input: AgentOptions = { model: 'claude-opus-4-6', maxTurns: 7 }
  const merged = applyAgentPreset(input)
  assert.equal(merged.model, 'claude-opus-4-6')
  assert.equal(merged.maxTurns, 7)
  // Should be a copy, not the same reference.
  assert.notEqual(merged, input)
})

test('applyAgentPreset: caller maxTurns wins over preset default', () => {
  const merged = applyAgentPreset({
    profile: 'autonomous',
    maxTurns: 3,
  })
  // Caller's explicit 3 wins over autonomous's 50.
  assert.equal(merged.maxTurns, 3)
  // Other preset fields still applied.
  assert.equal(merged.permissionMode, 'trustedAutomation')
})

test('applyAgentPreset: caller permissionMode wins over preset', () => {
  const merged = applyAgentPreset({
    profile: 'sandboxed',
    permissionMode: 'plan',
  })
  assert.equal(merged.permissionMode, 'plan')
  // memory.enabled still off because caller did not override.
  assert.equal(merged.memory?.enabled, false)
})

test('applyAgentPreset: caller memory.dir merges with preset memory.policy', () => {
  const merged = applyAgentPreset({
    profile: 'interactive',
    memory: { dir: '/tmp/custom-memory' },
  })
  // Caller-specified dir survived.
  assert.equal(merged.memory?.dir, '/tmp/custom-memory')
  // Preset's policy.mode (autoInject) survived because caller didn't override.
  assert.equal(merged.memory?.policy?.mode, 'autoInject')
})

test('applyAgentPreset: strips profile field so it does not re-apply downstream', () => {
  const merged = applyAgentPreset({ profile: 'minimal' })
  assert.equal((merged as { profile?: AgentPreset }).profile, undefined)
})

// ---------------------------------------------------------------------------
// createAgent integration — preset expands inside the factory.
// ---------------------------------------------------------------------------

test('createAgent({ profile: "minimal" }) disables memory on the resulting agent', async () => {
  const agent = createAgent({ profile: 'minimal' })
  try {
    // Agent.config exposes the post-merge AgentOptions.
    const cfg = (agent as unknown as { cfg: AgentOptions }).cfg
    assert.equal(cfg.memory?.enabled, false)
    assert.equal(cfg.permissionMode, 'default')
    assert.equal((cfg as { profile?: AgentPreset }).profile, undefined)
  } finally {
    await agent.close()
  }
})

test('createAgent({ profile: "sandboxed", maxTurns: 9 }) keeps caller maxTurns', async () => {
  const agent = createAgent({ profile: 'sandboxed', maxTurns: 9 })
  try {
    const cfg = (agent as unknown as { cfg: AgentOptions }).cfg
    assert.equal(cfg.maxTurns, 9)
    assert.equal(cfg.memory?.enabled, false)
  } finally {
    await agent.close()
  }
})
