import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createSkillRetroEvaluators,
  runRetroEvaluation,
  type RetroFinding,
  type SkillManifest,
} from '../src/index.ts'

test('skill retro evaluators flag weak promotion metadata deterministically', async () => {
  const weakSkill: SkillManifest = {
    name: 'weak-promotion-skill',
    description: 'Weak skill fixture for deterministic retro evaluation.',
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    permissions: {
      allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep'],
    },
    qualityGates: [{ name: 'tests' }],
    artifactsProduced: [{ name: 'summary' }],
  }

  const evaluators = createSkillRetroEvaluators([weakSkill])
  const results = await Promise.all(evaluators.map((evaluator) => evaluator({
    target: { name: 'skill-promotion' },
    evaluators,
  })))
  const findings: RetroFinding[] = results.flatMap((result) => result.findings)

  assert.deepEqual(findings.map((finding) => finding.title), [
    'Skill verification evidence is incomplete',
    'Skill tool surface is overbroad',
    'Skill prompt process metadata is incomplete',
    'Skill risk and artifact documentation is incomplete',
  ])
  assert.ok(findings.every((finding) => finding.evidence?.[0]?.location === 'weak-promotion-skill'))
  assert.ok(findings.some((finding) => finding.dimension === 'stability'))
  assert.ok(findings.some((finding) => finding.dimension === 'reliability'))
  assert.ok(findings.some((finding) => finding.dimension === 'interaction_logic'))
})

test('skill retro evaluators are compatible with retro evaluation scoring', async () => {
  const promotableSkill: SkillManifest = {
    name: 'promotable-skill',
    description: 'Skill fixture with complete promotion metadata.',
    whenToUse: 'Use when promotion metadata must be checked.',
    allowedTools: ['Read', 'Grep'],
    permissions: {
      allowedTools: ['Read', 'Grep'],
      safetyNotes: 'Read-only inspection only.',
    },
    preconditions: [{ name: 'skill-known' }],
    artifactsProduced: [{ name: 'review-findings', description: 'Promotion review findings.' }],
    qualityGates: [{ name: 'verification-passed', evidence: 'Focused skill retro tests pass.' }],
  }

  const run = await runRetroEvaluation({
    target: { name: 'skill-promotion' },
    evaluators: createSkillRetroEvaluators([promotableSkill]),
  })

  assert.equal(run.findings.length, 0)
  assert.equal(run.scores.overall.score, 100)
})
