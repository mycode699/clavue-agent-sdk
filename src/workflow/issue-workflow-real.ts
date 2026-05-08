/**
 * Real LLM-driven issue workflow loop.
 *
 * `runIssueWorkflowWithAgent` is the v2 replacement for the legacy
 * `runIssueWorkflow` (which only acts as a record-keeper around a host-supplied
 * `evaluateRole` callback and never invokes an LLM). This implementation:
 *
 *   1. Runs an Agent in `build` mode to produce code changes for the issue.
 *   2. Calls the supplied Verifier to grade the resulting workspace
 *      (tests, lint, typecheck, etc.).
 *   3. If gates pass: returns success with a proof-of-work artifact.
 *   4. If gates fail: runs an Agent in `review` mode to produce a fix plan,
 *      then loops back to step 1 (up to `maxIterations`, default 3).
 *
 * The legacy `runIssueWorkflow` API is preserved unchanged in
 * `src/issue-workflow.ts`. This file is a pure addition.
 *
 * @module
 */

import type { AgentRunResult, AgentOptions, QualityGateResult } from '../types.js'
import {
  createIssueWorkflowRun,
  writeIssueWorkflowRun,
  appendIssueWorkflowJob,
  createIssueWorkflowProofOfWork,
  waitForIssueWorkflowJob,
  type IssueWorkflowRecord,
  type IssueWorkflowResult,
  type IssueWorkflowRunRecord,
  type IssueWorkflowStatus,
  type IssueWorkflowFinding,
  type IssueWorkflowJobRef,
} from '../issue-workflow.js'
import { runAgentJob, type AgentJobStoreOptions } from '../agent-jobs.js'
import type { RuntimeNamespaceContext } from '../utils/runtime.js'
import type { Verifier } from './verifier.js'

/**
 * AgentLike — the minimum surface this loop needs from an Agent. Accepting a
 * structural type (instead of importing the concrete Agent class) keeps tests
 * easy to write with mock objects and avoids a circular import surface.
 */
export interface AgentLike {
  run(text: string, overrides?: Partial<AgentOptions>): Promise<AgentRunResult>
}

export interface RunIssueWorkflowWithAgentInput {
  /** The issue record to work on (use `normalizeIssueInput` to build one). */
  issue: IssueWorkflowRecord
  /** The Agent that will execute build / review prompts. Required. */
  agent: AgentLike
  /** Verifier that grades the workspace after each build attempt. Required. */
  verifier: Verifier
  /** Working directory where the Agent should make its changes. Required. */
  cwd: string
  /** Names of gates that must pass for the run to be considered completed. */
  requiredGates?: string[]
  /** Reviewer score (0-100) at or above which the loop terminates. Default 80. */
  passingScore?: number
  /** Hard ceiling on iteration count. Default 3, max 10. */
  maxIterations?: number
  /** Optional custom prompt builders. Defaults render English instructions. */
  prompts?: IssueWorkflowPrompts
}

export interface IssueWorkflowPrompts {
  /** Build prompt — instructs the Agent to make changes for this issue. */
  build?: (input: { issue: IssueWorkflowRecord; iteration: number; reviewFeedback?: string }) => string
  /** Review prompt — asks the Agent to summarize remaining work given gate failures. */
  review?: (input: { issue: IssueWorkflowRecord; iteration: number; gates: QualityGateResult[] }) => string
}

const DEFAULT_MAX_ITERATIONS = 3
const HARD_MAX_ITERATIONS = 10

function clampIterations(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_MAX_ITERATIONS
  if (value < 1) return 1
  if (value > HARD_MAX_ITERATIONS) return HARD_MAX_ITERATIONS
  return Math.floor(value)
}

const defaultBuildPrompt: NonNullable<IssueWorkflowPrompts['build']> = ({ issue, iteration, reviewFeedback }) => {
  const head = `# Issue\n## ${issue.title}\n\n${issue.body}`
  const meta = issue.priority ? `\nPriority: ${issue.priority}` : ''
  const labels = issue.labels.length ? `\nLabels: ${issue.labels.join(', ')}` : ''
  const lead =
    iteration === 1
      ? 'Implement the changes required to resolve the issue above.'
      : `This is iteration ${iteration}. The previous attempt failed verification. Review the feedback below and produce a corrected change set.\n\n## Reviewer feedback\n${reviewFeedback ?? '(no feedback recorded)'}`
  return `${lead}\n\n${head}${meta}${labels}\n\nWhen you are done, end your response with a short summary of which files you changed and why.`
}

const defaultReviewPrompt: NonNullable<IssueWorkflowPrompts['review']> = ({ issue, iteration, gates }) => {
  const failing = gates.filter((g) => g.status !== 'passed')
  const failingBlock = failing.length === 0
    ? '(all gates passed — no review needed; this prompt should not have been invoked)'
    : failing
        .map((g) => `### ${g.name} — ${g.status}\n${(g.summary ?? '(no summary)').trim()}`)
        .join('\n\n')
  return [
    `# Verification failed (iteration ${iteration})`,
    '',
    `Issue: ${issue.title}`,
    '',
    '## Failing gates',
    failingBlock,
    '',
    '## Your task',
    'Read the failing gate output above. Produce a concise fix plan (3-6 bullet points) that the next build iteration should follow. Do not make changes yourself — just write the plan.',
  ].join('\n')
}

interface IterationOutcome {
  buildText: string
  buildAgentRunId?: string
  gates: QualityGateResult[]
  passing: boolean
  reviewText?: string
  reviewAgentRunId?: string
}

/**
 * Determine whether all required gates have passed, given the verifier output.
 * Defaults to "every required gate must be present AND have status 'passed'".
 * If `requiredGates` is empty, every reported gate must be passing.
 */
function gatesSatisfied(gates: QualityGateResult[], required: string[]): boolean {
  if (required.length === 0) {
    return gates.length > 0 && gates.every((g) => g.status === 'passed')
  }
  return required.every((name) => gates.some((g) => g.name === name && g.status === 'passed'))
}

function gatesToFindings(gates: QualityGateResult[]): IssueWorkflowFinding[] {
  return gates
    .filter((g) => g.status !== 'passed')
    .map<IssueWorkflowFinding>((g) => ({
      severity: 'p1',
      message: `${g.name}: ${(g.summary ?? g.status).slice(0, 200)}`,
      resolved: false,
    }))
}

export async function runIssueWorkflowWithAgent(
  input: RunIssueWorkflowWithAgentInput,
  options?: AgentJobStoreOptions & RuntimeNamespaceContext,
): Promise<IssueWorkflowResult> {
  if (!input.agent || typeof input.agent.run !== 'function') {
    throw new Error('runIssueWorkflowWithAgent requires an Agent with a .run() method')
  }
  if (!input.verifier || typeof input.verifier.verify !== 'function') {
    throw new Error('runIssueWorkflowWithAgent requires a Verifier with a .verify() method')
  }
  if (!input.cwd) {
    throw new Error('runIssueWorkflowWithAgent requires `cwd`')
  }

  const requiredGates = input.requiredGates ?? []
  const passingScore = input.passingScore ?? 80
  const maxIterations = clampIterations(input.maxIterations)
  const buildPrompt = input.prompts?.build ?? defaultBuildPrompt
  const reviewPrompt = input.prompts?.review ?? defaultReviewPrompt

  const run = await createIssueWorkflowRun({
    issue: input.issue,
    cwd: input.cwd,
    requiredGates,
    passingScore,
    roles: ['builder', 'reviewer'],
  }, options)

  run.status = 'running'
  run.updatedAt = new Date().toISOString()
  await writeIssueWorkflowRun(run, options)

  const allGates: QualityGateResult[] = []
  let lastReviewSummary: string | undefined
  let lastIteration: IterationOutcome | undefined
  let iteration = 0

  try {
    for (iteration = 1; iteration <= maxIterations; iteration += 1) {
      const builderJob: IssueWorkflowJobRef = iteration === 1
        ? run.jobs[0]!
        : await appendIssueWorkflowJob(run, input.issue, 'fixer', iteration, options)

      // runAgentJob is fire-and-forget; the runner result is persisted to the
      // job store. We capture the AgentRunResult locally for diagnostics, then
      // wait for the job to terminate before reading the canonical record back.
      let buildAgentResult: AgentRunResult | undefined
      runAgentJob(builderJob.job_id, async () => {
        buildAgentResult = await input.agent.run(
          buildPrompt({ issue: input.issue, iteration, reviewFeedback: lastReviewSummary }),
          { cwd: input.cwd },
        )
        return {
          status: buildAgentResult.status === 'completed' ? 'completed' : 'errored',
          output: buildAgentResult.text,
          metadata: {
            agent_run_id: buildAgentResult.id,
            num_turns: buildAgentResult.num_turns,
          },
        }
      }, options)
      const builderJobRecord = await waitForIssueWorkflowJob(builderJob.job_id, options)
      const buildText = (builderJobRecord?.output ?? buildAgentResult?.text ?? '') as string

      const gates = await input.verifier.verify({ cwd: input.cwd, iteration })
      allGates.push(...gates)

      const passing = gatesSatisfied(gates, requiredGates)
      lastIteration = {
        buildText,
        buildAgentRunId: buildAgentResult?.id,
        gates,
        passing,
      }

      if (passing) break

      // Otherwise, run a review pass to capture feedback for the next iteration.
      const reviewerJob = await appendIssueWorkflowJob(run, input.issue, 'reviewer', iteration, options)
      let reviewAgentResult: AgentRunResult | undefined
      runAgentJob(reviewerJob.job_id, async () => {
        reviewAgentResult = await input.agent.run(
          reviewPrompt({ issue: input.issue, iteration, gates }),
          { cwd: input.cwd },
        )
        return {
          status: reviewAgentResult.status === 'completed' ? 'completed' : 'errored',
          output: reviewAgentResult.text,
          metadata: {
            agent_run_id: reviewAgentResult.id,
            num_turns: reviewAgentResult.num_turns,
          },
        }
      }, options)
      const reviewerJobRecord = await waitForIssueWorkflowJob(reviewerJob.job_id, options)
      lastReviewSummary = (reviewerJobRecord?.output ?? reviewAgentResult?.text ?? '') as string
      lastIteration.reviewText = lastReviewSummary
      lastIteration.reviewAgentRunId = reviewAgentResult?.id
    }

    const passing = lastIteration?.passing ?? false
    const reachedCap = iteration > maxIterations
    const status: IssueWorkflowStatus = passing
      ? 'completed'
      : reachedCap
        ? 'max_iterations'
        : 'failed_gate'

    const findings = passing ? [] : gatesToFindings(lastIteration?.gates ?? [])

    const proof = createIssueWorkflowProofOfWork({
      run,
      status,
      finalScore: passing ? passingScore : undefined,
      unresolvedFindings: findings,
      qualityGates: allGates,
      risks: findings.map((f) => `${f.severity}: ${f.message}`),
      nextActions: passing
        ? []
        : reachedCap
          ? [`Hit maxIterations=${maxIterations}. Inspect the verifier output and either raise the cap or hand back to a human.`]
          : ['Review the failing gates above and start a new run.'],
    })

    const updated: IssueWorkflowRunRecord = {
      ...run,
      status,
      updatedAt: new Date().toISOString(),
      finalScore: passing ? passingScore : undefined,
      proof_of_work: proof,
    }
    await writeIssueWorkflowRun(updated, options)

    return {
      run: updated,
      status,
      finalScore: passing ? passingScore : undefined,
      unresolvedFindings: findings,
      quality_gates: allGates,
      proof_of_work: proof,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const proof = createIssueWorkflowProofOfWork({
      run,
      status: 'error',
      unresolvedFindings: [],
      qualityGates: allGates,
      risks: [`error: ${message}`],
      nextActions: ['Inspect the workflow error, repair the failure cause, then retry.'],
    })
    const failed: IssueWorkflowRunRecord = {
      ...run,
      status: 'error',
      updatedAt: new Date().toISOString(),
      proof_of_work: proof,
      errors: [message],
    }
    await writeIssueWorkflowRun(failed, options)
    throw error
  }
}
