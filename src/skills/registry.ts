/**
 * Skill Registry
 *
 * Central registry for managing skill definitions.
 * Skills can be registered programmatically or loaded from bundled definitions.
 */

import type {
  SkillDefinition,
  SkillValidationIssue,
  SkillValidationOptions,
  SkillValidationResult,
} from './types.js'
import {
  DEFAULT_RUNTIME_NAMESPACE,
  getRuntimeNamespace,
  type RuntimeNamespaceContext,
} from '../utils/runtime.js'

interface SkillNamespaceState {
  skills: Map<string, SkillDefinition>
  aliases: Map<string, string>
}

const skillNamespaces: Map<string, SkillNamespaceState> = new Map()

function getSkillState(context?: RuntimeNamespaceContext): SkillNamespaceState {
  const namespace = getRuntimeNamespace(context)
  let state = skillNamespaces.get(namespace)
  if (!state) {
    state = { skills: new Map(), aliases: new Map() }
    skillNamespaces.set(namespace, state)
  }
  return state
}

/**
 * Register a skill definition.
 */
export function registerSkill(
  definition: SkillDefinition,
  context?: RuntimeNamespaceContext,
): void {
  assertValidSkillDefinition(definition)

  const { skills, aliases } = getSkillState(context)
  skills.set(definition.name, definition)

  // Register aliases
  if (definition.aliases) {
    for (const alias of definition.aliases) {
      aliases.set(alias, definition.name)
    }
  }
}

export function validateSkillDefinition(
  definition: SkillDefinition,
  options: SkillValidationOptions = {},
): SkillValidationResult {
  const issues: SkillValidationIssue[] = []
  const addIssue = (code: string, message: string, path: string): void => {
    issues.push({ code, message, path, severity: 'error' })
  }

  const skillName = typeof definition.name === 'string' && definition.name ? definition.name : '<unknown>'
  if (!definition.name || typeof definition.name !== 'string') {
    addIssue('missing_name', 'Skill name is required', 'name')
  } else if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(definition.name)) {
    addIssue('invalid_name', `Invalid skill name: ${definition.name}`, 'name')
  }

  if (!definition.description || typeof definition.description !== 'string') {
    addIssue('missing_description', `Skill "${skillName}" description is required`, 'description')
  }

  validateAliases(definition, addIssue)
  validateNamedList(definition.preconditions, skillName, 'precondition', 'preconditions', addIssue)
  validateNamedList(definition.artifactsProduced, skillName, 'artifact', 'artifactsProduced', addIssue)
  validateQualityGates(definition.qualityGates, skillName, addIssue)
  validatePermissions(definition, options, addIssue)
  validateOutputSchema(definition.outputSchema, skillName, addIssue)
  validateContext(definition, skillName, addIssue)
  validatePrompt(definition, skillName, addIssue)

  return { valid: issues.length === 0, issues }
}

function assertValidSkillDefinition(definition: SkillDefinition): void {
  const result = validateSkillDefinition(definition)
  if (result.valid) return

  throw new Error(`Invalid skill definition: ${result.issues.map((issue) => issue.message).join('; ')}`)
}

function validateAliases(
  definition: SkillDefinition,
  addIssue: (code: string, message: string, path: string) => void,
): void {
  if (definition.aliases === undefined) return
  if (!Array.isArray(definition.aliases)) {
    addIssue('invalid_aliases', `Skill "${definition.name}" aliases must be an array`, 'aliases')
    return
  }

  const seen = new Set<string>()
  definition.aliases.forEach((alias, index) => {
    const path = `aliases[${index}]`
    if (!alias || typeof alias !== 'string') {
      addIssue('invalid_alias', `Skill "${definition.name}" has an invalid alias`, path)
      return
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(alias)) {
      addIssue('invalid_alias', `Invalid skill alias: ${alias}`, path)
    }
    if (alias === definition.name) {
      addIssue('alias_conflicts_with_name', `Skill alias "${alias}" conflicts with the skill name`, path)
    }
    if (seen.has(alias)) {
      addIssue('duplicate_alias', `Skill alias "${alias}" is duplicated`, path)
    }
    seen.add(alias)
  })
}

function validateNamedList(
  entries: Array<{ name: string }> | undefined,
  skillName: string,
  label: string,
  path: string,
  addIssue: (code: string, message: string, path: string) => void,
): void {
  if (entries === undefined) return
  if (!Array.isArray(entries)) {
    addIssue(`invalid_${path}`, `Skill "${skillName}" ${label}s must be an array`, path)
    return
  }

  const seen = new Set<string>()
  entries.forEach((entry, index) => {
    const entryPath = `${path}[${index}].name`
    if (!entry?.name || typeof entry.name !== 'string') {
      addIssue(`invalid_${label.replaceAll(' ', '_')}`, `Skill "${skillName}" has an invalid ${label} entry`, entryPath)
      return
    }
    if (seen.has(entry.name)) {
      addIssue(`duplicate_${label.replaceAll(' ', '_')}`, `Skill "${skillName}" has duplicate ${label} "${entry.name}"`, entryPath)
    }
    seen.add(entry.name)
  })
}

function validateQualityGates(
  gates: SkillDefinition['qualityGates'],
  skillName: string,
  addIssue: (code: string, message: string, path: string) => void,
): void {
  validateNamedList(gates, skillName, 'quality gate', 'qualityGates', addIssue)
  if (!Array.isArray(gates)) return

  gates.forEach((gate, index) => {
    if (gate.args !== undefined && !Array.isArray(gate.args)) {
      addIssue('invalid_gate_args', `Skill "${skillName}" quality gate "${gate.name}" args must be an array`, `qualityGates[${index}].args`)
    }
  })
}

function validatePermissions(
  definition: SkillDefinition,
  options: SkillValidationOptions,
  addIssue: (code: string, message: string, path: string) => void,
): void {
  const availableTools = options.availableTools ? new Set(options.availableTools) : undefined
  const runtimeAllowed = validateToolList('allowed', definition.allowedTools, 'allowedTools', availableTools, addIssue)
  const permissions = definition.permissions
  if (!permissions) return

  const metadataAllowed = validateToolList('allowed', permissions.allowedTools, 'permissions.allowedTools', availableTools, addIssue)
  const disallowed = validateToolList('disallowed', permissions.disallowedTools, 'permissions.disallowedTools', availableTools, addIssue)
  if (!metadataAllowed || !disallowed) return

  permissions.disallowedTools?.forEach((tool, index) => {
    if (metadataAllowed.has(tool)) {
      addIssue('tool_permission_overlap', `Tool "${tool}" appears in both allowedTools and disallowedTools`, `permissions.disallowedTools[${index}]`)
    }
  })

  if (definition.allowedTools !== undefined && permissions.allowedTools !== undefined && runtimeAllowed && !setsEqual(runtimeAllowed, metadataAllowed)) {
    addIssue('allowed_tools_mismatch', 'allowedTools and permissions.allowedTools must declare the same tools', 'permissions.allowedTools')
  }
}

function validateToolList(
  label: 'allowed' | 'disallowed',
  tools: string[] | undefined,
  path: string,
  availableTools: Set<string> | undefined,
  addIssue: (code: string, message: string, path: string) => void,
): Set<string> | undefined {
  if (tools === undefined) return new Set()
  if (!Array.isArray(tools)) {
    addIssue(`invalid_${label}_tools`, `${path} must be an array`, path)
    return undefined
  }

  const seen = new Set<string>()
  tools.forEach((tool, index) => {
    const entryPath = `${path}[${index}]`
    if (!tool || typeof tool !== 'string') {
      addIssue(`invalid_${label}_tool`, `${path} contains an invalid tool name`, entryPath)
      return
    }
    if (seen.has(tool)) {
      addIssue(`duplicate_${label}_tool`, `Tool "${tool}" is duplicated in ${path}`, entryPath)
    }
    if (availableTools && !availableTools.has(tool)) {
      addIssue(`unknown_${label}_tool`, `Tool "${tool}" is not available`, entryPath)
    }
    seen.add(tool)
  })
  return seen
}

function setsEqual(left: Set<string>, right: Set<string>): boolean {
  if (left.size !== right.size) return false
  for (const value of left) {
    if (!right.has(value)) return false
  }
  return true
}

function validateOutputSchema(
  schema: SkillDefinition['outputSchema'],
  skillName: string,
  addIssue: (code: string, message: string, path: string) => void,
): void {
  if (schema === undefined) return
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) {
    addIssue('invalid_output_schema', `Skill "${skillName}" outputSchema must be an object`, 'outputSchema')
  }
}

function validateContext(
  definition: SkillDefinition,
  skillName: string,
  addIssue: (code: string, message: string, path: string) => void,
): void {
  if (definition.context === 'fork' && (!definition.agent || typeof definition.agent !== 'string')) {
    addIssue('missing_fork_agent', `Skill "${skillName}" with fork context requires a non-empty agent`, 'agent')
  }
}

function validatePrompt(
  definition: SkillDefinition,
  skillName: string,
  addIssue: (code: string, message: string, path: string) => void,
): void {
  if (typeof definition.getPrompt !== 'function') {
    addIssue('missing_prompt_function', `Skill "${skillName}" getPrompt must be a function`, 'getPrompt')
  }
}

/**
 * Get a skill by name or alias.
 */
export function getSkill(name: string, context?: RuntimeNamespaceContext): SkillDefinition | undefined {
  const namespace = getRuntimeNamespace(context)
  const { skills, aliases } = getSkillState(context)
  // Direct lookup
  const direct = skills.get(name)
  if (direct) return direct

  // Alias lookup
  const resolved = aliases.get(name)
  if (resolved) return skills.get(resolved)

  if (namespace !== DEFAULT_RUNTIME_NAMESPACE) {
    return getSkill(name)
  }

  return undefined
}

/**
 * Get all registered skills.
 */
export function getAllSkills(context?: RuntimeNamespaceContext): SkillDefinition[] {
  const namespace = getRuntimeNamespace(context)
  if (namespace === DEFAULT_RUNTIME_NAMESPACE) {
    return Array.from(getSkillState(context).skills.values())
  }

  const localSkills = Array.from(getSkillState(context).skills.values())
  const localNames = new Set(localSkills.map((skill) => skill.name))
  const globalSkills = getAllSkills().filter((skill) => !localNames.has(skill.name))
  return [...localSkills, ...globalSkills]
}

/**
 * Get all user-invocable skills (for /command listing).
 */
export function getUserInvocableSkills(context?: RuntimeNamespaceContext): SkillDefinition[] {
  return getAllSkills(context).filter(
    (s) => s.userInvocable !== false && (!s.isEnabled || s.isEnabled(context)),
  )
}

/**
 * Check if a skill exists.
 */
export function hasSkill(name: string, context?: RuntimeNamespaceContext): boolean {
  const namespace = getRuntimeNamespace(context)
  const { skills, aliases } = getSkillState(context)
  return skills.has(name) || aliases.has(name) || (namespace !== DEFAULT_RUNTIME_NAMESPACE && hasSkill(name))
}

/**
 * Remove a skill.
 */
export function unregisterSkill(name: string, context?: RuntimeNamespaceContext): boolean {
  const { skills, aliases } = getSkillState(context)
  const skill = skills.get(name)
  if (!skill) return false

  // Remove aliases
  if (skill.aliases) {
    for (const alias of skill.aliases) {
      aliases.delete(alias)
    }
  }

  return skills.delete(name)
}

/**
 * Clear all skills (for testing).
 */
export function clearSkills(context?: RuntimeNamespaceContext): void {
  const namespace = getRuntimeNamespace(context)
  if (namespace === 'default') {
    skillNamespaces.clear()
    return
  }
  skillNamespaces.delete(namespace)
}

/**
 * Format skills listing for system prompt injection.
 *
 * Uses a budget system: skills listing gets a limited character budget
 * to avoid bloating the context window.
 */
export function formatSkillsForPrompt(
  contextWindowTokens?: number,
  context?: RuntimeNamespaceContext,
): string {
  const invocable = getUserInvocableSkills(context)
  if (invocable.length === 0) return ''

  // Budget: 1% of context window in characters (4 chars per token)
  const CHARS_PER_TOKEN = 4
  const DEFAULT_BUDGET = 8000
  const MAX_DESC_CHARS = 250
  const budget = contextWindowTokens
    ? Math.floor(contextWindowTokens * 0.01 * CHARS_PER_TOKEN)
    : DEFAULT_BUDGET

  const lines: string[] = []
  let used = 0

  for (const skill of invocable) {
    const desc = skill.description.length > MAX_DESC_CHARS
      ? skill.description.slice(0, MAX_DESC_CHARS) + '...'
      : skill.description

    const trigger = skill.whenToUse
      ? ` TRIGGER when: ${skill.whenToUse}`
      : ''
    const argumentHint = skill.argumentHint
      ? ` ARGS: ${skill.argumentHint}`
      : ''
    const preconditions = formatSkillMetadataList(
      'PRE',
      skill.preconditions?.filter((entry) => entry.required !== false).map((entry) => entry.name),
    )
    const artifacts = formatSkillMetadataList(
      'ARTIFACTS',
      skill.artifactsProduced?.filter((entry) => entry.required !== false).map((entry) => entry.name),
    )
    const gates = formatSkillMetadataList(
      'GATES',
      skill.qualityGates?.filter((entry) => entry.required !== false).map((entry) => entry.name),
    )

    const line = `- ${skill.name}: ${desc}${trigger}${argumentHint}${preconditions}${artifacts}${gates}`

    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
  }

  return lines.join('\n')
}

function formatSkillMetadataList(label: string, values?: string[]): string {
  const normalized = [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))]
  return normalized.length > 0 ? ` ${label}: ${normalized.join(', ')}` : ''
}
