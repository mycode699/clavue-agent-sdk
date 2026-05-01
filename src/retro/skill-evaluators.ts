import type { SkillManifest } from '../skills/authoring.js'
import type { SkillDefinition } from '../skills/types.js'
import type { RetroDimension, RetroEvaluator, RetroEvidence, RetroFinding } from './types.js'

export type SkillRetroTarget = SkillDefinition | SkillManifest

function skillLocation(skill: SkillRetroTarget): string {
  return skill.name || '<unknown-skill>'
}

function skillEvidence(skill: SkillRetroTarget, detail: string): RetroEvidence[] {
  return [{ kind: 'note', location: skillLocation(skill), detail }]
}

function finding(skill: SkillRetroTarget, input: {
  dimension: RetroDimension
  title: string
  rationale: string
  evidence: string
}): RetroFinding {
  return {
    dimension: input.dimension,
    title: input.title,
    rationale: input.rationale,
    severity: 'medium',
    confidence: 'high',
    disposition: 'fix',
    evidence: skillEvidence(skill, input.evidence),
  }
}

function allowedToolsFor(skill: SkillRetroTarget): string[] | undefined {
  return skill.allowedTools ?? skill.permissions?.allowedTools
}

function hasRequiredEntries(entries: Array<{ name: string; required?: boolean }> | undefined): boolean {
  return Array.isArray(entries) && entries.some((entry) => entry.required !== false)
}

function evaluateSkill(skill: SkillRetroTarget): RetroFinding[] {
  const findings: RetroFinding[] = []
  const requiredGates = skill.qualityGates?.filter((gate) => gate.required !== false) ?? []
  if (
    requiredGates.length === 0 ||
    requiredGates.some((gate) => !gate.evidence && !gate.command)
  ) {
    findings.push(finding(skill, {
      dimension: 'stability',
      title: 'Skill verification evidence is incomplete',
      rationale: 'Promotable skills need required quality gates with deterministic command or evidence expectations.',
      evidence: requiredGates.length === 0
        ? 'No required quality gates were declared.'
        : 'One or more required quality gates lacks command and evidence metadata.',
    }))
  }

  const allowedTools = allowedToolsFor(skill)
  if (!allowedTools || allowedTools.length === 0 || allowedTools.length > 4) {
    findings.push(finding(skill, {
      dimension: 'reliability',
      title: 'Skill tool surface is overbroad',
      rationale: 'Skill promotion should declare the narrowest practical tool surface so activation is predictable and reviewable.',
      evidence: allowedTools && allowedTools.length > 0
        ? `Allowed tools declared: ${allowedTools.join(', ')}.`
        : 'No allowed tool surface was declared.',
    }))
  }

  if (!skill.whenToUse || !hasRequiredEntries(skill.preconditions)) {
    findings.push(finding(skill, {
      dimension: 'interaction_logic',
      title: 'Skill prompt process metadata is incomplete',
      rationale: 'Promotable skills need invocation guidance and required preconditions so hosts can activate them at the right time.',
      evidence: 'Missing whenToUse guidance or required precondition metadata.',
    }))
  }

  const requiredArtifacts = skill.artifactsProduced?.filter((artifact) => artifact.required !== false) ?? []
  if (
    requiredArtifacts.length === 0 ||
    requiredArtifacts.some((artifact) => !artifact.description) ||
    !skill.permissions?.safetyNotes
  ) {
    findings.push(finding(skill, {
      dimension: 'reliability',
      title: 'Skill risk and artifact documentation is incomplete',
      rationale: 'Promotion review needs required artifacts and safety notes to preserve evidence and bound risky behavior.',
      evidence: 'Missing required artifact descriptions or permission safety notes.',
    }))
  }

  return findings
}

export function createSkillRetroEvaluators(skills: SkillRetroTarget[]): RetroEvaluator[] {
  const targets = [...skills]
  return [() => ({ findings: targets.flatMap(evaluateSkill) })]
}
