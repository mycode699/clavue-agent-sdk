import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  clearSkills,
  createSkill,
  getSkill,
  loadSkillsFromDir,
  type SkillDefinition,
} from '../src/index.ts'

async function withTempDir<T>(callback: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-agent-sdk-skills-'))
  try {
    return await callback(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeSkillFixture(root: string, manifest: Record<string, unknown>, prompt = 'Loaded prompt body.'): Promise<string> {
  const dir = join(root, String(manifest.name ?? 'skill-fixture'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'skill.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8')
  await writeFile(join(dir, 'SKILL.md'), prompt, 'utf-8')
  return dir
}

test('createSkill builds a prompt-backed SkillDefinition', async () => {
  const skill = createSkill({
    name: 'created-skill',
    description: 'Created skill fixture.',
    aliases: ['created'],
    allowedTools: ['Read'],
  }, 'Created prompt.')

  assert.equal(skill.name, 'created-skill')
  assert.equal(skill.description, 'Created skill fixture.')
  assert.deepEqual(skill.aliases, ['created'])
  assert.deepEqual(skill.allowedTools, ['Read'])
  assert.deepEqual(await skill.getPrompt('', { cwd: process.cwd() }), [{ type: 'text', text: 'Created prompt.' }])
})

test('loadSkillsFromDir loads a valid filesystem skill without registering by default', async () => {
  await withTempDir(async (root) => {
    clearSkills()
    await writeSkillFixture(root, {
      name: 'loaded-skill',
      description: 'Loaded skill fixture.',
      aliases: ['loaded'],
      allowedTools: ['Read'],
      userInvocable: true,
    })

    const result = await loadSkillsFromDir(root, {
      availableTools: ['Read'],
      register: false,
    })

    assert.equal(result.loaded.length, 1)
    assert.deepEqual(result.errors, [])
    assert.equal(result.loaded[0].definition.name, 'loaded-skill')
    assert.deepEqual(await result.loaded[0].definition.getPrompt('', { cwd: root }), [{ type: 'text', text: 'Loaded prompt body.' }])
    assert.equal(getSkill('loaded-skill'), undefined)
  })
})

test('loadSkillsFromDir can register into a runtime namespace without leaking globally', async () => {
  await withTempDir(async (root) => {
    clearSkills()
    await writeSkillFixture(root, {
      name: 'namespaced-skill',
      description: 'Namespaced skill fixture.',
    })

    const context = { runtimeNamespace: 'skill-loader-test' }
    const result = await loadSkillsFromDir(root, { register: true, context })

    assert.equal(result.loaded.length, 1)
    assert.deepEqual(result.errors, [])
    assert.equal(getSkill('namespaced-skill', context)?.name, 'namespaced-skill')
    assert.equal(getSkill('namespaced-skill'), undefined)
  })
})

test('loadSkillsFromDir reports missing SKILL.md clearly', async () => {
  await withTempDir(async (root) => {
    const dir = join(root, 'missing-prompt')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'skill.json'), JSON.stringify({
      name: 'missing-prompt',
      description: 'Missing prompt fixture.',
    }), 'utf-8')

    const result = await loadSkillsFromDir(root)

    assert.equal(result.loaded.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, 'missing_prompt')
    assert.match(result.errors[0].message, /SKILL\.md/)
  })
})

test('loadSkillsFromDir reports invalid JSON clearly', async () => {
  await withTempDir(async (root) => {
    const dir = join(root, 'invalid-json')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'skill.json'), '{ invalid json', 'utf-8')
    await writeFile(join(dir, 'SKILL.md'), 'Prompt.', 'utf-8')

    const result = await loadSkillsFromDir(root)

    assert.equal(result.loaded.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, 'invalid_json')
  })
})

test('loadSkillsFromDir validates manifests before registration', async () => {
  await withTempDir(async (root) => {
    clearSkills()
    await writeSkillFixture(root, {
      name: 'bad skill name',
      description: 'Invalid name fixture.',
    })

    const result = await loadSkillsFromDir(root, { register: true })

    assert.equal(result.loaded.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, 'invalid_manifest')
    assert.equal((result.errors[0].cause as { issues: unknown[] }).issues.length, 1)
    assert.equal(getSkill('bad skill name'), undefined)
  })
})

test('loadSkillsFromDir rejects unknown allowedTools when available tools are supplied', async () => {
  await withTempDir(async (root) => {
    await writeSkillFixture(root, {
      name: 'unknown-tool-skill',
      description: 'Unknown tool fixture.',
      allowedTools: ['Read', 'NopeTool'],
    })

    const result = await loadSkillsFromDir(root, { availableTools: ['Read'] })

    assert.equal(result.loaded.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, 'invalid_manifest')
    const cause = result.errors[0].cause as { issues: Array<{ code: string; path: string }> }
    assert.ok(cause.issues.some((issue) => issue.code === 'unknown_allowed_tool' && issue.path === 'allowedTools[1]'))
  })
})

test('loadSkillsFromDir reports duplicate skill names clearly', async () => {
  await withTempDir(async (root) => {
    await writeSkillFixture(root, {
      name: 'duplicate-skill',
      description: 'Duplicate fixture A.',
    }, 'Prompt A.')
    const dir = join(root, 'duplicate-skill-b')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'skill.config.json'), JSON.stringify({
      name: 'duplicate-skill',
      description: 'Duplicate fixture B.',
    }), 'utf-8')
    await writeFile(join(dir, 'SKILL.md'), 'Prompt B.', 'utf-8')

    const result = await loadSkillsFromDir(root)

    assert.equal(result.loaded.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, 'duplicate_name')
  })
})

test('loadSkillsFromDir does not register later skills after a duplicate name error', async () => {
  await withTempDir(async (root) => {
    clearSkills()
    await writeSkillFixture(root, {
      name: 'duplicate-skill',
      description: 'Duplicate fixture A.',
    }, 'Prompt A.')
    const duplicateDir = join(root, 'duplicate-skill-b')
    await mkdir(duplicateDir, { recursive: true })
    await writeFile(join(duplicateDir, 'skill.config.json'), JSON.stringify({
      name: 'duplicate-skill',
      description: 'Duplicate fixture B.',
    }), 'utf-8')
    await writeFile(join(duplicateDir, 'SKILL.md'), 'Prompt B.', 'utf-8')
    await writeSkillFixture(root, {
      name: 'later-skill',
      description: 'Later fixture.',
    }, 'Later prompt.')

    const result = await loadSkillsFromDir(root, { register: true })

    assert.equal(result.loaded.length, 0)
    assert.equal(result.errors.length, 1)
    assert.equal(result.errors[0].code, 'duplicate_name')
    assert.equal(getSkill('duplicate-skill'), undefined)
    assert.equal(getSkill('later-skill'), undefined)
  })
})
