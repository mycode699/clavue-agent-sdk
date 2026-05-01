/**
 * Skill System Types
 *
 * Skills are reusable prompt templates that extend agent capabilities.
 * They can be invoked by the model via the Skill tool or by users via /skillname.
 */

import type { ImageSource, ToolContext } from '../types.js'
import type { HookConfig } from '../hooks.js'
import type { RuntimeNamespaceContext } from '../utils/runtime.js'

/**
 * Content block for skill prompts (compatible with Anthropic API).
 */
export type SkillContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: ImageSource }

export interface SkillPrecondition {
  /** Stable precondition name, such as clean-worktree or test-target-known. */
  name: string
  /** Human-readable precondition detail. */
  description?: string
  /** Whether the workflow should treat this as required. Defaults to true. */
  required?: boolean
}

export interface SkillArtifactSpec {
  /** Stable artifact name, such as plan, patch, test-output, or review-findings. */
  name: string
  /** Artifact kind for hosts and prompts. */
  type?: 'text' | 'file' | 'command-output' | 'trace' | 'evidence' | string
  /** Human-readable artifact detail. */
  description?: string
  /** Whether this artifact is expected before completion. Defaults to true. */
  required?: boolean
}

export interface SkillQualityGateSpec {
  /** Stable gate name, such as build, tests, lint, review, or approval. */
  name: string
  /** Human-readable gate detail. */
  description?: string
  /** Optional command hint for deterministic verification gates. */
  command?: string
  /** Optional command args for deterministic verification gates. */
  args?: string[]
  /** Whether this gate is required before claiming completion. Defaults to true. */
  required?: boolean
  /** Evidence expected from this gate. */
  evidence?: string
}

export interface SkillPermissionSpec {
  /** Tool names this skill expects to use. Mirrors allowedTools but is metadata-friendly. */
  allowedTools?: string[]
  /** Tool names this skill must not use. */
  disallowedTools?: string[]
  /** Whether risky actions should require explicit approval. */
  requiresApproval?: boolean
  /** Human-readable safety note for hosts or reviewers. */
  safetyNotes?: string
}

export interface SkillCompatibilitySpec {
  /** SDK version/range this skill expects. */
  sdk?: string
  /** Supported model identifiers or families. */
  models?: string[]
  /** Supported provider identifiers. */
  providers?: string[]
  /** Supported runtime environments. */
  environments?: string[]
}

export interface SkillValidationIssue {
  code: string
  message: string
  path: string
  severity: 'error' | 'warning'
}

export interface SkillValidationResult {
  valid: boolean
  issues: SkillValidationIssue[]
}

export interface SkillValidationOptions {
  availableTools?: string[]
}

/**
 * Bundled skill definition.
 *
 * Skills provide specialized capabilities by injecting context-specific
 * prompts with optional tool restrictions and model overrides.
 */
export interface SkillDefinition {
  /** Skill manifest version. */
  version?: string

  /** Unique skill name (e.g., 'simplify', 'commit') */
  name: string

  /** Human-readable description */
  description: string

  /** Alternative names for the skill */
  aliases?: string[]

  /** When the model should invoke this skill (used in system prompt) */
  whenToUse?: string

  /** Hint for expected arguments */
  argumentHint?: string

  /** Tools the skill is allowed to use (empty = all tools) */
  allowedTools?: string[]

  /** Preconditions that should be satisfied before or during execution. */
  preconditions?: SkillPrecondition[]

  /** Artifacts this skill should produce or preserve. */
  artifactsProduced?: SkillArtifactSpec[]

  /** Quality gates the skill should satisfy before claiming completion. */
  qualityGates?: SkillQualityGateSpec[]

  /** Permission metadata for hosts and workflow prompts. */
  permissions?: SkillPermissionSpec

  /** Compatibility metadata for hosts and future plugin loaders. */
  compatibility?: SkillCompatibilitySpec

  /** Optional output schema for machine-readable skill results. */
  outputSchema?: Record<string, unknown>

  /** Model override for this skill */
  model?: string

  /** Whether the skill can be invoked by users via /command */
  userInvocable?: boolean

  /** Runtime check for availability */
  isEnabled?: (context?: RuntimeNamespaceContext) => boolean

  /** Hook overrides while skill is active */
  hooks?: HookConfig

  /** Execution context: 'inline' runs in current context, 'fork' spawns a subagent */
  context?: 'inline' | 'fork'

  /** Subagent type for forked execution */
  agent?: string

  /**
   * Generate the prompt content blocks for this skill.
   *
   * @param args - User-provided arguments (e.g., from "/simplify focus on error handling")
   * @param context - Tool execution context (cwd, etc.)
   * @returns Content blocks to inject into the conversation
   */
  getPrompt: (
    args: string,
    context: ToolContext,
  ) => Promise<SkillContentBlock[]>
}

/**
 * Result of executing a skill.
 */
export interface SkillResult {
  /** Whether execution succeeded */
  success: boolean

  /** Skill name that was executed */
  skillName: string

  /** Execution status */
  status: 'inline' | 'forked'

  /** Allowed tools override (for inline execution) */
  allowedTools?: string[]

  /** Model override */
  model?: string

  /** Result text (for forked execution) */
  result?: string

  /** Error message */
  error?: string
}
