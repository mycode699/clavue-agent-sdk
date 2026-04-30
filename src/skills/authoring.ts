import { validateSkillDefinition } from './registry.js'
import type {
  SkillDefinition,
  SkillContentBlock,
  SkillValidationOptions,
  SkillValidationResult,
} from './types.js'

export type SkillManifest = Omit<SkillDefinition, 'getPrompt' | 'isEnabled'>

export type SkillPromptSource = string | SkillContentBlock[] | SkillDefinition['getPrompt']

export function validateSkillManifest(
  manifest: SkillManifest,
  options?: SkillValidationOptions,
): SkillValidationResult {
  return validateSkillDefinition({
    ...manifest,
    getPrompt: async () => [],
  }, options)
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

function normalizeSkillPrompt(prompt: SkillPromptSource): SkillDefinition['getPrompt'] {
  if (typeof prompt === 'function') return prompt

  if (typeof prompt === 'string') {
    return async () => [{ type: 'text', text: prompt }]
  }

  return async () => prompt
}
