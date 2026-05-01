import { randomUUID } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createAgentJob, listAgentJobs } from './agent-jobs.js'
import { saveMemory, queryMemories } from './memory.js'
import { applyRuntimeProfile, getAllRuntimeProfiles } from './runtime-profiles.js'
import { FileReadTool, FileWriteTool } from './tools/index.js'
import { buildContextPack, renderContextPack } from './utils/context.js'
import { estimateMessagesTokens, estimateSystemPromptTokens } from './utils/tokens.js'
import type { AgentOptions, BenchmarkMetric, BenchmarkOptions, BenchmarkReport, ToolContext } from './types.js'

const defaultIterations = 5

type BenchmarkMeasure = () => Promise<Record<string, unknown> | void> | Record<string, unknown> | void

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000
}

function normalizeIterations(iterations: number | undefined): number {
  if (iterations === undefined) return defaultIterations
  if (!Number.isInteger(iterations) || iterations <= 0) {
    throw new Error('Benchmark iterations must be a positive integer.')
  }
  return iterations
}

async function measureMetric(
  name: BenchmarkMetric['name'],
  iterations: number,
  measure: BenchmarkMeasure,
  metadata: Record<string, unknown> = {},
): Promise<BenchmarkMetric> {
  const durations: number[] = []
  let latestMetadata: Record<string, unknown> | void = undefined

  for (let i = 0; i < iterations; i++) {
    const started = nowMs()
    latestMetadata = await measure()
    durations.push(nowMs() - started)
  }

  const total = durations.reduce((sum, duration) => sum + duration, 0)
  return {
    name,
    iterations,
    total_ms: total,
    mean_ms: total / iterations,
    min_ms: Math.min(...durations),
    max_ms: Math.max(...durations),
    metadata: { ...metadata, ...(latestMetadata || {}) },
  }
}

export async function runBenchmarks(options: BenchmarkOptions = {}): Promise<BenchmarkReport> {
  const started = new Date()
  const startedMs = nowMs()
  const cwd = options.cwd || process.cwd()
  const iterations = normalizeIterations(options.iterations)
  const tempRoot = await mkdtemp(join(tmpdir(), 'clavue-agent-sdk-bench-'))
  const memoryDir = options.memory?.dir || join(tempRoot, 'memory')
  const jobsDir = options.agentJobs?.dir || join(tempRoot, 'agent-jobs')
  const runtimeNamespace = options.agentJobs?.runtimeNamespace || `benchmark-${randomUUID()}`

  try {
    const context: ToolContext = { cwd: tempRoot, runtimeNamespace }
    const readFiles = await Promise.all(
      Array.from({ length: 4 }, async (_, index) => {
        const path = join(tempRoot, `read-${index}.txt`)
        await writeFile(path, `benchmark read fixture ${index}\n${'x'.repeat(128)}\n`, 'utf-8')
        return path
      }),
    )
    const writePath = join(tempRoot, 'mutation.txt')
    const messages = Array.from({ length: 16 }, (_, index) => ({
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `benchmark context message ${index} ${'token '.repeat(32)}`,
    }))
    const systemPrompt = `Benchmark system prompt\n${'context '.repeat(256)}`

    await Promise.all(
      Array.from({ length: 8 }, (_, index) => saveMemory({
        id: `bench-memory-${index}`,
        type: index % 2 === 0 ? 'feedback' : 'decision',
        scope: 'repo',
        title: `Benchmark memory ${index}`,
        content: `Offline benchmark fixture for deterministic memory query ${index}.`,
        repoPath: cwd,
        tags: ['benchmark', index % 2 === 0 ? 'even' : 'odd'],
        confidence: index % 2 === 0 ? 'high' : 'medium',
      }, { dir: memoryDir })),
    )

    const metrics: BenchmarkMetric[] = []

    metrics.push(await measureMetric('readOnlyFanOut', iterations, async () => {
      const results = await Promise.all(
        readFiles.map((file_path) => FileReadTool.call({ file_path, limit: 5 }, context)),
      )
      return { files: readFiles.length, bytes: results.reduce((sum, result) => sum + String(result.content).length, 0) }
    }))

    metrics.push(await measureMetric('serialMutationOrdering', iterations, async () => {
      for (let step = 0; step < 3; step++) {
        await FileWriteTool.call({ file_path: writePath, content: `iteration mutation step ${step}\n` }, context)
      }
      return { writes: 3 }
    }))

    metrics.push(await measureMetric('contextBuild', iterations, async () => {
      const messageTokens = estimateMessagesTokens(messages)
      const systemTokens = estimateSystemPromptTokens(systemPrompt)
      const pack = await buildContextPack(cwd, { includeGit: false, includeUser: false })
      const renderedContext = renderContextPack(pack)

      return {
        messages: messages.length,
        estimated_tokens: messageTokens + systemTokens,
        sections: pack.sections.length,
        project_sources: pack.sections.filter((section) => section.kind === 'project' && section.source).length,
        rendered_context_included: renderedContext.length > 0,
        rendered_context_bytes: Buffer.byteLength(renderedContext, 'utf-8'),
      }
    }))

    metrics.push(await measureMetric('runtimeProfileResolve', iterations, () => {
      const profiles = getAllRuntimeProfiles()
      const resolved = profiles.map((profile) => applyRuntimeProfile<AgentOptions>({ workflowMode: profile.name }))
      const plan = resolved.find((profile) => profile.workflowMode === 'plan')
      const verify = resolved.find((profile) => profile.workflowMode === 'verify')
      return {
        profiles: profiles.length,
        modes: profiles.map((profile) => profile.name),
        plan_permission_mode: plan?.permissionMode,
        plan_toolsets: plan?.toolsets,
        verify_memory_policy: verify?.memory?.policy?.mode,
      }
    }))

    metrics.push(await measureMetric('memoryQuery', iterations, async () => {
      const results = await queryMemories({
        repoPath: cwd,
        text: 'deterministic memory query benchmark',
        tags: ['benchmark'],
        limit: 5,
      }, { dir: memoryDir })
      return { results: results.length, memory_dir_configured: Boolean(options.memory?.dir) }
    }))

    metrics.push(await measureMetric('agentJobStorage', iterations, async () => {
      await createAgentJob({
        kind: 'subagent',
        prompt: 'benchmark prompt',
        description: 'benchmark storage fixture',
      }, { dir: jobsDir, runtimeNamespace })
      const jobs = await listAgentJobs({ dir: jobsDir, runtimeNamespace, staleAfterMs: -1 })
      return { jobs: jobs.length, runtimeNamespace }
    }))

    const completed = new Date()
    return {
      id: `benchmark_${started.getTime()}_${randomUUID()}`,
      started_at: started.toISOString(),
      completed_at: completed.toISOString(),
      duration_ms: nowMs() - startedMs,
      cwd,
      metrics,
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
