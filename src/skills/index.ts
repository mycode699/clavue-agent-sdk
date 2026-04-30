/**
 * Skills Module - Public API
 */

// Types
export type {
  SkillDefinition,
  SkillContentBlock,
  SkillPrecondition,
  SkillArtifactSpec,
  SkillQualityGateSpec,
  SkillPermissionSpec,
  SkillCompatibilitySpec,
  SkillValidationIssue,
  SkillValidationOptions,
  SkillValidationResult,
  SkillResult,
} from './types.js'

// Registry
export {
  registerSkill,
  getSkill,
  getAllSkills,
  getUserInvocableSkills,
  hasSkill,
  unregisterSkill,
  clearSkills,
  formatSkillsForPrompt,
  validateSkillDefinition,
} from './registry.js'

// Authoring and loading
export { createSkill, skillFromManifest, validateSkillManifest } from './authoring.js'
export type { SkillManifest, SkillPromptSource } from './authoring.js'
export { loadSkillsFromDir } from './loader.js'
export type {
  LoadedSkill,
  SkillLoadError,
  SkillLoadErrorCode,
  SkillLoaderOptions,
  SkillLoaderResult,
} from './loader.js'

// Bundled skills
export { initBundledSkills } from './bundled/index.js'
