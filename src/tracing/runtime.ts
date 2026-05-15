/**
 * Tracing — in-memory TraceStore (v3.3 prototype).
 *
 * Capabilities:
 *   - append events to a run
 *   - query slice by kind / span / index range
 *   - serialize/deserialize whole runs as JSON (replay-safe)
 *   - replay: feed the recorded events back through any consumer in order
 *
 * Design notes:
 *   - one process, one store. multi-tenant hosts allocate one store per tenant.
 *   - no disk IO. hosts that want persistence call serialize() and write
 *     wherever (file, DB, blob).
 *   - `replay()` is purely re-emission — it does not re-execute graphs. that
 *     belongs to the engine layer. peer dashboards cannot do even this much.
 *
 * @module
 */

import type {
  GraphStepEventData,
  GuardrailEventData,
  ToolCacheEventData,
  ToolCallEventData,
  TraceEvent,
  TraceQuery,
  TraceRun,
} from './types.js'

import type { GraphStep } from '../graph/types.js'
import type { GuardrailEvaluation, GuardrailScope } from '../guardrails/types.js'

function generateRunId(): string {
  // Cheap monotonic-ish id — good enough for in-memory tracing. Hosts that
  // need globally-unique ids can pass their own.
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `trace_${stamp}_${rand}`
}

export class TraceStore {
  private runs = new Map<string, TraceRun>()
  private active: string | null = null

  /** Start a new run. Returns the run id. */
  startRun(meta: Record<string, unknown> = {}, id?: string): string {
    const runId = id ?? generateRunId()
    if (this.runs.has(runId)) {
      throw new Error(`TraceStore.startRun: id "${runId}" already exists`)
    }
    this.runs.set(runId, {
      id: runId,
      startedAt: Date.now(),
      events: [],
      meta: { ...meta },
    })
    this.active = runId
    return runId
  }

  /** Mark a run as ended. Idempotent. */
  endRun(runId: string = this.activeOrThrow()): void {
    const run = this.requireRun(runId)
    if (run.endedAt === undefined) run.endedAt = Date.now()
    if (this.active === runId) this.active = null
  }

  /** Append an event. Returns the event index inside the run. */
  append(event: Omit<TraceEvent, 'at'> & { at?: number }, runId?: string): number {
    const id = runId ?? this.activeOrThrow()
    const run = this.requireRun(id)
    const evt: TraceEvent = {
      kind: event.kind,
      at: event.at ?? Date.now(),
      data: event.data,
      ...(event.spanId !== undefined ? { spanId: event.spanId } : {}),
      runId: id,
    }
    run.events.push(evt)
    return run.events.length - 1
  }

  // ---- Convenience appenders for built-in kinds --------------------------

  appendGraphStep(step: GraphStep, runId?: string): number {
    const data: GraphStepEventData = { step }
    return this.append({ kind: 'graph_step', data, spanId: step.nodeId }, runId)
  }

  appendGuardrail(
    scope: GuardrailScope,
    evaluation: GuardrailEvaluation,
    extra: { toolName?: string; agentId?: string } = {},
    runId?: string,
  ): number {
    const data: GuardrailEventData = {
      scope,
      evaluation,
      ...(extra.toolName !== undefined ? { toolName: extra.toolName } : {}),
      ...(extra.agentId !== undefined ? { agentId: extra.agentId } : {}),
    }
    return this.append(
      {
        kind: 'guardrail',
        data,
        ...(extra.toolName !== undefined ? { spanId: `tool:${extra.toolName}` } : {}),
      },
      runId,
    )
  }

  appendToolCall(payload: ToolCallEventData, runId?: string): number {
    return this.append(
      { kind: 'tool_call', data: payload, spanId: `tool:${payload.toolName}` },
      runId,
    )
  }

  /**
   * Append a per-call `tool_cache` event. Engine calls this once per
   * cacheable dispatch; non-cacheable tools never reach this method.
   * `spanId` mirrors `appendToolCall` so OTel consumers can correlate
   * cache outcomes with the parent tool span.
   */
  appendToolCache(payload: ToolCacheEventData, runId?: string): number {
    return this.append(
      { kind: 'tool_cache', data: payload, spanId: `tool:${payload.toolName}` },
      runId,
    )
  }

  // ---- Read / query ------------------------------------------------------

  getRun(runId: string): TraceRun | undefined {
    const run = this.runs.get(runId)
    if (!run) return undefined
    return cloneRun(run)
  }

  listRunIds(): string[] {
    return Array.from(this.runs.keys())
  }

  /**
   * Filtered slice of events. All filters are AND-combined. Index bounds are
   * applied last.
   */
  query(runId: string, q: TraceQuery = {}): TraceEvent[] {
    const run = this.requireRun(runId)
    let events = run.events
    if (q.kinds && q.kinds.length > 0) {
      const wanted = new Set(q.kinds)
      events = events.filter((e) => wanted.has(e.kind))
    }
    if (q.spanId !== undefined) {
      events = events.filter((e) => e.spanId === q.spanId)
    }
    const from = q.fromIndex ?? 0
    const to = q.toIndex ?? events.length
    return events.slice(from, to).map(cloneEvent)
  }

  // ---- Replay / serialize ------------------------------------------------

  /**
   * Replay recorded events through a consumer in append order. The consumer
   * is invoked synchronously for each event (await per call so async sinks
   * stay ordered). Optional `from` skips earlier events; useful for resuming
   * a partial replay.
   */
  async replay(
    runId: string,
    consumer: (event: TraceEvent, index: number) => void | Promise<void>,
    options: { from?: number; kinds?: string[] } = {},
  ): Promise<number> {
    const run = this.requireRun(runId)
    const from = options.from ?? 0
    const kinds = options.kinds ? new Set(options.kinds) : undefined
    let count = 0
    for (let i = from; i < run.events.length; i += 1) {
      const evt = run.events[i]!
      if (kinds && !kinds.has(evt.kind)) continue
      await consumer(cloneEvent(evt), i)
      count += 1
    }
    return count
  }

  serialize(runId: string): string {
    return JSON.stringify(this.requireRun(runId))
  }

  static deserialize(json: string): TraceRun {
    const parsed = JSON.parse(json) as TraceRun
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.events)) {
      throw new Error('TraceStore.deserialize: malformed payload')
    }
    return parsed
  }

  /** Replace (or insert) a run from a deserialized snapshot. */
  importRun(run: TraceRun): void {
    if (!run.id || typeof run.id !== 'string') {
      throw new Error('importRun: run.id required')
    }
    this.runs.set(run.id, cloneRun(run))
  }

  // ---- Internal ----------------------------------------------------------

  private requireRun(id: string): TraceRun {
    const run = this.runs.get(id)
    if (!run) throw new Error(`TraceStore: unknown run id "${id}"`)
    return run
  }

  private activeOrThrow(): string {
    if (!this.active) throw new Error('TraceStore: no active run; call startRun() first')
    return this.active
  }
}

function cloneRun(run: TraceRun): TraceRun {
  return {
    id: run.id,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    events: run.events.map(cloneEvent),
    meta: { ...run.meta },
  }
}

function cloneEvent(evt: TraceEvent): TraceEvent {
  return {
    kind: evt.kind,
    at: evt.at,
    data: evt.data,
    ...(evt.runId !== undefined ? { runId: evt.runId } : {}),
    ...(evt.spanId !== undefined ? { spanId: evt.spanId } : {}),
  }
}
