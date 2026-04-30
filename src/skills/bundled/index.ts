/**
 * Bundled Skills Initialization
 *
 * Registers all built-in skills at SDK startup.
 */

import { registerSimplifySkill } from './simplify.js'
import { registerCommitSkill } from './commit.js'
import { registerReviewSkill } from './review.js'
import { registerDebugSkill } from './debug.js'
import { registerTestSkill } from './test.js'
import { registerWorkflowSkills } from './workflow.js'
import { hasSkill } from '../registry.js'

let initialized = false

const bundledSkillNames = [
  'simplify',
  'commit',
  'review',
  'debug',
  'test',
  'define',
  'plan',
  'build',
  'verify',
  'workflow-review',
  'ship',
  'repair',
]

/**
 * Initialize all bundled skills.
 * Safe to call multiple times (idempotent).
 */
export function initBundledSkills(): void {
  if (initialized && bundledSkillNames.every((name) => hasSkill(name))) return
  initialized = true

  registerSimplifySkill()
  registerCommitSkill()
  registerReviewSkill()
  registerDebugSkill()
  registerTestSkill()
  registerWorkflowSkills()
}
