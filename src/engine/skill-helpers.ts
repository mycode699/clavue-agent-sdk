/**
 * Skill activation parsing and quality-gate policy merging.
 * Extracted from `src/engine.ts` to keep skill wiring isolated from the
 * agentic loop hot path.
 */

import type { QualityGatePolicy, ToolDefinition, ToolResult } from '../types.js'
import type { SkillQualityGateSpec } from '../skills/types.js'

export interface SkillActivation {
  type: 'clavue.skill.activation'
  version: 1
  success: true
  skillName?: string
  commandName?: string
  status?: 'inline' | 'forked'
  prompt?: string
  allowedTools?: string[]
  model?: string
  job_id?: string
  qualityGates?: SkillQualityGateSpec[]
}

export function filterToolsForSkill(
  tools: ToolDefinition[],
  allowedTools?: string[],
): ToolDefinition[] {
  if (!allowedTools || allowedTools.length === 0) return tools

  const allowed = new Set([...allowedTools, 'Skill'])
  return tools.filter((tool) => allowed.has(tool.name))
}

export function normalizeSkillQualityGates(
  value: unknown,
): SkillQualityGateSpec[] | undefined {
  if (!Array.isArray(value)) return undefined
  const gates = value.filter((gate): gate is SkillQualityGateSpec => (
    typeof gate === 'object' &&
    gate !== null &&
    typeof (gate as { name?: unknown }).name === 'string'
  ))
  return gates.length > 0 ? gates : undefined
}

export function mergeQualityGatePolicy(
  base: QualityGatePolicy | undefined,
  gateNames: string[],
): QualityGatePolicy {
  const required = [...new Set([...(base?.required ?? []), ...gateNames])]
  return {
    ...base,
    required,
  }
}

export function parseSkillActivation(result: ToolResult): SkillActivation | undefined {
  if (result.is_error || typeof result.content !== 'string') return undefined

  try {
    const parsed = JSON.parse(result.content) as Partial<SkillActivation>
    if (
      parsed?.type !== 'clavue.skill.activation' ||
      parsed.version !== 1 ||
      parsed.success !== true ||
      typeof parsed.prompt !== 'string'
    ) {
      return undefined
    }

    return {
      type: 'clavue.skill.activation',
      version: 1,
      success: true,
      skillName: typeof parsed.skillName === 'string' ? parsed.skillName : parsed.commandName,
      commandName: typeof parsed.commandName === 'string' ? parsed.commandName : parsed.skillName,
      status: parsed.status === 'forked' ? 'forked' : 'inline',
      prompt: parsed.prompt,
      allowedTools: Array.isArray(parsed.allowedTools)
        ? parsed.allowedTools.filter((name): name is string => typeof name === 'string')
        : undefined,
      model: typeof parsed.model === 'string' ? parsed.model : undefined,
      job_id: typeof parsed.job_id === 'string' ? parsed.job_id : undefined,
      qualityGates: normalizeSkillQualityGates(parsed.qualityGates),
    }
  } catch {
    return undefined
  }
}
