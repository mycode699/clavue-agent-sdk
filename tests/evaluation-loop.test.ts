import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createEvaluationLoopContract,
  normalizeEvaluationLoopContract,
  type QualityGateResult,
  type RetroCycleDecision,
} from '../src/index.ts'

test('normalizes evaluation loop contract deterministically', () => {
  const contract = createEvaluationLoopContract({
    objective: 'Improve tool-call reliability',
    baseline: { ref: 'retro-run-001', value: 0.82 },
    metric: { name: 'quality_score', target: 0.9, comparator: '>=' },
    budget: { maxIterations: 3, maxCostUsd: 2.5 },
    verification: {
      gates: [
        { name: 'build', command: 'npm', args: ['run', 'build'] },
      ],
    },
    evidence: [{ type: 'test', summary: 'focused gate passed', location: 'tests/evaluation-loop.test.ts' }],
    decision: { value: 'retry', reason: 'Below target after first attempt' },
  })

  assert.deepEqual(contract, {
    version: 1,
    objective: 'Improve tool-call reliability',
    baseline: { ref: 'retro-run-001', value: 0.82 },
    metric: { name: 'quality_score', comparator: '>=', target: 0.9 },
    budget: { maxIterations: 3, maxCostUsd: 2.5 },
    verification: {
      gates: [
        { name: 'build', command: 'npm', args: ['run', 'build'] },
      ],
      qualityGateResults: [],
    },
    evidence: [{ type: 'test', summary: 'focused gate passed', location: 'tests/evaluation-loop.test.ts' }],
    decision: { value: 'retry', reason: 'Below target after first attempt' },
  })
  assert.deepEqual(normalizeEvaluationLoopContract(contract), contract)
})

test('rejects invalid evaluation loop input', () => {
  assert.throws(
    () => createEvaluationLoopContract({
      objective: '',
      metric: { name: 'quality_score', comparator: '>=', target: 0.9 },
      decision: { value: 'keep', reason: 'done' },
    }),
    /objective must be a non-empty string/,
  )

  assert.throws(
    () => createEvaluationLoopContract({
      objective: 'Improve tool-call reliability',
      metric: { name: 'quality_score', comparator: 'approximately' as any, target: 0.9 },
      decision: { value: 'keep', reason: 'done' },
    }),
    /metric comparator must be one of/,
  )
})

test('rejects missing metric target', () => {
  assert.throws(
    () => createEvaluationLoopContract({
      objective: 'Improve tool-call reliability',
      metric: { name: 'quality_score', comparator: '>=', target: undefined as any },
      decision: { value: 'keep', reason: 'done' },
    }),
    /metric target must be a number, string, or boolean/,
  )
})

test('rejects empty string metric target', () => {
  assert.throws(
    () => createEvaluationLoopContract({
      objective: 'Improve tool-call reliability',
      metric: { name: 'quality_score', comparator: '==', target: '' },
      decision: { value: 'keep', reason: 'done' },
    }),
    /metric target must be a non-empty string/,
  )
})

test('rejects non-array verification commands', () => {
  assert.throws(
    () => createEvaluationLoopContract({
      objective: 'Reduce regressions',
      metric: { name: 'regression_count', comparator: '<=', target: 0 },
      verification: { commands: 'npm test' as any },
      decision: { value: 'keep', reason: 'No regressions found' },
    }),
    /verification commands must be an array/,
  )
})

test('produces JSON-serializable evaluation loop contract output', () => {
  const contract = createEvaluationLoopContract({
    objective: 'Reduce regressions',
    baseline: 'retro-run-previous',
    metric: { name: 'regression_count', comparator: '<=', target: 0 },
    verification: { commands: ['npm test'] },
    decision: { value: 'keep', reason: 'No regressions found' },
  })

  assert.deepEqual(JSON.parse(JSON.stringify(contract)), contract)
})

test('accepts existing quality gate results and maps retro decisions', () => {
  const qualityGateResult: QualityGateResult = {
    name: 'tests',
    status: 'passed',
    summary: '172 tests passed',
  }
  const retroDecision: RetroCycleDecision = {
    disposition: 'retry',
    accepted: false,
    shouldRetry: true,
    reason: 'Verification failed',
  }

  const contract = createEvaluationLoopContract({
    objective: 'Stabilize eval loop',
    metric: { name: 'test_pass_rate', comparator: '>=', target: 1 },
    verification: { qualityGateResults: [qualityGateResult] },
    decision: retroDecision,
  })

  assert.deepEqual(contract.verification.qualityGateResults, [qualityGateResult])
  assert.deepEqual(contract.decision, { value: 'retry', reason: 'Verification failed' })
})
