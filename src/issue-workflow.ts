import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'

import {
  createAgentJob,
  getAgentJob,
  runAgentJob,
  stopAgentJob,
  type AgentJobCompletion,
  type AgentJobStoreOptions,
} from './agent-jobs.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from './utils/runtime.js'
import type { QualityGateResult } from './types.js'

export type IssueWorkflowSourceType = 'inline' | 'local-file'

export interface IssueWorkflowSource {
  type: IssueWorkflowSourceType
  path?: string
}

export interface IssueWorkflowRecord {
  id: string
  title: string
  body: string
  labels: string[]
  priority?: string
  source: IssueWorkflowSource
}

export type IssueWorkflowStatus = 'queued' | 'running' | 'completed' | 'failed_gate' | 'failed_review' | 'blocked_by_policy' | 'max_iterations' | 'cancelled' | 'error'
export type IssueWorkflowRole = 'builder' | 'reviewer' | 'fixer' | 'verifier'

export interface IssueWorkflowJobRef {
  role: IssueWorkflowRole
  job_id: string
  iteration: number
}

export interface IssueWorkflowRunRecord {
  schema_version: string
  id: string
  issue: IssueWorkflowRecord
  status: IssueWorkflowStatus
  createdAt: string
  updatedAt: string
  correlation_id: string
  batch_id: string
  jobs: IssueWorkflowJobRef[]
  requiredGates: string[]
  passingScore: number
  finalScore?: number
  errors?: string[]
}

export interface LoadLocalIssuesOptions {
  cwd: string
  issuesDir?: string
}

export interface CreateIssueWorkflowRunInput {
  issue: IssueWorkflowRecord
  cwd: string
  requiredGates?: string[]
  passingScore?: number
  roles?: IssueWorkflowRole[]
}

export interface IssueWorkflowFinding {
  severity: 'p0' | 'p1' | 'p2' | 'p3'
  message: string
  resolved?: boolean
}

export type IssueWorkflowRoleEvaluation =
  | { score: number; findings?: IssueWorkflowFinding[] }
  | { gate: string; passed: boolean; output?: string }

export interface RunIssueWorkflowInput extends CreateIssueWorkflowRunInput {
  maxIterations?: number
  evaluateRole?: (context: {
    role: IssueWorkflowRole
    issue: IssueWorkflowRecord
    iteration: number
    run: IssueWorkflowRunRecord
  }) => Promise<IssueWorkflowRoleEvaluation> | IssueWorkflowRoleEvaluation
}

export interface IssueWorkflowResult {
  run: IssueWorkflowRunRecord
  status: IssueWorkflowStatus
  finalScore?: number
  unresolvedFindings: IssueWorkflowFinding[]
  quality_gates: QualityGateResult[]
  errors?: string[]
}

interface ParsedFrontmatter {
  metadata: Record<string, string>
  markdown: string
}

const ISSUE_WORKFLOW_RUN_SCHEMA_VERSION = '1.0.0'

function stableIssueId(input: string): string {
  return `issue_${createHash('sha1').update(input).digest('hex').slice(0, 16)}`
}

function getIssueRunsRoot(options?: AgentJobStoreOptions): string {
  if (options?.dir) return join(options.dir, 'issue-runs')
  const home = process.env.HOME || process.env.USERPROFILE || tmpdir()
  return join(home, '.clavue-agent-sdk', 'issue-runs')
}

function encodeNamespace(namespace: string): string {
  return Buffer.from(namespace || 'default', 'utf8').toString('base64url')
}

function assertSafeIssueRunId(id: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw new Error(`Invalid issue workflow run id: ${id}`)
  }
  return id
}

function getIssueRunsDir(options?: AgentJobStoreOptions): string {
  return join(getIssueRunsRoot(options), encodeNamespace(getRuntimeNamespace(options)))
}

function getIssueRunPath(id: string, options?: AgentJobStoreOptions): string {
  return join(getIssueRunsDir(options), `${assertSafeIssueRunId(id)}.json`)
}

function cloneIssueWorkflowRun(run: IssueWorkflowRunRecord): IssueWorkflowRunRecord {
  return JSON.parse(JSON.stringify(run)) as IssueWorkflowRunRecord
}

function splitFrontmatter(input: string): ParsedFrontmatter {
  const normalized = input.replace(/\r\n/g, '\n').trim()
  if (!normalized.startsWith('---\n')) return { metadata: {}, markdown: normalized }

  const end = normalized.indexOf('\n---', 4)
  if (end === -1) return { metadata: {}, markdown: normalized }

  const metadata: Record<string, string> = {}
  const frontmatter = normalized.slice(4, end).trim()
  for (const line of frontmatter.split('\n')) {
    const separator = line.indexOf(':')
    if (separator <= 0) continue
    metadata[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }

  return {
    metadata,
    markdown: normalized.slice(end + '\n---'.length).trim(),
  }
}

function splitTitleAndBody(markdown: string): { title: string; body: string } {
  const lines = markdown.replace(/\r\n/g, '\n').trim().split('\n')
  const firstContentLineIndex = lines.findIndex((line) => line.trim().length > 0)
  if (firstContentLineIndex === -1) {
    return { title: 'Untitled issue', body: '' }
  }

  const title = lines[firstContentLineIndex]!.replace(/^#\s+/, '').trim() || 'Untitled issue'
  const body = lines.slice(firstContentLineIndex + 1).join('\n').trim()
  return { title, body }
}

function parseLabels(value: string | undefined): string[] {
  if (!value) return []
  return value
    .split(',')
    .map((label) => label.trim())
    .filter(Boolean)
    .sort()
}

export function normalizeIssueInput(input: string, source: IssueWorkflowSource = { type: 'inline' }): IssueWorkflowRecord {
  const { metadata, markdown } = splitFrontmatter(input)
  const { title, body } = splitTitleAndBody(markdown)
  const identity = [source.type, source.path || '', metadata.id || '', title, body].join('\n')

  return {
    id: metadata.id || stableIssueId(identity),
    title,
    body,
    labels: parseLabels(metadata.labels),
    priority: metadata.priority || undefined,
    source,
  }
}

export async function loadLocalIssues(options: LoadLocalIssuesOptions): Promise<IssueWorkflowRecord[]> {
  const issuesDir = options.issuesDir || join(options.cwd, '.clavue', 'issues')

  try {
    const entries = await readdir(issuesDir)
    const markdownFiles = entries
      .filter((entry) => entry.endsWith('.md'))
      .sort((a, b) => a.localeCompare(b))

    return Promise.all(markdownFiles.map(async (entry) => {
      const path = join(issuesDir, entry)
      const content = await readFile(path, 'utf-8')
      return normalizeIssueInput(content, { type: 'local-file', path })
    }))
  } catch (error: any) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function writeIssueWorkflowRun(
  run: IssueWorkflowRunRecord,
  options?: AgentJobStoreOptions,
): Promise<IssueWorkflowRunRecord> {
  await mkdir(getIssueRunsDir(options), { recursive: true })
  const path = getIssueRunPath(run.id, options)
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmpPath, JSON.stringify(run, null, 2), 'utf-8')
  await rename(tmpPath, path)
  return cloneIssueWorkflowRun(run)
}

function buildIssueWorkflowPrompt(issue: IssueWorkflowRecord, role: IssueWorkflowRole, iteration = 1): string {
  return [
    `Issue workflow role: ${role}`,
    `Iteration: ${iteration}`,
    `Issue: ${issue.title}`,
    '',
    issue.body,
  ].join('\n').trim()
}

export async function createIssueWorkflowRun(
  input: CreateIssueWorkflowRunInput,
  options?: AgentJobStoreOptions & RuntimeNamespaceContext,
): Promise<IssueWorkflowRunRecord> {
  const now = new Date().toISOString()
  const id = `issue_run_${Date.now()}_${randomUUID()}`
  const batchId = `issue_workflow_batch_${Date.now()}_${randomUUID()}`
  const roles = input.roles ?? ['builder']
  const jobs = []

  for (const role of roles) {
    const description = `Issue workflow ${role}: ${input.issue.title}`
    const job = await createAgentJob({
      kind: 'subagent',
      prompt: buildIssueWorkflowPrompt(input.issue, role),
      description,
      batch_id: batchId,
      correlation_id: id,
      replay: {
        prompt: buildIssueWorkflowPrompt(input.issue, role),
        description,
      },
    }, options)
    jobs.push({ role, job_id: job.id, iteration: 1 })
  }

  return writeIssueWorkflowRun({
    schema_version: ISSUE_WORKFLOW_RUN_SCHEMA_VERSION,
    id,
    issue: input.issue,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
    correlation_id: id,
    batch_id: batchId,
    jobs,
    requiredGates: input.requiredGates ?? [],
    passingScore: input.passingScore ?? 80,
  }, options)
}

export async function loadIssueWorkflowRun(
  id: string,
  options?: AgentJobStoreOptions & RuntimeNamespaceContext,
): Promise<IssueWorkflowRunRecord | null> {
  try {
    const content = await readFile(getIssueRunPath(id, options), 'utf-8')
    return JSON.parse(content) as IssueWorkflowRunRecord
  } catch {
    return null
  }
}

export async function listIssueWorkflowRuns(
  options?: AgentJobStoreOptions & RuntimeNamespaceContext,
): Promise<IssueWorkflowRunRecord[]> {
  try {
    const entries = await readdir(getIssueRunsDir(options))
    const runs = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => loadIssueWorkflowRun(entry.slice(0, -'.json'.length), options)),
    )

    return runs
      .filter((run): run is IssueWorkflowRunRecord => run !== null)
      .map(cloneIssueWorkflowRun)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

export async function stopIssueWorkflowRun(
  id: string,
  reason?: string,
  options?: AgentJobStoreOptions & RuntimeNamespaceContext,
): Promise<IssueWorkflowRunRecord | null> {
  const run = await loadIssueWorkflowRun(id, options)
  if (!run) return null

  await Promise.all(run.jobs.map((job) => stopAgentJob(job.job_id, reason, options)))
  const updatedRun: IssueWorkflowRunRecord = {
    ...run,
    status: 'cancelled',
    updatedAt: new Date().toISOString(),
    errors: reason ? [`Cancelled: ${reason}`] : ['Cancelled'],
  }

  return writeIssueWorkflowRun(updatedRun, options)
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForIssueWorkflowJob(
  jobId: string,
  options?: AgentJobStoreOptions,
): Promise<Awaited<ReturnType<typeof getAgentJob>>> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const job = await getAgentJob(jobId, options)
    if (!job || job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled' || job.status === 'stale') {
      return job
    }
    await wait(10)
  }

  return getAgentJob(jobId, options)
}

function createIssueWorkflowJobCompletion(
  role: IssueWorkflowRole,
  evaluation?: IssueWorkflowRoleEvaluation,
): AgentJobCompletion {
  if (evaluation && 'gate' in evaluation) {
    return {
      output: `${role} completed`,
      quality_gates: [{
        name: evaluation.gate,
        status: evaluation.passed ? 'passed' : 'failed',
        summary: evaluation.output,
      }],
    }
  }

  if (evaluation && 'score' in evaluation) {
    return {
      output: JSON.stringify({ score: evaluation.score, findings: evaluation.findings ?? [] }),
    }
  }

  return { output: `${role} completed` }
}

function hasBlockingFindings(findings: IssueWorkflowFinding[]): boolean {
  return findings.some((finding) => !finding.resolved && (finding.severity === 'p0' || finding.severity === 'p1'))
}

function reviewFailed(score: number | undefined, findings: IssueWorkflowFinding[], passingScore: number): boolean {
  return hasBlockingFindings(findings) || (score !== undefined && score < passingScore)
}

async function appendIssueWorkflowJob(
  run: IssueWorkflowRunRecord,
  issue: IssueWorkflowRecord,
  role: IssueWorkflowRole,
  iteration: number,
  options?: AgentJobStoreOptions,
): Promise<IssueWorkflowJobRef> {
  const description = `Issue workflow ${role}: ${issue.title}`
  const job = await createAgentJob({
    kind: 'subagent',
    prompt: buildIssueWorkflowPrompt(issue, role, iteration),
    description,
    batch_id: run.batch_id,
    correlation_id: run.id,
    replay: {
      prompt: buildIssueWorkflowPrompt(issue, role, iteration),
      description,
    },
  }, options)
  const jobRef = { role, job_id: job.id, iteration }
  run.jobs.push(jobRef)
  return jobRef
}

export async function runIssueWorkflow(
  input: RunIssueWorkflowInput,
  options?: AgentJobStoreOptions & RuntimeNamespaceContext,
): Promise<IssueWorkflowResult> {
  const run = await createIssueWorkflowRun({
    ...input,
    roles: ['builder', 'reviewer'],
  }, options)
  const qualityGates: QualityGateResult[] = []
  const maxIterations = input.maxIterations ?? 6
  let unresolvedFindings: IssueWorkflowFinding[] = []
  let finalScore: number | undefined

  const executeJob = async (workflowJob: IssueWorkflowJobRef): Promise<IssueWorkflowRoleEvaluation | undefined> => {
    const evaluation = await input.evaluateRole?.({
      role: workflowJob.role,
      issue: input.issue,
      iteration: workflowJob.iteration,
      run,
    })

    runAgentJob(workflowJob.job_id, async () => createIssueWorkflowJobCompletion(workflowJob.role, evaluation), options)
    const job = await waitForIssueWorkflowJob(workflowJob.job_id, options)
    if (job?.quality_gates) qualityGates.push(...job.quality_gates)
    return evaluation
  }

  await executeJob(run.jobs[0]!)

  let reviewIteration = 1
  let reviewEvaluation = await executeJob(run.jobs[1]!)
  if (reviewEvaluation && 'score' in reviewEvaluation) {
    finalScore = reviewEvaluation.score
    unresolvedFindings = (reviewEvaluation.findings ?? []).filter((finding) => !finding.resolved)
  }

  while (reviewFailed(finalScore, unresolvedFindings, run.passingScore) && reviewIteration < maxIterations) {
    await executeJob(await appendIssueWorkflowJob(run, input.issue, 'fixer', reviewIteration, options))
    reviewIteration += 1
    reviewEvaluation = await executeJob(await appendIssueWorkflowJob(run, input.issue, 'reviewer', reviewIteration, options))
    if (reviewEvaluation && 'score' in reviewEvaluation) {
      finalScore = reviewEvaluation.score
      unresolvedFindings = (reviewEvaluation.findings ?? []).filter((finding) => !finding.resolved)
    }
  }

  if (!reviewFailed(finalScore, unresolvedFindings, run.passingScore)) {
    await executeJob(await appendIssueWorkflowJob(run, input.issue, 'verifier', 1, options))
  }

  const requiredGatesPassed = run.requiredGates.every((gate) => qualityGates.some((result) => result.name === gate && result.status === 'passed'))
  const status: IssueWorkflowStatus = !requiredGatesPassed
    ? 'failed_gate'
    : reviewFailed(finalScore, unresolvedFindings, run.passingScore)
      ? reviewIteration >= maxIterations ? 'max_iterations' : 'failed_review'
      : 'completed'
  const updatedRun: IssueWorkflowRunRecord = {
    ...run,
    status,
    updatedAt: new Date().toISOString(),
    finalScore,
  }

  await writeIssueWorkflowRun(updatedRun, options)

  return {
    run: updatedRun,
    status,
    finalScore,
    unresolvedFindings,
    quality_gates: qualityGates,
  }
}
