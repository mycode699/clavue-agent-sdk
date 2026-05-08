/**
 * Pure quality-gate policy resolution + terminal-failure detection.
 * Extracted from `QueryEngine` so the agentic loop decision can be
 * unit-tested without instantiating the full engine.
 */

import type { QualityGatePolicy, QualityGateResult } from '../types.js'
import { mergeQualityGatePolicy } from './skill-helpers.js'

export function resolveActiveQualityGatePolicy(
  configuredPolicy: QualityGatePolicy | undefined,
  requiredSkillGates: string[],
): QualityGatePolicy | undefined {
  if (requiredSkillGates.length === 0) {
    return configuredPolicy
  }
  return mergeQualityGatePolicy(configuredPolicy, requiredSkillGates)
}

export function findTerminalQualityGateFailure(
  policy: QualityGatePolicy | undefined,
  qualityGates: QualityGateResult[],
): QualityGateResult | undefined {
  if (!policy) return undefined

  const failStatuses = new Set(policy.failStatuses ?? ['failed'])
  const required = policy.required ? new Set(policy.required) : undefined

  if (required) {
    for (const name of required) {
      const gate = qualityGates.find((entry) => entry.name === name)
      if (!gate) {
        return {
          name,
          status: 'pending',
          summary: 'Required quality gate did not report a result',
        }
      }
      if (failStatuses.has(gate.status)) return gate
    }
    return undefined
  }

  return qualityGates.find((gate) => failStatuses.has(gate.status))
}
