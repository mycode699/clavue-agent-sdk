import test from 'node:test'
import assert from 'node:assert/strict'

import {
  applyGuardrailToolPhase,
  buildErrorToolResult,
  formatGuardrailViolations,
  ingestToolSideEffects,
} from '../src/engine/single-tool-helpers.ts'
import { GuardrailAbortError } from '../src/guardrails/errors.ts'
import type { GuardrailEvaluation, GuardrailViolation } from '../src/guardrails/types.ts'
import type { Evidence, QualityGateResult, ToolResult } from '../src/types.ts'
import type { SkillActivation } from '../src/engine/skill-helpers.ts'

function pass(): GuardrailEvaluation {
  return { passed: true, violations: [] }
}

function fail(violations: Array<{ guardrail: string; message?: string }>): GuardrailEvaluation {
  return {
    passed: false,
    violations: violations.map((v): GuardrailViolation => ({
      guardrail: v.guardrail,
      severity: 'high',
      message: v.message,
    })),
  }
}

test('buildErrorToolResult produces a uniform is_error tool_result', () => {
  const r = buildErrorToolResult({ id: 't1', name: 'Bash' }, 'something went wrong')
  assert.equal(r.type, 'tool_result')
  assert.equal(r.tool_use_id, 't1')
  assert.equal(r.tool_name, 'Bash')
  assert.equal(r.is_error, true)
  assert.equal(r.content, 'something went wrong')
})

test('formatGuardrailViolations joins violation messages with semicolons', () => {
  const ev = fail([
    { guardrail: 'no-secrets', message: 'AWS key detected' },
    { guardrail: 'no-shell', message: 'rm -rf disallowed' },
  ])
  assert.equal(formatGuardrailViolations(ev), 'AWS key detected; rm -rf disallowed')
})

test('formatGuardrailViolations falls back to guardrail name when message missing', () => {
  const ev = fail([{ guardrail: 'no-secrets' }, { guardrail: 'no-shell', message: 'blocked' }])
  assert.equal(formatGuardrailViolations(ev), 'no-secrets; blocked')
})

test('applyGuardrailToolPhase returns pass when evaluation passed', async () => {
  const outcome = await applyGuardrailToolPhase({
    evaluation: pass(),
    block: { id: 't1', name: 'Bash' },
    phase: 'request',
    resolveAction: async () => 'abort',
  })
  assert.equal(outcome.kind, 'pass')
})

test('applyGuardrailToolPhase returns continue when action=continue (audit-only)', async () => {
  const outcome = await applyGuardrailToolPhase({
    evaluation: fail([{ guardrail: 'no-secrets' }]),
    block: { id: 't1', name: 'Bash' },
    phase: 'request',
    resolveAction: async () => 'continue',
  })
  assert.equal(outcome.kind, 'continue')
})

test('applyGuardrailToolPhase returns skip with denied tool_result when action=skip (request)', async () => {
  const outcome = await applyGuardrailToolPhase({
    evaluation: fail([{ guardrail: 'no-secrets', message: 'AWS key' }]),
    block: { id: 't1', name: 'Bash' },
    phase: 'request',
    resolveAction: async () => 'skip',
  })
  assert.equal(outcome.kind, 'skip')
  if (outcome.kind === 'skip') {
    assert.equal(outcome.result.is_error, true)
    assert.match(outcome.result.content as string, /Guardrail denied tool input/)
    assert.match(outcome.result.content as string, /AWS key/)
  }
})

test('applyGuardrailToolPhase skip on response phase says "tool output"', async () => {
  const outcome = await applyGuardrailToolPhase({
    evaluation: fail([{ guardrail: 'pii-scan', message: 'SSN found' }]),
    block: { id: 't1', name: 'Read' },
    phase: 'response',
    resolveAction: async () => 'skip',
  })
  if (outcome.kind === 'skip') {
    assert.match(outcome.result.content as string, /Guardrail denied tool output/)
  }
})

test('applyGuardrailToolPhase throws GuardrailAbortError when action=abort', async () => {
  await assert.rejects(
    () => applyGuardrailToolPhase({
      evaluation: fail([{ guardrail: 'no-secrets', message: 'API key' }]),
      block: { id: 't1', name: 'Bash' },
      phase: 'request',
      resolveAction: async () => 'abort',
    }),
    (err: unknown) => err instanceof GuardrailAbortError && /aborted tool input.*API key/.test((err as Error).message),
  )
})

test('ingestToolSideEffects pushes evidence and quality_gates into accumulators', () => {
  const evidenceAcc: Evidence[] = []
  const gatesAcc: QualityGateResult[] = []
  const toolResult: ToolResult = {
    type: 'tool_result',
    tool_use_id: 't1',
    content: 'ok',
    evidence: [{ source: 'tool', summary: 'read 1 file' }],
    quality_gates: [{ name: 'tests', status: 'passed' }],
  }
  const out = ingestToolSideEffects(toolResult, evidenceAcc, gatesAcc, () => undefined, 'Read')
  assert.equal(evidenceAcc.length, 1)
  assert.equal(gatesAcc.length, 1)
  assert.equal(out.activeSkill, undefined)
  assert.equal(out.forked, undefined)
  assert.deepEqual(out.requiredGateNames, [])
})

test('ingestToolSideEffects activates inline skill from Skill tool result', () => {
  const inlineActivation: SkillActivation = {
    type: 'clavue.skill.activation',
    version: 1,
    success: true,
    skillName: 'TDD',
    status: 'inline',
    prompt: 'Use TDD methodology',
    qualityGates: [
      { name: 'unit-tests', required: true } as any,
      { name: 'audit-log', required: false } as any,
    ],
  }
  const result: ToolResult = { type: 'tool_result', tool_use_id: 't1', content: 'activated' }
  const out = ingestToolSideEffects(result, [], [], () => inlineActivation, 'Skill')
  assert.equal(out.activeSkill, inlineActivation)
  assert.equal(out.forked, undefined)
  // Required-only gates kept; required:false dropped.
  assert.deepEqual(out.requiredGateNames, ['unit-tests'])
})

test('ingestToolSideEffects routes forked skill to the forked slot', () => {
  const forkedActivation: SkillActivation = {
    type: 'clavue.skill.activation',
    version: 1,
    success: true,
    skillName: 'Plan',
    status: 'forked',
    prompt: 'Run plan in subagent',
  }
  const result: ToolResult = { type: 'tool_result', tool_use_id: 't1', content: 'forked' }
  const out = ingestToolSideEffects(result, [], [], () => forkedActivation, 'Skill')
  assert.equal(out.activeSkill, undefined)
  assert.equal(out.forked, forkedActivation)
})

test('ingestToolSideEffects ignores activation parser for non-Skill tools', () => {
  const result: ToolResult = { type: 'tool_result', tool_use_id: 't1', content: 'output' }
  let parserCalled = false
  ingestToolSideEffects(result, [], [], () => {
    parserCalled = true
    return undefined
  }, 'Bash')
  assert.equal(parserCalled, false, 'activation parser only runs for Skill tool')
})
