import test from 'node:test'
import assert from 'node:assert/strict'

import {
  clearSkills,
  registerSkill,
  validateSkillDefinition,
  validateSkillManifest,
  type SkillDefinition,
} from '../src/index.ts'
import { registerWorkflowSkills } from '../src/skills/bundled/workflow.ts'

const prompt: SkillDefinition['getPrompt'] = async () => [{ type: 'text', text: 'prompt' }]

function validSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: 'example-skill',
    description: 'Example skill for validation tests.',
    getPrompt: prompt,
    ...overrides,
  }
}

test('valid bundled workflow skills validate without registration errors', () => {
  clearSkills()
  registerWorkflowSkills()

  const result = validateSkillDefinition(validSkill({
    name: 'workflow-compatible',
    aliases: ['workflow-compatible-alias'],
    preconditions: [{ name: 'scope-known' }],
    artifactsProduced: [{ name: 'plan', type: 'text' }],
    qualityGates: [{ name: 'tests', args: ['run', 'test'] }],
    permissions: { allowedTools: ['Read'], disallowedTools: ['Write'] },
    outputSchema: { type: 'object', properties: {} },
  }), { availableTools: ['Read', 'Write'] })

  assert.equal(result.valid, true)
  assert.deepEqual(result.issues, [])
})

test('invalid skill manifests return structured validation issues', () => {
  const result = validateSkillDefinition({
    name: '',
    description: '',
    aliases: ['dup', 'dup', 'bad alias'],
    preconditions: [{ name: '' }],
    artifactsProduced: 'bad-artifacts' as any,
    qualityGates: [{ name: '', args: 'npm test' as any }],
    permissions: {
      allowedTools: ['Read', 'Read', 'UnknownTool'],
      disallowedTools: ['Read', 'Write', 'Write'],
    },
    outputSchema: 'not-object' as any,
    context: 'fork',
    agent: '',
    getPrompt: prompt,
  } as SkillDefinition, { availableTools: ['Read', 'Write'] })

  assert.equal(result.valid, false)
  assert.ok(result.issues.length >= 10)
  assert.ok(result.issues.every((issue) => issue.severity === 'error'))
  assert.ok(result.issues.some((issue) => issue.code === 'missing_name' && issue.path === 'name'))
  assert.ok(result.issues.some((issue) => issue.code === 'missing_description' && issue.path === 'description'))
  assert.ok(result.issues.some((issue) => issue.code === 'duplicate_alias' && issue.path === 'aliases[1]'))
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_alias' && issue.path === 'aliases[2]'))
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_precondition' && issue.path === 'preconditions[0].name'))
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_artifactsProduced' && issue.path === 'artifactsProduced'))
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_quality_gate' && issue.path === 'qualityGates[0].name'))
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_gate_args' && issue.path === 'qualityGates[0].args'))
  assert.ok(result.issues.some((issue) => issue.code === 'duplicate_allowed_tool' && issue.path === 'permissions.allowedTools[1]'))
  assert.ok(result.issues.some((issue) => issue.code === 'duplicate_disallowed_tool' && issue.path === 'permissions.disallowedTools[2]'))
  assert.ok(result.issues.some((issue) => issue.code === 'tool_permission_overlap' && issue.path === 'permissions.disallowedTools[0]'))
  assert.ok(result.issues.some((issue) => issue.code === 'unknown_allowed_tool' && issue.path === 'permissions.allowedTools[2]'))
  assert.ok(result.issues.some((issue) => issue.code === 'invalid_output_schema' && issue.path === 'outputSchema'))
  assert.ok(result.issues.some((issue) => issue.code === 'missing_fork_agent' && issue.path === 'agent'))
})

test('top-level allowedTools validates available tools', () => {
  const result = validateSkillDefinition(validSkill({ allowedTools: ['Read', 'UnknownTool'] }), { availableTools: ['Read'] })

  assert.equal(result.valid, false)
  assert.ok(result.issues.some((issue) => issue.code === 'unknown_allowed_tool' && issue.path === 'allowedTools[1]'))
})

test('top-level allowedTools must match permissions allowedTools', () => {
  const result = validateSkillDefinition(validSkill({
    allowedTools: ['Read'],
    permissions: { allowedTools: ['Write'] },
  }), { availableTools: ['Read', 'Write'] })

  assert.equal(result.valid, false)
  assert.ok(result.issues.some((issue) => issue.code === 'allowed_tools_mismatch' && issue.path === 'permissions.allowedTools'))
})

test('registerSkill still throws a clear validation error', () => {
  assert.throws(
    () => registerSkill(validSkill({ name: 'bad skill name' })),
    /Invalid skill definition: Invalid skill name: bad skill name/,
  )
})

test('aliases cannot collide with the skill name', () => {
  const result = validateSkillDefinition(validSkill({ aliases: ['example-skill'] }))

  assert.equal(result.valid, false)
  assert.ok(result.issues.some((issue) => issue.code === 'alias_conflicts_with_name' && issue.path === 'aliases[0]'))
})

test('validateSkillDefinition requires a prompt function', () => {
  const result = validateSkillDefinition({
    name: 'missing-prompt-function',
    description: 'Missing prompt function fixture.',
  } as SkillDefinition)

  assert.equal(result.valid, false)
  assert.ok(result.issues.some((issue) => issue.code === 'missing_prompt_function' && issue.path === 'getPrompt'))
})

test('validateSkillManifest validates authoring manifests without a prompt function', () => {
  const result = validateSkillManifest({
    name: 'manifest-skill',
    description: 'Manifest-only skill fixture.',
    qualityGates: [{ name: 'tests', command: 'npm', args: ['test'] }],
  }, { availableTools: ['Read'] })

  assert.equal(result.valid, true)
  assert.deepEqual(result.issues, [])
})
