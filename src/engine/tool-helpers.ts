/**
 * Pure helpers that summarize tool inputs, tool safety, and concurrency
 * eligibility for the QueryEngine policy decision trace and concurrency
 * scheduler. Extracted from `src/engine.ts` to shrink the god-class.
 */

import type {
  AgentRunToolConcurrencySource,
  AgentRunToolInputSummary,
  AgentRunToolSafetySummary,
  ToolDefinition,
} from '../types.js'

const DEFAULT_TOOL_CONCURRENCY = 10

export function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined
  }
  if (typeof value !== 'string') return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined
}

export function resolveMaxToolConcurrency(
  configured?: number,
): { limit: number; source: AgentRunToolConcurrencySource } {
  const optionLimit = parsePositiveInteger(configured)
  if (optionLimit !== undefined) return { limit: optionLimit, source: 'option' }

  const envLimit = parsePositiveInteger(process.env.AGENT_SDK_MAX_TOOL_CONCURRENCY)
  if (envLimit !== undefined) return { limit: envLimit, source: 'env' }

  return { limit: DEFAULT_TOOL_CONCURRENCY, source: 'default' }
}

export function canRunConcurrently(tool?: ToolDefinition): boolean {
  return tool?.isReadOnly?.() === true && tool.isConcurrencySafe?.() === true
}

/**
 * Slice H — pure tool dispatch planner.
 *
 * Walks `toolUseBlocks` in order, grouping consecutive concurrency-safe
 * tools into a single concurrent batch and emitting non-concurrent
 * tools as serial singletons. The plan is order-preserving with respect
 * to the model's emitted tool_use sequence; consumers schedule each
 * concurrent batch as `Promise.all` and serial singletons as awaits.
 *
 * Splitting this out of `executeTools` makes the grouping algorithm
 * separately testable without spinning up the full engine.
 */
export interface ToolDispatchEntry<TBlock> {
  block: TBlock
  tool?: ToolDefinition
}

export interface ToolDispatchBatch<TBlock> {
  kind: 'concurrent' | 'serial'
  entries: ToolDispatchEntry<TBlock>[]
}

export function planToolDispatch<TBlock extends { name: string }>(
  toolUseBlocks: TBlock[],
  lookup: (name: string) => ToolDefinition | undefined,
): ToolDispatchBatch<TBlock>[] {
  const batches: ToolDispatchBatch<TBlock>[] = []
  let pending: ToolDispatchEntry<TBlock>[] = []

  const flushPending = () => {
    if (pending.length === 0) return
    batches.push({ kind: 'concurrent', entries: pending })
    pending = []
  }

  for (const block of toolUseBlocks) {
    const tool = lookup(block.name)
    if (canRunConcurrently(tool)) {
      pending.push({ block, tool })
      continue
    }
    flushPending()
    batches.push({ kind: 'serial', entries: [{ block, tool }] })
  }
  flushPending()
  return batches
}

export function summarizeToolInput(input: unknown): AgentRunToolInputSummary {
  if (input === null) return { type: 'null', size_bytes: 4 }
  if (input === undefined) return { type: 'undefined' }
  if (Array.isArray(input)) {
    return {
      type: 'array',
      size_bytes: estimateJsonSize(input),
    }
  }
  if (typeof input === 'object') {
    return {
      type: 'object',
      keys: Object.keys(input as Record<string, unknown>).slice(0, 20),
      size_bytes: estimateJsonSize(input),
    }
  }
  if (typeof input === 'string') {
    return {
      type: 'string',
      size_bytes: Buffer.byteLength(input, 'utf8'),
    }
  }
  if (typeof input === 'number') {
    return { type: 'number', size_bytes: Buffer.byteLength(String(input), 'utf8') }
  }
  if (typeof input === 'boolean') return { type: 'boolean', size_bytes: input ? 4 : 5 }
  return { type: 'unknown' }
}

function estimateJsonSize(input: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(input), 'utf8')
  } catch {
    return undefined
  }
}

export function summarizeToolSafety(tool: ToolDefinition): AgentRunToolSafetySummary {
  const safety = tool.safety ?? {}
  const read = safety.read ?? tool.isReadOnly?.() === true
  const write = safety.write ?? !read

  return {
    read,
    write,
    shell: safety.shell ?? false,
    network: safety.network ?? false,
    external_state: safety.externalState ?? false,
    destructive: safety.destructive ?? false,
    approval_required: safety.approvalRequired ?? false,
    idempotent: safety.idempotent,
  }
}
