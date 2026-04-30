import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { createSkill, type SkillManifest } from './authoring.js'
import { registerSkill, validateSkillDefinition } from './registry.js'
import type { SkillDefinition, SkillValidationIssue, SkillValidationOptions } from './types.js'
import type { RuntimeNamespaceContext } from '../utils/runtime.js'

export type SkillLoadErrorCode =
  | 'missing_manifest'
  | 'missing_prompt'
  | 'invalid_json'
  | 'invalid_manifest'
  | 'duplicate_name'

export interface SkillLoadError {
  code: SkillLoadErrorCode
  message: string
  path: string
  cause?: unknown
}

export interface LoadedSkill {
  path: string
  definition: SkillDefinition
}

export interface SkillLoaderOptions extends SkillValidationOptions {
  register?: boolean
  context?: RuntimeNamespaceContext
}

export interface SkillLoaderResult {
  loaded: LoadedSkill[]
  errors: SkillLoadError[]
}

const MANIFEST_NAMES = ['skill.json', 'skill.config.json'] as const

export async function loadSkillsFromDir(root: string, options: SkillLoaderOptions = {}): Promise<SkillLoaderResult> {
  const loaded: LoadedSkill[] = []
  const errors: SkillLoadError[] = []
  const seen = new Set<string>()

  let entries: Array<{ name: string; isDirectory(): boolean }>
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    errors.push({
      code: 'missing_manifest',
      message: `Unable to read skills directory: ${root}`,
      path: root,
      cause: error,
    })
    return { loaded, errors }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue

    const skillDir = join(root, entry.name)
    const manifestResult = await readManifest(skillDir)
    if (!manifestResult.ok) {
      errors.push(manifestResult.error)
      continue
    }

    const promptPath = join(skillDir, 'SKILL.md')
    let prompt: string
    try {
      prompt = await readFile(promptPath, 'utf-8')
    } catch (error) {
      errors.push({
        code: 'missing_prompt',
        message: `Skill "${String(manifestResult.manifest.name ?? entry.name)}" is missing SKILL.md`,
        path: promptPath,
        cause: error,
      })
      continue
    }

    const definition = createSkill(manifestResult.manifest, prompt)
    const validation = validateSkillDefinition(definition, options)
    if (!validation.valid) {
      errors.push({
        code: 'invalid_manifest',
        message: `Skill manifest is invalid: ${validation.issues.map((issue) => issue.message).join('; ')}`,
        path: manifestResult.path,
        cause: validation,
      })
      continue
    }

    if (seen.has(definition.name)) {
      errors.push({
        code: 'duplicate_name',
        message: `Duplicate skill name: ${definition.name}`,
        path: manifestResult.path,
      })
      continue
    }
    seen.add(definition.name)
    loaded.push({ path: skillDir, definition })
  }

  if (errors.length > 0) return { loaded: [], errors }

  if (options.register) {
    for (const skill of loaded) {
      registerSkill(skill.definition, options.context)
    }
  }

  return { loaded, errors }
}

type ManifestReadResult =
  | { ok: true; path: string; manifest: SkillManifest }
  | { ok: false; error: SkillLoadError }

async function readManifest(skillDir: string): Promise<ManifestReadResult> {
  let missingPath = join(skillDir, MANIFEST_NAMES[0])
  for (const manifestName of MANIFEST_NAMES) {
    const manifestPath = join(skillDir, manifestName)
    missingPath = manifestPath
    let raw: string
    try {
      raw = await readFile(manifestPath, 'utf-8')
    } catch {
      continue
    }

    try {
      return { ok: true, path: manifestPath, manifest: JSON.parse(raw) as SkillManifest }
    } catch (error) {
      return {
        ok: false,
        error: {
          code: 'invalid_json',
          message: `Skill manifest contains invalid JSON: ${manifestPath}`,
          path: manifestPath,
          cause: error,
        },
      }
    }
  }

  return {
    ok: false,
    error: {
      code: 'missing_manifest',
      message: `Skill directory is missing skill.json or skill.config.json: ${skillDir}`,
      path: missingPath,
    },
  }
}

export type { SkillValidationIssue }
