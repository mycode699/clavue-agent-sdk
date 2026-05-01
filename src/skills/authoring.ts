import { validateSkillDefinition } from './registry.js'
import type {
  SkillDefinition,
  SkillContentBlock,
  SkillValidationOptions,
  SkillValidationResult,
  SkillQualityGateSpec,
  SkillArtifactSpec,
} from './types.js'

export type SkillManifest = Omit<SkillDefinition, 'getPrompt' | 'isEnabled'>

export type SkillPromptSource = string | SkillContentBlock[] | SkillDefinition['getPrompt']
export type SkillQualityGateInput = string | SkillQualityGateSpec
export type SkillArtifactInput = string | SkillArtifactSpec
export type SkillManifestInput = Omit<SkillManifest, 'name' | 'qualityGates' | 'artifactsProduced'> & {
  name: string
  qualityGates?: SkillQualityGateInput[]
  artifactsProduced?: SkillArtifactInput[]
}

export function validateSkillManifest(
  manifest: SkillManifest,
  options?: SkillValidationOptions,
): SkillValidationResult {
  return validateSkillDefinition({
    ...manifest,
    getPrompt: async () => [],
  }, options)
}

export function createSkillManifest(input: SkillManifestInput): SkillManifest {
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  const manifest: SkillManifest = {
    ...input,
    name,
    qualityGates: input.qualityGates?.map(normalizeQualityGate),
    artifactsProduced: input.artifactsProduced?.map(normalizeArtifact),
  }

  if (input.allowedTools && !manifest.permissions) {
    manifest.permissions = { allowedTools: [...input.allowedTools] }
  }

  return manifest
}

export function createSkill(
  manifest: SkillManifest,
  prompt: SkillPromptSource,
): SkillDefinition {
  return {
    ...manifest,
    getPrompt: normalizeSkillPrompt(prompt),
  }
}

export const skillFromManifest = createSkill

function normalizeQualityGate(gate: SkillQualityGateInput): SkillQualityGateSpec {
  if (typeof gate === 'string') return { name: gate }
  return {
    ...gate,
    args: gate.args ? [...gate.args] : undefined,
  }
}

function normalizeArtifact(artifact: SkillArtifactInput): SkillArtifactSpec {
  if (typeof artifact === 'string') return { name: artifact }
  return { ...artifact }
}

function normalizeSkillPrompt(prompt: SkillPromptSource): SkillDefinition['getPrompt'] {
  if (typeof prompt === 'function') return prompt

  if (typeof prompt === 'string') {
    return async () => [{ type: 'text', text: prompt }]
  }

  return async () => prompt
}
