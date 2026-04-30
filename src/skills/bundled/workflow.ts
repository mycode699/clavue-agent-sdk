/**
 * Bundled Skills: lifecycle workflow
 *
 * Structured lifecycle workflow support for define, plan, build, verify,
 * review, ship, and repair phases.
 */

import { registerSkill } from '../registry.js'
import type { SkillContentBlock } from '../types.js'

const DEFINE_PROMPT = `Define the work before implementation. Produce a crisp problem statement and evidence-backed scope.

Process:
1. **Clarify outcome**: Identify the user-visible goal, success criteria, and non-goals.
2. **Inspect context**: Read relevant files, docs, issues, examples, or runtime output before proposing changes.
3. **Map constraints**: Capture API compatibility, security, performance, testing, release, and write-scope constraints.
4. **Identify unknowns**: Ask only the questions that block safe progress; otherwise state assumptions explicitly.
5. **Define acceptance**: Convert the goal into verifiable acceptance criteria.

Evidence expectations:
- Cite concrete files, commands, errors, logs, docs, or user statements that justify the definition.
- Separate observed facts from assumptions.
- Do not start implementation until the target behavior and constraints are clear.`

const PLAN_PROMPT = `Plan the work with a practical execution path.

Process:
1. **Review definition**: Restate the goal, constraints, assumptions, and acceptance criteria.
2. **Break down work**: Split the task into small ordered steps with clear dependencies.
3. **Choose approach**: Prefer the minimal design that satisfies the acceptance criteria and fits existing patterns.
4. **Risk-check**: Identify edge cases, compatibility risks, data risks, and rollback considerations.
5. **Verification plan**: Specify which tests, builds, manual checks, or inspections will prove the work.

Evidence expectations:
- Reference inspected code paths, existing patterns, commands, or docs that support the plan.
- Explain why omitted or deferred work is safe to leave out.
- Keep the plan actionable enough that another engineer could execute it.`

const BUILD_PROMPT = `Build the planned change with tight scope control.

Process:
1. **Confirm scope**: Re-read the requested write scope and avoid unrelated edits.
2. **Follow patterns**: Match local naming, imports, formatting, error handling, and architecture.
3. **Implement incrementally**: Make the smallest coherent changes that satisfy the plan.
4. **Preserve behavior**: Avoid broad refactors, generated output edits, or public API changes unless required.
5. **Self-review while building**: Check for type issues, edge cases, unsafe operations, and missed constraints.

Evidence expectations:
- Base edits on observed code, not assumptions about the project.
- Note any user or concurrent changes that affect the implementation.
- Leave the code in a state that can be verified by the stated checks.`

const VERIFY_PROMPT = `Verify the work against acceptance criteria.

Process:
1. **Select checks**: Run the smallest relevant tests, type checks, builds, linters, or manual commands.
2. **Exercise behavior**: Cover the intended path plus meaningful edge cases or failure paths.
3. **Inspect results**: Read failures carefully and distinguish product failures from test/environment issues.
4. **Close gaps**: Fix issues within scope, then re-run the relevant checks.
5. **Record status**: Summarize exactly what passed, failed, or could not be run.

Evidence expectations:
- Include command names and decisive output details, not just "tests pass".
- Map verification results back to acceptance criteria.
- If verification is incomplete, state the residual risk and why.`

const REVIEW_PROMPT = `Review the lifecycle work before it ships. Focus on correctness, risk, and missing evidence.

Process:
1. **Inspect diff and context**: Review changed files plus surrounding code needed to understand behavior.
2. **Check requirements**: Compare the implementation against goal, constraints, and acceptance criteria.
3. **Find defects first**: Prioritize correctness, security, data loss, compatibility, performance, and test gaps.
4. **Validate evidence**: Confirm tests or manual checks actually prove the behavior.
5. **Report clearly**: List findings by severity with file and line references, then questions or residual risks.

Evidence expectations:
- Every finding must cite a concrete file, line, behavior, command, or missing test.
- Do not present style preferences as defects unless they affect maintainability or consistency.
- If there are no findings, say so and identify any unverified risk.`

const SHIP_PROMPT = `Prepare the completed work for handoff or release.

Process:
1. **Check readiness**: Confirm implementation, review, and verification status.
2. **Summarize impact**: Explain user-visible behavior, API/package changes, migration notes, and operational risks.
3. **Confirm artifacts**: Ensure required docs, changelog, generated files, versioning, or release notes are handled when applicable.
4. **Package safely**: Prepare commits, tags, release notes, or deployment steps only when requested and authorized.
5. **Handoff cleanly**: Provide concise status, verification evidence, known limitations, and next steps.

Evidence expectations:
- Cite tests, builds, review results, diffs, or release artifacts that support shipping.
- State explicitly if no release action was taken.
- Do not push, publish, deploy, or tag unless the user asked for that action.`

const REPAIR_PROMPT = `Repair a failed or regressed workflow outcome with root-cause discipline.

Process:
1. **Stabilize facts**: Capture the failure, reproduction path, affected users or systems, and last known good state.
2. **Localize cause**: Compare intended behavior, recent changes, logs, tests, and runtime evidence.
3. **Choose remedy**: Prefer the smallest safe fix, rollback, configuration change, or mitigation.
4. **Implement safely**: Avoid compounding the incident with unrelated cleanup or speculative refactors.
5. **Verify recovery**: Re-run the failing path and add regression coverage when practical.
6. **Document prevention**: Record root cause, evidence, fix, verification, and follow-up work.

Evidence expectations:
- Cite the exact failure output, code path, logs, metrics, or reproduction steps used.
- Distinguish confirmed root cause from plausible contributing factors.
- Treat incomplete recovery evidence as an explicit residual risk.`

function textPrompt(prompt: string, args: string, label = 'Additional context'): SkillContentBlock[] {
  let text = prompt
  if (args.trim()) {
    text += `\n\n## ${label}\n${args}`
  }
  return [{ type: 'text', text }]
}

export function registerDefineSkill(): void {
  registerSkill({
    version: '1.0.0',
    name: 'define',
    description: 'Define lifecycle work with clear goals, constraints, acceptance criteria, and evidence.',
    aliases: ['workflow-define', 'scope'],
    whenToUse: 'Use before planning or building when the goal, constraints, or acceptance criteria need to be made explicit.',
    argumentHint: 'goal, issue, or feature to define',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    preconditions: [
      { name: 'goal-or-issue-known', description: 'A target goal, issue, or feature request is available.' },
    ],
    artifactsProduced: [
      { name: 'problem-statement', type: 'text', description: 'Clear statement of the target behavior or problem.' },
      { name: 'acceptance-criteria', type: 'text', description: 'Verifiable completion criteria.' },
    ],
    qualityGates: [
      { name: 'scope-defined', description: 'Goal, non-goals, assumptions, and acceptance criteria are explicit.', evidence: 'definition summary with cited context' },
    ],
    permissions: {
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      safetyNotes: 'Use Bash for read-only inspection commands unless explicitly authorized otherwise.',
    },
    userInvocable: true,
    async getPrompt(args): Promise<SkillContentBlock[]> {
      return textPrompt(DEFINE_PROMPT, args, 'Work To Define')
    },
  })
}

export function registerPlanSkill(): void {
  registerSkill({
    version: '1.0.0',
    name: 'plan',
    description: 'Plan lifecycle work with ordered steps, risks, and verification strategy.',
    aliases: ['workflow-plan'],
    whenToUse: 'Use after the work is defined and before implementation, especially for multi-step or risky changes.',
    argumentHint: 'defined goal or constraints to plan around',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    preconditions: [
      { name: 'scope-defined', description: 'The goal and acceptance criteria are clear.' },
    ],
    artifactsProduced: [
      { name: 'implementation-plan', type: 'text', description: 'Ordered steps, dependencies, risks, and verification strategy.' },
    ],
    qualityGates: [
      { name: 'plan-reviewable', description: 'The plan is specific, scoped, and includes verification evidence requirements.', evidence: 'ordered plan with risk and verification sections' },
    ],
    permissions: {
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      safetyNotes: 'Planning should inspect context, not mutate project state.',
    },
    userInvocable: true,
    async getPrompt(args): Promise<SkillContentBlock[]> {
      return textPrompt(PLAN_PROMPT, args, 'Planning Context')
    },
  })
}

export function registerBuildSkill(): void {
  registerSkill({
    version: '1.0.0',
    name: 'build',
    description: 'Implement lifecycle work while preserving scope, local patterns, and safety constraints.',
    aliases: ['workflow-build', 'implement'],
    whenToUse: 'Use when executing an approved plan or making a scoped implementation change.',
    argumentHint: 'implementation task or plan',
    allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
    preconditions: [
      { name: 'plan-or-scope-known', description: 'A plan or sufficiently bounded implementation scope is available.' },
    ],
    artifactsProduced: [
      { name: 'code-changes', type: 'file', description: 'Focused source, test, or documentation edits.' },
    ],
    qualityGates: [
      { name: 'scope-preserved', description: 'Implementation stays inside the requested scope.', evidence: 'diff or changed-file summary' },
    ],
    permissions: {
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
      requiresApproval: true,
      safetyNotes: 'May mutate local files and run commands; use the narrowest verification commands possible.',
    },
    userInvocable: true,
    async getPrompt(args): Promise<SkillContentBlock[]> {
      return textPrompt(BUILD_PROMPT, args, 'Build Task')
    },
  })
}

export function registerVerifySkill(): void {
  registerSkill({
    version: '1.0.0',
    name: 'verify',
    description: 'Verify lifecycle work with targeted checks and explicit evidence.',
    aliases: ['workflow-verify', 'check'],
    whenToUse: 'Use after implementation, repair, or review feedback to prove behavior against acceptance criteria.',
    argumentHint: 'behavior, acceptance criteria, or checks to verify',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    preconditions: [
      { name: 'acceptance-criteria-known', description: 'Verification target or acceptance criteria are available.' },
    ],
    artifactsProduced: [
      { name: 'verification-output', type: 'command-output', description: 'Command output, manual check notes, or inspection evidence.' },
    ],
    qualityGates: [
      { name: 'verification-passed', description: 'Relevant checks pass or failures are explained with residual risk.', evidence: 'test/build/manual check output' },
    ],
    permissions: {
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      safetyNotes: 'Prefer deterministic local checks; do not mask failed verification.',
    },
    userInvocable: true,
    async getPrompt(args): Promise<SkillContentBlock[]> {
      return textPrompt(VERIFY_PROMPT, args, 'Verification Target')
    },
  })
}

export function registerWorkflowReviewSkill(): void {
  registerSkill({
    version: '1.0.0',
    name: 'workflow-review',
    description: 'Review lifecycle work for defects, requirement fit, missing evidence, and residual risk.',
    aliases: ['lifecycle-review'],
    whenToUse: 'Use before shipping lifecycle work or after implementation when a risk-focused review is needed.',
    argumentHint: 'diff, feature, or focus area to review',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    preconditions: [
      { name: 'review-target-known', description: 'A diff, feature, or artifact is available for review.' },
    ],
    artifactsProduced: [
      { name: 'review-findings', type: 'text', description: 'Defects, questions, or no-finding statement with residual risks.' },
    ],
    qualityGates: [
      { name: 'review-complete', description: 'Correctness, risk, evidence, and missing-test checks are complete.', evidence: 'file/line findings or explicit no-findings statement' },
    ],
    permissions: {
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      safetyNotes: 'Review is read-oriented and should not modify files.',
    },
    userInvocable: true,
    async getPrompt(args): Promise<SkillContentBlock[]> {
      return textPrompt(REVIEW_PROMPT, args, 'Review Focus')
    },
  })
}

export function registerShipSkill(): void {
  registerSkill({
    version: '1.0.0',
    name: 'ship',
    description: 'Prepare lifecycle work for handoff or release with evidence and explicit shipping boundaries.',
    aliases: ['workflow-ship', 'handoff'],
    whenToUse: 'Use when work is ready for final summary, commit preparation, release handoff, or deployment planning.',
    argumentHint: 'completed work or release target',
    allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
    preconditions: [
      { name: 'work-verified', description: 'Implementation and verification status are known.' },
    ],
    artifactsProduced: [
      { name: 'handoff-summary', type: 'text', description: 'Concise release or handoff summary with verification evidence.' },
    ],
    qualityGates: [
      { name: 'ship-readiness', description: 'Impact, verification, risks, and release boundaries are explicit.', evidence: 'handoff summary with checks and limitations' },
    ],
    permissions: {
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash'],
      requiresApproval: true,
      safetyNotes: 'Do not push, publish, deploy, tag, or release unless explicitly requested.',
    },
    userInvocable: true,
    async getPrompt(args): Promise<SkillContentBlock[]> {
      return textPrompt(SHIP_PROMPT, args, 'Shipping Context')
    },
  })
}

export function registerRepairSkill(): void {
  registerSkill({
    version: '1.0.0',
    name: 'repair',
    description: 'Repair failed lifecycle outcomes with root-cause analysis, minimal fixes, and recovery evidence.',
    aliases: ['workflow-repair', 'recover'],
    whenToUse: 'Use when verification fails, a regression is found, or shipped behavior needs targeted recovery.',
    argumentHint: 'failure, regression, or incident to repair',
    allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
    preconditions: [
      { name: 'failure-evidence-known', description: 'A failure, regression, or incident signal is available.' },
    ],
    artifactsProduced: [
      { name: 'repair-summary', type: 'text', description: 'Root cause, fix or mitigation, and follow-up work.' },
      { name: 'recovery-evidence', type: 'evidence', description: 'Verification that the failed path recovered.' },
    ],
    qualityGates: [
      { name: 'failure-reproduced-or-explained', description: 'Failure is reproduced or non-reproducibility is explained.', evidence: 'error output, logs, or reproduction notes' },
      { name: 'repair-verified', description: 'Recovery is verified against the failing path.', evidence: 'rerun output or manual verification evidence' },
    ],
    permissions: {
      allowedTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'],
      requiresApproval: true,
      safetyNotes: 'Keep repair minimal and verify the originally failing path.',
    },
    userInvocable: true,
    async getPrompt(args): Promise<SkillContentBlock[]> {
      return textPrompt(REPAIR_PROMPT, args, 'Repair Target')
    },
  })
}

export function registerWorkflowSkills(): void {
  registerDefineSkill()
  registerPlanSkill()
  registerBuildSkill()
  registerVerifySkill()
  registerWorkflowReviewSkill()
  registerShipSkill()
  registerRepairSkill()
}
