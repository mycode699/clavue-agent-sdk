import { createHash } from 'node:crypto'
import process from 'node:process'

import { saveMemory, type MemoryEntry, type MemoryStoreOptions } from './memory.js'
import { runRetroCycle } from './retro/cycle.js'
import { runRetroLoop } from './retro/loop.js'
import type { RetroLoopAttemptHook, RetroSourceRun } from './retro/types.js'
import type {
  AgentRunResult,
  AgentSelfImprovementResult,
  MemoryConfig,
  SelfImprovementConfig,
  SDKMessage,
} from './types.js'

export interface RunSelfImprovementOptions {
  cwd: string
  sessionId: string
  memory?: MemoryConfig
  onAttemptRetry?: RetroLoopAttemptHook
}

export type ImprovementCandidate = Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'>

const MAX_OUTPUT_CHARS = 2_000
const DEFAULT_MAX_ENTRIES_PER_RUN = 8

function trimText(value: string, limit = MAX_OUTPUT_CHARS): string {
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}…` : normalized
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(api[_-]?key|auth[_-]?token|access[_-]?token|password|secret)(\s*[=:]\s*)\S+/gi, '$1$2[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[REDACTED_API_KEY]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+/=-]{12,}\b/gi, 'Bearer [REDACTED]')
}

function buildMemoryId(candidate: ImprovementCandidate): string {
  const hash = createHash('sha1')
    .update([
      candidate.type,
      candidate.scope,
      candidate.repoPath || '',
      candidate.sessionId || '',
      candidate.title,
      candidate.content,
    ].join('\n'))
    .digest('hex')
    .slice(0, 16)

  return `improvement-${candidate.scope}-${hash}`
}

function getFirstUserPrompt(run: AgentRunResult): string {
  const userMessage = run.messages.find((message) => message.type === 'user')
  return typeof userMessage?.message.content === 'string'
    ? trimText(userMessage.message.content, 600)
    : ''
}

function hasFailureOutput(output: string): boolean {
  return /\b(error|failed|failure|permission denied|blocked by|timed out|timeout|exception)\b/i.test(output)
}

function getToolFailureEvents(events: SDKMessage[]): Array<{ toolName: string; output: string }> {
  return events
    .filter((event): event is Extract<SDKMessage, { type: 'tool_result' }> => event.type === 'tool_result')
    .map((event) => ({
      toolName: event.result.tool_name || 'unknown',
      output: trimText(redactSensitiveText(event.result.output)),
    }))
    .filter((event) => hasFailureOutput(event.output))
}

export function extractRunImprovementCandidates(
  run: AgentRunResult,
  config: SelfImprovementConfig,
  options: RunSelfImprovementOptions,
): ImprovementCandidate[] {
  const repoPath = config.memory?.repoPath || options.memory?.repoPath || options.cwd
  const sessionId = options.sessionId
  const prompt = getFirstUserPrompt(run)
  const candidates: ImprovementCandidate[] = []
  const tags = ['auto', 'self-improvement', 'run']
  const toolFailures = getToolFailureEvents(run.events)

  for (const failure of toolFailures) {
    candidates.push({
      type: 'improvement',
      scope: 'repo',
      title: `Tool failure: ${failure.toolName}`,
      content: [
        prompt ? `User request: ${prompt}` : undefined,
        `Tool ${failure.toolName} returned a failure signal: ${failure.output}`,
        'Use this as prior operational context when a future task looks similar; verify current state before applying it.',
      ].filter(Boolean).join('\n'),
      tags: [...tags, 'tool-failure', failure.toolName].sort(),
      confidence: 'medium',
      repoPath,
      sessionId,
      source: 'auto-extracted from agent run tool results',
    })
  }

  if (run.status === 'errored' || run.subtype.startsWith('error')) {
    const errorText = trimText(redactSensitiveText((run.errors || []).join('\n') || run.subtype))
    candidates.push({
      type: 'improvement',
      scope: 'repo',
      title: `Run ended with ${run.subtype}`,
      content: [
        prompt ? `User request: ${prompt}` : undefined,
        `Run status: ${run.status}`,
        `Terminal subtype: ${run.subtype}`,
        errorText ? `Error detail: ${errorText}` : undefined,
        'Treat this as a recurring-risk signal, not a guaranteed current failure.',
      ].filter(Boolean).join('\n'),
      tags: [...tags, 'run-failure', run.subtype].sort(),
      confidence: 'medium',
      repoPath,
      sessionId,
      source: 'auto-extracted from agent run terminal result',
    })
  }

  if (config.memory?.captureSuccessfulRuns && run.status === 'completed' && toolFailures.length === 0) {
    candidates.push({
      type: 'improvement',
      scope: 'repo',
      title: 'Successful run pattern',
      content: [
        prompt ? `User request: ${prompt}` : undefined,
        `Completed in ${run.num_turns} turn(s) with subtype ${run.subtype}.`,
        run.text ? `Final response: ${trimText(redactSensitiveText(run.text), 800)}` : undefined,
      ].filter(Boolean).join('\n'),
      tags: [...tags, 'success'].sort(),
      confidence: 'low',
      repoPath,
      sessionId,
      source: 'auto-extracted from successful agent run',
    })
  }

  return candidates
}

function toRetroSourceRun(run: AgentRunResult): RetroSourceRun {
  return {
    id: run.id,
    session_id: run.session_id,
    status: run.status,
    subtype: run.subtype,
    started_at: run.started_at,
    completed_at: run.completed_at,
    duration_ms: run.duration_ms,
    duration_api_ms: run.duration_api_ms,
    total_cost_usd: run.total_cost_usd,
    num_turns: run.num_turns,
    stop_reason: run.stop_reason,
    usage: run.usage,
  }
}

export async function runSelfImprovement(
  run: AgentRunResult,
  config: SelfImprovementConfig,
  options: RunSelfImprovementOptions,
): Promise<AgentSelfImprovementResult> {
  const savedMemories: MemoryEntry[] = []
  const errors: string[] = []

  if (config.memory?.enabled !== false) {
    const store: MemoryStoreOptions = {
      dir: config.memory?.dir || options.memory?.dir,
    }
    const maxEntries = config.memory?.maxEntriesPerRun ?? DEFAULT_MAX_ENTRIES_PER_RUN
    const candidates = extractRunImprovementCandidates(run, config, options).slice(0, maxEntries)

    for (const candidate of candidates) {
      try {
        savedMemories.push(await saveMemory({ id: buildMemoryId(candidate), ...candidate }, store))
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    }
  }

  let retroCycle: AgentSelfImprovementResult['retroCycle']
  let retroLoop: AgentSelfImprovementResult['retroLoop']
  if (config.retro?.enabled) {
    try {
      const target = {
        name: config.retro.targetName || 'agent-sdk-target',
        cwd: config.retro.cwd || options.cwd || process.cwd(),
      }
      const sourceRun = toRetroSourceRun(run)

      if (config.retro.loop?.enabled) {
        retroLoop = await runRetroLoop({
          target,
          gates: config.retro.gates,
          policy: config.retro.policy,
          ledger: config.retro.ledger,
          sourceRun,
          maxAttempts: config.retro.loop.maxAttempts,
          onAttemptRetry: options.onAttemptRetry,
        })
        retroCycle = retroLoop.finalCycle
      } else {
        retroCycle = await runRetroCycle({
          target,
          gates: config.retro.gates,
          policy: config.retro.policy,
          ledger: config.retro.ledger,
          sourceRun,
        })
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error))
    }
  }

  return {
    savedMemories,
    retroCycle,
    retroLoop,
    errors: errors.length > 0 ? errors : undefined,
  }
}
