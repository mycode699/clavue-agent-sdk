import test from 'node:test'
import assert from 'node:assert/strict'

import type { SkillDefinition } from '../src/index.ts'

function fakeSkill(overrides: Partial<SkillDefinition>): SkillDefinition {
  return {
    name: 'fake',
    description: 'fake skill',
    getPrompt: async () => [{ type: 'text', text: 'noop' }],
    ...overrides,
  }
}

test('inferSkillRiskTier: fork context routes to approval_required', async () => {
  const { inferSkillRiskTier } = await import('../src/index.ts')
  const skill = fakeSkill({ context: 'fork', agent: 'general-purpose' })
  assert.equal(inferSkillRiskTier(skill), 'approval_required')
})

test('inferSkillRiskTier: requiresApproval routes to approval_required', async () => {
  const { inferSkillRiskTier } = await import('../src/index.ts')
  const skill = fakeSkill({ context: 'inline', permissions: { requiresApproval: true } })
  assert.equal(inferSkillRiskTier(skill), 'approval_required')
})

test('inferSkillRiskTier: inline + qualityGates routes to llm_requested', async () => {
  const { inferSkillRiskTier } = await import('../src/index.ts')
  const skill = fakeSkill({
    context: 'inline',
    qualityGates: [{ name: 'tests' }],
  })
  assert.equal(inferSkillRiskTier(skill), 'llm_requested')
})

test('inferSkillRiskTier: inline with no gates and no approval routes to system_initiated', async () => {
  const { inferSkillRiskTier } = await import('../src/index.ts')
  const skill = fakeSkill({ context: 'inline' })
  assert.equal(inferSkillRiskTier(skill), 'system_initiated')
})

test('inferSkillRiskTier: default (no context) treats as inline → system_initiated', async () => {
  const { inferSkillRiskTier } = await import('../src/index.ts')
  const skill = fakeSkill({})
  assert.equal(inferSkillRiskTier(skill), 'system_initiated')
})

test('formatSkillsForPrompt: each invocable skill line includes a TIER tag', async () => {
  const ns = `skill-tier-${Date.now()}`
  const { registerSkill, clearSkills, formatSkillsForPrompt } = await import('../src/index.ts')

  clearSkills({ runtimeNamespace: ns })
  registerSkill(
    fakeSkill({ name: 'simplify', description: 'simplify code', context: 'inline' }),
    { runtimeNamespace: ns },
  )
  registerSkill(
    fakeSkill({
      name: 'review',
      description: 'review code',
      context: 'inline',
      qualityGates: [{ name: 'lint' }],
    }),
    { runtimeNamespace: ns },
  )
  registerSkill(
    fakeSkill({
      name: 'fork-deploy',
      description: 'forked deployment',
      context: 'fork',
      agent: 'general-purpose',
    }),
    { runtimeNamespace: ns },
  )

  const out = formatSkillsForPrompt(undefined, { runtimeNamespace: ns })
  assert.match(out, /simplify.*TIER: system_initiated/)
  assert.match(out, /review.*TIER: llm_requested/)
  assert.match(out, /fork-deploy.*TIER: approval_required/)
})
