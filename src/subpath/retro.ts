/**
 * Subpath barrel: `clavue-agent-sdk/retro`
 *
 * Retro / self-improvement loop primitives. Use this entry point for
 * post-hoc evaluation, scoring, and improvement candidate extraction.
 */

export * from '../retro/index.js'

export {
  extractRunImprovementCandidates,
  runSelfImprovement,
} from '../improvement.js'
export type {
  ImprovementCandidate,
  RunSelfImprovementOptions,
} from '../improvement.js'
