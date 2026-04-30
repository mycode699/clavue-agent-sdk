import type { Evidence, QualityGateResult } from './types.js'
import type { RetroCycleDecision, RetroQualityGate } from './retro/index.js'

export type EvaluationLoopComparator = '>=' | '>' | '<=' | '<' | '==' | '!='
export type EvaluationLoopDecisionValue = 'keep' | 'discard' | 'retry' | 'escalate'

export interface EvaluationLoopBaseline {
  ref: string
  value?: number | string | boolean
}

export interface EvaluationLoopMetric {
  name: string
  comparator: EvaluationLoopComparator
  target: number | string | boolean
}

export interface EvaluationLoopBudget {
  maxIterations?: number
  maxCostUsd?: number
  timeoutMs?: number
}

export interface EvaluationLoopVerification {
  commands?: string[]
  gates: RetroQualityGate[]
  qualityGateResults: QualityGateResult[]
}

export interface EvaluationLoopDecision {
  value: EvaluationLoopDecisionValue
  reason: string
}

export interface EvaluationLoopContract {
  version: 1
  objective: string
  baseline?: EvaluationLoopBaseline
  metric: EvaluationLoopMetric
  budget?: EvaluationLoopBudget
  verification: EvaluationLoopVerification
  evidence: Evidence[]
  decision: EvaluationLoopDecision
}

export interface EvaluationLoopContractInput {
  objective: string
  baseline?: string | EvaluationLoopBaseline
  metric: EvaluationLoopMetric
  budget?: EvaluationLoopBudget
  verification?: Partial<EvaluationLoopVerification>
  evidence?: Evidence[]
  decision: EvaluationLoopDecision | RetroCycleDecision
}

const COMPARATORS: EvaluationLoopComparator[] = ['>=', '>', '<=', '<', '==', '!=']
const DECISIONS: EvaluationLoopDecisionValue[] = ['keep', 'discard', 'retry', 'escalate']

export function createEvaluationLoopContract(input: EvaluationLoopContractInput): EvaluationLoopContract {
  return normalizeEvaluationLoopContract(input)
}

export function normalizeEvaluationLoopContract(input: EvaluationLoopContractInput): EvaluationLoopContract {
  const objective = requireNonEmptyString(input.objective, 'objective')
  const metric = normalizeMetric(input.metric)

  return {
    version: 1,
    objective,
    ...(input.baseline === undefined ? {} : { baseline: normalizeBaseline(input.baseline) }),
    metric,
    ...(input.budget === undefined ? {} : { budget: normalizeBudget(input.budget) }),
    verification: normalizeVerification(input.verification),
    evidence: input.evidence?.map(normalizeEvidence) ?? [],
    decision: normalizeDecision(input.decision),
  }
}

function normalizeBaseline(input: string | EvaluationLoopBaseline): EvaluationLoopBaseline {
  if (typeof input === 'string') {
    return { ref: requireNonEmptyString(input, 'baseline ref') }
  }

  return {
    ref: requireNonEmptyString(input.ref, 'baseline ref'),
    ...(input.value === undefined ? {} : { value: input.value }),
  }
}

function normalizeMetric(input: EvaluationLoopMetric): EvaluationLoopMetric {
  if (!COMPARATORS.includes(input.comparator)) {
    throw new Error(`metric comparator must be one of ${COMPARATORS.join(', ')}`)
  }

  return {
    name: requireNonEmptyString(input.name, 'metric name'),
    comparator: input.comparator,
    target: normalizeMetricTarget(input.target),
  }
}

function normalizeMetricTarget(value: unknown): number | string | boolean {
  if (typeof value === 'string') {
    return requireNonEmptyString(value, 'metric target')
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  throw new Error('metric target must be a number, string, or boolean')
}

function normalizeBudget(input: EvaluationLoopBudget): EvaluationLoopBudget {
  return {
    ...(input.maxIterations === undefined ? {} : { maxIterations: requirePositiveInteger(input.maxIterations, 'budget maxIterations') }),
    ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: requireNonNegativeNumber(input.maxCostUsd, 'budget maxCostUsd') }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: requirePositiveInteger(input.timeoutMs, 'budget timeoutMs') }),
  }
}

function normalizeVerification(input: Partial<EvaluationLoopVerification> | undefined): EvaluationLoopVerification {
  if (input?.commands !== undefined && !Array.isArray(input.commands)) {
    throw new Error('verification commands must be an array')
  }
  if (input?.gates !== undefined && !Array.isArray(input.gates)) {
    throw new Error('verification gates must be an array')
  }

  return {
    ...(input?.commands === undefined ? {} : { commands: input.commands.map((command) => requireNonEmptyString(command, 'verification command')) }),
    gates: input?.gates?.map(normalizeGate) ?? [],
    qualityGateResults: input?.qualityGateResults?.map((result) => ({ ...result })) ?? [],
  }
}

function normalizeGate(input: RetroQualityGate): RetroQualityGate {
  return {
    name: requireNonEmptyString(input.name, 'verification gate name'),
    command: requireNonEmptyString(input.command, 'verification gate command'),
    ...(input.args === undefined ? {} : { args: [...input.args] }),
    ...(input.cwd === undefined ? {} : { cwd: input.cwd }),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    ...(input.continueOnFailure === undefined ? {} : { continueOnFailure: input.continueOnFailure }),
  }
}

function normalizeEvidence(input: Evidence): Evidence {
  return { ...input }
}

function normalizeDecision(input: EvaluationLoopDecision | RetroCycleDecision): EvaluationLoopDecision {
  if ('value' in input) {
    if (!DECISIONS.includes(input.value)) {
      throw new Error(`decision value must be one of ${DECISIONS.join(', ')}`)
    }

    return {
      value: input.value,
      reason: requireNonEmptyString(input.reason, 'decision reason'),
    }
  }

  return {
    value: input.disposition === 'accepted' ? 'keep' : input.disposition === 'rejected' ? 'discard' : 'retry',
    reason: requireNonEmptyString(input.reason, 'decision reason'),
  }
}

function requireNonEmptyString(value: string, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${label} must be a non-empty string`)
  }
  return value
}

function requirePositiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return value
}

function requireNonNegativeNumber(value: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative number`)
  }
  return value
}
