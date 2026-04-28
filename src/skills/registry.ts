/**
 * Skill Registry
 *
 * Central registry for managing skill definitions.
 * Skills can be registered programmatically or loaded from bundled definitions.
 */

import type { SkillDefinition } from './types.js'
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
  const { skills, aliases } = getSkillState(context)
  skills.set(definition.name, definition)

  // Register aliases
  if (definition.aliases) {
    for (const alias of definition.aliases) {
      aliases.set(alias, definition.name)
    }
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

  const byName = new Map<string, SkillDefinition>()
  for (const skill of getAllSkills()) byName.set(skill.name, skill)
  for (const skill of getSkillState(context).skills.values()) byName.set(skill.name, skill)
  return Array.from(byName.values())
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

    const line = `- ${skill.name}: ${desc}${trigger}`

    if (used + line.length > budget) break
    lines.push(line)
    used += line.length
  }

  return lines.join('\n')
}
