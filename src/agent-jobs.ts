import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import {
  getRuntimeNamespace,
  type RuntimeNamespaceContext,
} from './utils/runtime.js'
import { AGENT_JOB_RECORD_SCHEMA_VERSION } from './types.js'
import type { AgentRunTrace, Evidence, QualityGateResult } from './types.js'

export type AgentJobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'stale'
export type AgentJobKind = 'subagent'

export interface AgentJobReplayInput {
  prompt: string
  description?: string
  subagent_type?: string
  model?: string
  allowed_tools?: string[]
  append_system_prompt?: string
}

export interface AgentJobRecord {
  schema_version?: string
  id: string
  kind: AgentJobKind
  status: AgentJobStatus
  runtimeNamespace: string
  prompt: string
  description?: string
  subagent_type?: string
  model?: string
  batch_id?: string
  correlation_id?: string
  createdAt: string
  updatedAt: string
  startedAt?: string
  heartbeatAt?: string
  completedAt?: string
  output?: string
  error?: string
  toolCalls?: string[]
  trace?: AgentRunTrace
  evidence?: Evidence[]
  quality_gates?: QualityGateResult[]
  runnerId?: string
  allowedTools?: string[]
  replay?: AgentJobReplayInput
}

export interface AgentJobStoreOptions extends RuntimeNamespaceContext {
  dir?: string
  batch_id?: string
  correlation_id?: string
  /** Mark queued/running jobs stale after this many milliseconds without a heartbeat. Negative disables stale checks. */
  staleAfterMs?: number
  /** Internal heartbeat write interval while a job is active in this process. */
  heartbeatIntervalMs?: number
}

export interface CreateAgentJobInput {
  kind: AgentJobKind
  prompt: string
  description?: string
  subagent_type?: string
  model?: string
  batch_id?: string
  correlation_id?: string
  allowedTools?: string[]
  replay?: AgentJobReplayInput
}

export interface CreateAgentJobBatchTask {
  prompt: string
  description?: string
  subagent_type?: string
  model?: string
  allowedTools?: string[]
  replay?: AgentJobReplayInput
}

export interface CreateAgentJobBatchInput {
  tasks: CreateAgentJobBatchTask[]
  batch_id?: string
  correlation_id?: string
}

export interface AgentJobCompletion {
  output?: string
  toolCalls?: string[]
  trace?: AgentRunTrace
  evidence?: Evidence[]
  quality_gates?: QualityGateResult[]
}

export interface AgentJobStatusSummary {
  queued: number
  running: number
  completed: number
  failed: number
  cancelled: number
  stale: number
}

export interface AgentJobSummaryError {
  id: string
  status: AgentJobStatus
  error: string
}

export interface AgentJobBatchSummary {
  batch_id: string
  correlation_id?: string
  total: number
  by_status: AgentJobStatusSummary
  job_ids: string[]
}

export interface AgentJobSummary {
  total: number
  by_status: AgentJobStatusSummary
  stale_count: number
  replayable_count: number
  failed_count: number
  cancelled_count: number
  latest_heartbeat_at?: string
  latest_updated_at?: string
  evidence_count: number
  quality_gate_count: number
  batch_count: number
  batches: AgentJobBatchSummary[]
  error_summaries: AgentJobSummaryError[]
  stale_jobs: Array<Pick<AgentJobRecord, 'id' | 'kind' | 'status' | 'updatedAt' | 'heartbeatAt' | 'runnerId' | 'error'>>
}

export interface AgentJobBatchResult {
  batch_id: string
  correlation_id?: string
  jobs: AgentJobRecord[]
  summary: AgentJobSummary
}

export type AgentJobRunner = (signal: AbortSignal) => Promise<AgentJobCompletion>

interface ActiveAgentJob {
  abortController: AbortController
  promise: Promise<void>
}

const activeJobs = new Map<string, ActiveAgentJob>()
const jobWriteLocks = new Map<string, Promise<void>>()
const processRunnerId = `${process.pid}:${randomUUID()}`
const defaultJobHeartbeatIntervalMs = 5_000
const defaultJobStaleAfterMs = 60_000

function getHeartbeatIntervalMs(options?: AgentJobStoreOptions): number {
  const value = options?.heartbeatIntervalMs
  return Number.isFinite(value) && value! > 0 ? value! : defaultJobHeartbeatIntervalMs
}

function getStaleAfterMs(options?: AgentJobStoreOptions): number {
  const value = options?.staleAfterMs
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultJobStaleAfterMs
}

function getJobsRoot(options?: AgentJobStoreOptions): string {
  if (options?.dir) return options.dir
  if (process.env.CLAVUE_AGENT_JOBS_DIR) return process.env.CLAVUE_AGENT_JOBS_DIR
  const home = process.env.HOME || process.env.USERPROFILE || tmpdir()
  return join(home, '.clavue-agent-sdk', 'agent-jobs')
}

function encodeNamespace(namespace: string): string {
  return Buffer.from(namespace || 'default', 'utf8').toString('base64url')
}

function assertSafeJobId(id: string): string {
  if (!/^[A-Za-z0-9_.:-]+$/.test(id)) {
    throw new Error(`Invalid agent job id: ${id}`)
  }
  return id
}

function getNamespaceDir(options?: AgentJobStoreOptions): string {
  return join(getJobsRoot(options), encodeNamespace(getRuntimeNamespace(options)))
}

function getJobPath(id: string, options?: AgentJobStoreOptions): string {
  return join(getNamespaceDir(options), `${assertSafeJobId(id)}.json`)
}

function getActiveKeyPrefix(options?: AgentJobStoreOptions): string {
  return `${getNamespaceDir(options)}:`
}

function getActiveKey(id: string, options?: AgentJobStoreOptions): string {
  return `${getActiveKeyPrefix(options)}${assertSafeJobId(id)}`
}

function cloneJob(job: AgentJobRecord): AgentJobRecord {
  return JSON.parse(JSON.stringify(job)) as AgentJobRecord
}

async function withAgentJobWriteLock<T>(
  id: string,
  options: AgentJobStoreOptions | undefined,
  write: () => Promise<T>,
): Promise<T> {
  const key = getActiveKey(id, options)
  const previous = jobWriteLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const next = new Promise<void>((resolve) => {
    release = resolve
  })
  const pending = previous.catch(() => undefined).then(() => next)
  jobWriteLocks.set(key, pending)

  await previous.catch(() => undefined)
  try {
    return await write()
  } finally {
    release()
    if (jobWriteLocks.get(key) === pending) {
      pending.finally(() => {
        if (jobWriteLocks.get(key) === pending) jobWriteLocks.delete(key)
      })
    }
  }
}

async function writeAgentJobFile(job: AgentJobRecord, options?: AgentJobStoreOptions): Promise<AgentJobRecord> {
  await mkdir(getNamespaceDir(options), { recursive: true })
  const path = getJobPath(job.id, options)
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmpPath, JSON.stringify(job, null, 2), 'utf-8')
  await rename(tmpPath, path)
  return cloneJob(job)
}

async function saveAgentJob(job: AgentJobRecord, options?: AgentJobStoreOptions): Promise<AgentJobRecord> {
  return withAgentJobWriteLock(job.id, options, () => writeAgentJobFile(job, options))
}

async function loadRawAgentJob(id: string, options?: AgentJobStoreOptions): Promise<AgentJobRecord | null> {
  try {
    const content = await readFile(getJobPath(id, options), 'utf-8')
    return JSON.parse(content) as AgentJobRecord
  } catch {
    return null
  }
}

async function updateAgentJob(
  id: string,
  patch: Partial<AgentJobRecord>,
  options?: AgentJobStoreOptions,
): Promise<AgentJobRecord | null> {
  return withAgentJobWriteLock(id, options, async () => {
    const existing = await loadRawAgentJob(id, options)
    if (!existing) return null

    return writeAgentJobFile({
      ...existing,
      ...patch,
      id: existing.id,
      runtimeNamespace: existing.runtimeNamespace,
      updatedAt: new Date().toISOString(),
    }, options)
  })
}

function isTerminalJobStatus(status: AgentJobStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'stale'
}

function shouldMarkJobStale(job: AgentJobRecord, options?: AgentJobStoreOptions): boolean {
  if (job.status !== 'queued' && job.status !== 'running') return false
  if (activeJobs.has(getActiveKey(job.id, options))) return false

  const staleAfterMs = getStaleAfterMs(options)
  if (staleAfterMs < 0) return false

  const timestamp = Date.parse(job.heartbeatAt || job.startedAt || job.updatedAt || job.createdAt)
  if (!Number.isFinite(timestamp)) return true
  return Date.now() - timestamp >= staleAfterMs
}

async function refreshAgentJobState(
  job: AgentJobRecord,
  options?: AgentJobStoreOptions,
): Promise<AgentJobRecord> {
  if (!shouldMarkJobStale(job, options)) return cloneJob(job)

  const now = new Date().toISOString()
  return saveAgentJob({
    ...job,
    status: 'stale',
    updatedAt: now,
    completedAt: job.completedAt || now,
    error: job.error || 'Agent job heartbeat expired before completion.',
  }, options)
}

async function loadAgentJob(id: string, options?: AgentJobStoreOptions): Promise<AgentJobRecord | null> {
  const job = await loadRawAgentJob(id, options)
  return job ? refreshAgentJobState(job, options) : null
}

export async function createAgentJob(
  input: CreateAgentJobInput,
  options?: AgentJobStoreOptions,
): Promise<AgentJobRecord> {
  const now = new Date().toISOString()
  const job: AgentJobRecord = {
    schema_version: AGENT_JOB_RECORD_SCHEMA_VERSION,
    id: `agent_job_${Date.now()}_${randomUUID()}`,
    kind: input.kind,
    status: 'queued',
    runtimeNamespace: getRuntimeNamespace(options),
    prompt: input.prompt,
    description: input.description,
    subagent_type: input.subagent_type,
    model: input.model,
    batch_id: input.batch_id,
    correlation_id: input.correlation_id,
    allowedTools: input.allowedTools,
    replay: input.replay,
    createdAt: now,
    updatedAt: now,
  }

  return saveAgentJob(job, options)
}

export async function createAgentJobBatch(
  input: CreateAgentJobBatchInput,
  options?: AgentJobStoreOptions,
): Promise<AgentJobBatchResult> {
  const batchId = input.batch_id || `agent_job_batch_${Date.now()}_${randomUUID()}`
  const jobs = await Promise.all(input.tasks.map((task) => createAgentJob({
    kind: 'subagent',
    prompt: task.prompt,
    description: task.description,
    subagent_type: task.subagent_type,
    model: task.model,
    batch_id: batchId,
    correlation_id: input.correlation_id,
    allowedTools: task.allowedTools,
    replay: task.replay,
  }, options)))
  const summary = await summarizeAgentJobs({
    ...options,
    batch_id: batchId,
  })

  return {
    batch_id: batchId,
    correlation_id: input.correlation_id,
    jobs,
    summary,
  }
}

export async function replayAgentJob(
  id: string,
  runner: AgentJobRunner,
  options?: AgentJobStoreOptions,
): Promise<AgentJobRecord | null> {
  const existing = await loadAgentJob(id, options)
  if (!existing) return null
  if (existing.status !== 'stale' && existing.status !== 'failed' && existing.status !== 'cancelled') {
    return cloneJob(existing)
  }

  const now = new Date().toISOString()
  await updateAgentJob(id, {
    status: 'queued',
    startedAt: undefined,
    heartbeatAt: now,
    completedAt: undefined,
    output: undefined,
    error: undefined,
    toolCalls: undefined,
    trace: undefined,
    evidence: undefined,
    quality_gates: undefined,
    runnerId: undefined,
  }, options)
  runAgentJob(id, runner, options)
  return getAgentJob(id, options)
}

export function runAgentJob(
  id: string,
  runner: AgentJobRunner,
  options?: AgentJobStoreOptions,
): void {
  const key = getActiveKey(id, options)
  const abortController = new AbortController()
  const heartbeatInterval = getHeartbeatIntervalMs(options)
  const writeHeartbeat = () => updateAgentJob(id, {
    heartbeatAt: new Date().toISOString(),
  }, options).catch(() => undefined)
  const heartbeat = setInterval(writeHeartbeat, heartbeatInterval)
  if (typeof heartbeat.unref === 'function') heartbeat.unref()
  const active: ActiveAgentJob = {
    abortController,
    promise: Promise.resolve(),
  }
  activeJobs.set(key, active)

  active.promise = (async () => {
    await updateAgentJob(id, {
      status: 'running',
      startedAt: new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      runnerId: processRunnerId,
    }, options)

    try {
      const completion = await runner(abortController.signal)
      const current = await loadRawAgentJob(id, options)
      if (current?.status === 'cancelled') return

      await updateAgentJob(id, {
        status: 'completed',
        heartbeatAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        output: completion.output,
        toolCalls: completion.toolCalls,
        trace: completion.trace,
        evidence: completion.evidence,
        quality_gates: completion.quality_gates,
      }, options)
    } catch (err: any) {
      const current = await loadRawAgentJob(id, options)
      if (current?.status === 'cancelled') return

      await updateAgentJob(id, {
        status: 'failed',
        heartbeatAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: err?.message || String(err),
      }, options)
    } finally {
      clearInterval(heartbeat)
      activeJobs.delete(key)
    }
  })()
}

export async function getAgentJob(
  id: string,
  options?: AgentJobStoreOptions,
): Promise<AgentJobRecord | null> {
  const job = await loadAgentJob(id, options)
  return job ? cloneJob(job) : null
}

export async function listAgentJobs(options?: AgentJobStoreOptions): Promise<AgentJobRecord[]> {
  try {
    const dir = getNamespaceDir(options)
    const entries = await readdir(dir)
    const jobs = await Promise.all(
      entries
        .filter((entry) => entry.endsWith('.json'))
        .map(async (entry) => loadAgentJob(entry.slice(0, -'.json'.length), options)),
    )

    return jobs
      .filter((job): job is AgentJobRecord => job !== null)
      .filter((job) => !options?.batch_id || job.batch_id === options.batch_id)
      .filter((job) => !options?.correlation_id || job.correlation_id === options.correlation_id)
      .map(cloneJob)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
  }
}

function createEmptyAgentJobStatusSummary(): AgentJobStatusSummary {
  return {
    queued: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    stale: 0,
  }
}

function maxIsoTimestamp(current: string | undefined, next: string | undefined): string | undefined {
  if (!next) return current
  if (!current) return next
  return next.localeCompare(current) > 0 ? next : current
}

function summarizeJobBatches(jobs: AgentJobRecord[]): AgentJobBatchSummary[] {
  const batches = new Map<string, AgentJobBatchSummary>()
  for (const job of jobs) {
    if (!job.batch_id) continue
    const existing = batches.get(job.batch_id)
    if (existing) {
      existing.total++
      existing.by_status[job.status]++
      existing.job_ids.push(job.id)
    } else {
      const byStatus = createEmptyAgentJobStatusSummary()
      byStatus[job.status]++
      batches.set(job.batch_id, {
        batch_id: job.batch_id,
        correlation_id: job.correlation_id,
        total: 1,
        by_status: byStatus,
        job_ids: [job.id],
      })
    }
  }

  return [...batches.values()]
    .map((batch) => ({
      ...batch,
      job_ids: batch.job_ids.sort(),
    }))
    .sort((a, b) => a.batch_id.localeCompare(b.batch_id))
}

export async function summarizeAgentJobs(options?: AgentJobStoreOptions): Promise<AgentJobSummary> {
  const jobs = await listAgentJobs(options)
  const byStatus = createEmptyAgentJobStatusSummary()
  let latestHeartbeatAt: string | undefined
  let latestUpdatedAt: string | undefined
  let evidenceCount = 0
  let qualityGateCount = 0
  const errorSummaries: AgentJobSummaryError[] = []
  const staleJobs: AgentJobSummary['stale_jobs'] = []

  for (const job of jobs) {
    byStatus[job.status]++
    latestHeartbeatAt = maxIsoTimestamp(latestHeartbeatAt, job.heartbeatAt)
    latestUpdatedAt = maxIsoTimestamp(latestUpdatedAt, job.updatedAt)
    evidenceCount += job.evidence?.length ?? 0
    qualityGateCount += job.quality_gates?.length ?? 0

    if (job.error) {
      errorSummaries.push({
        id: job.id,
        status: job.status,
        error: job.error,
      })
    }

    if (job.status === 'stale') {
      staleJobs.push({
        id: job.id,
        kind: job.kind,
        status: job.status,
        updatedAt: job.updatedAt,
        heartbeatAt: job.heartbeatAt,
        runnerId: job.runnerId,
        error: job.error,
      })
    }
  }

  const batches = summarizeJobBatches(jobs)

  return {
    total: jobs.length,
    by_status: byStatus,
    stale_count: byStatus.stale,
    replayable_count: jobs.filter((job) => Boolean(job.replay) && (job.status === 'stale' || job.status === 'failed' || job.status === 'cancelled')).length,
    failed_count: byStatus.failed,
    cancelled_count: byStatus.cancelled,
    latest_heartbeat_at: latestHeartbeatAt,
    latest_updated_at: latestUpdatedAt,
    evidence_count: evidenceCount,
    quality_gate_count: qualityGateCount,
    batch_count: batches.length,
    batches,
    error_summaries: errorSummaries,
    stale_jobs: staleJobs.sort((a, b) => {
      const byUpdatedAt = a.updatedAt.localeCompare(b.updatedAt)
      return byUpdatedAt === 0 ? a.id.localeCompare(b.id) : byUpdatedAt
    }),
  }
}

export async function stopAgentJob(
  id: string,
  reason?: string,
  options?: AgentJobStoreOptions,
): Promise<AgentJobRecord | null> {
  const key = getActiveKey(id, options)
  const active = activeJobs.get(key)
  active?.abortController.abort()

  const current = await loadAgentJob(id, options)
  if (!current) return null

  if (isTerminalJobStatus(current.status)) {
    return cloneJob(current)
  }

  return updateAgentJob(id, {
    status: 'cancelled',
    completedAt: new Date().toISOString(),
    error: reason ? `Cancelled: ${reason}` : 'Cancelled',
  }, options)
}

export async function clearAgentJobs(options?: AgentJobStoreOptions): Promise<void> {
  const keyPrefix = getActiveKeyPrefix(options)

  for (const [key, active] of activeJobs) {
    if (key.startsWith(keyPrefix)) {
      active.abortController.abort()
    }
  }

  await rm(getNamespaceDir(options), { recursive: true, force: true })
}
