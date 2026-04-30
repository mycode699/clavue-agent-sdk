import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'

import {
  getRuntimeNamespace,
  type RuntimeNamespaceContext,
} from './utils/runtime.js'
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
  id: string
  kind: AgentJobKind
  status: AgentJobStatus
  runtimeNamespace: string
  prompt: string
  description?: string
  subagent_type?: string
  model?: string
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
  allowedTools?: string[]
  replay?: AgentJobReplayInput
}

export interface AgentJobCompletion {
  output?: string
  toolCalls?: string[]
  trace?: AgentRunTrace
  evidence?: Evidence[]
  quality_gates?: QualityGateResult[]
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
    id: `agent_job_${Date.now()}_${randomUUID()}`,
    kind: input.kind,
    status: 'queued',
    runtimeNamespace: getRuntimeNamespace(options),
    prompt: input.prompt,
    description: input.description,
    subagent_type: input.subagent_type,
    model: input.model,
    allowedTools: input.allowedTools,
    replay: input.replay,
    createdAt: now,
    updatedAt: now,
  }

  return saveAgentJob(job, options)
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
      .map(cloneJob)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  } catch {
    return []
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
