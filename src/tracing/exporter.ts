/**
 * v3.3 Tracing — exporters (prototype).
 *
 * `TraceEvent` → `OtelSpanLike` conversion + reference exporters. The
 * `OtelSpanLike` shape mirrors OpenTelemetry's `ReadableSpan`-style data
 * model (name + attributes + start/end time) without importing
 * `@opentelemetry/api`. Hosts wrap the resulting spans with their real
 * OTel SDK, write JSONL to disk for Loki/Splunk, or ship to vendor APIs.
 *
 * Conversion rules (semantic-convention-aligned, no vendor lock-in):
 *
 *   graph_step    → name = "graph.step.<kind>"
 *                   attributes: graph.node_id, graph.kind, graph.status,
 *                               graph.output.kind
 *   guardrail     → name = "guardrail.<scope>"
 *                   attributes: guardrail.scope, guardrail.passed,
 *                               guardrail.violation_count, agent.id?,
 *                               tool.name?
 *   tool_call     → name = "tool.<phase>.<name>"
 *                   attributes: tool.name, tool.phase
 *   tool_cache    → name = "tool.cache.<outcome>"
 *                   attributes: tool.name, tool.cache.outcome,
 *                               tool.use_id?
 *   <other>       → name = "trace.<kind>" (verbatim attributes)
 *
 * @module
 */

import type { TraceEvent } from './types.js'

/**
 * OpenTelemetry-shaped span. Matches the OTel data model loosely so any
 * OTel SDK can wrap it without needing our types. Time fields are
 * epoch-ms; OTel SDKs convert to nanoseconds at export time.
 */
export interface OtelSpanLike {
  /** Span / operation name. */
  name: string
  /** Logical trace id — we use the run id. */
  traceId: string
  /** Span id within the trace. Optional; falls back to per-event index. */
  spanId?: string
  /** Epoch milliseconds when the operation started. */
  startTime: number
  /** Epoch milliseconds when the operation ended; absent for instant events. */
  endTime?: number
  /** Flat key/value attributes — OTel semconv-compatible. */
  attributes: Record<string, unknown>
  /** OTel-style status. Default: `ok`. */
  status?: { code: 'ok' | 'error'; message?: string }
}

/** A consumer that ships spans to a real backend (or stdout, or a buffer). */
export interface TraceExporter {
  readonly name: string
  /** Receives a batch (often size 1 in streaming mode). */
  export(spans: OtelSpanLike[]): void | Promise<void>
  /** Optional flush hook for buffering exporters. */
  flush?(): void | Promise<void>
}

/**
 * Convert a TraceEvent into an OTel-shaped span. Pure function — no I/O.
 * `runId` defaults to `event.runId` when present.
 */
export function eventToOtelSpan(event: TraceEvent): OtelSpanLike {
  const traceId = event.runId ?? '<no-run>'
  const baseAttributes: Record<string, unknown> = {}
  let name = `trace.${event.kind}`
  let endTime: number | undefined = event.at

  switch (event.kind) {
    case 'graph_step': {
      const data = event.data as {
        step: {
          nodeId: string
          kind: string
          status: string
          startedAt: number
          endedAt: number
          output?: { kind: string; hits?: unknown[] }
        }
      }
      const step = data.step
      name = `graph.step.${step.kind}`
      baseAttributes['graph.node_id'] = step.nodeId
      baseAttributes['graph.kind'] = step.kind
      baseAttributes['graph.status'] = step.status
      if (step.output) {
        baseAttributes['graph.output.kind'] = step.output.kind
        if (step.output.kind === 'retrieval' && Array.isArray(step.output.hits)) {
          baseAttributes['retrieval.hit_count'] = step.output.hits.length
        }
      }
      const span: OtelSpanLike = {
        name,
        traceId,
        ...(event.spanId !== undefined ? { spanId: event.spanId } : {}),
        startTime: step.startedAt,
        endTime: step.endedAt,
        attributes: baseAttributes,
        status: step.status === 'failed' ? { code: 'error' } : { code: 'ok' },
      }
      return span
    }
    case 'guardrail': {
      const data = event.data as {
        scope: string
        evaluation: { passed: boolean; violations: { guardrail: string }[] }
        toolName?: string
        agentId?: string
      }
      name = `guardrail.${data.scope}`
      baseAttributes['guardrail.scope'] = data.scope
      baseAttributes['guardrail.passed'] = data.evaluation.passed
      baseAttributes['guardrail.violation_count'] = data.evaluation.violations.length
      if (data.evaluation.violations.length > 0) {
        baseAttributes['guardrail.violations'] = data.evaluation.violations
          .map((v) => v.guardrail)
          .join(',')
      }
      if (data.agentId) baseAttributes['agent.id'] = data.agentId
      if (data.toolName) baseAttributes['tool.name'] = data.toolName
      return {
        name,
        traceId,
        ...(event.spanId !== undefined ? { spanId: event.spanId } : {}),
        startTime: event.at,
        endTime,
        attributes: baseAttributes,
        status: data.evaluation.passed ? { code: 'ok' } : { code: 'error' },
      }
    }
    case 'tool_call': {
      const data = event.data as { toolName: string; phase: string }
      name = `tool.${data.phase}.${data.toolName}`
      baseAttributes['tool.name'] = data.toolName
      baseAttributes['tool.phase'] = data.phase
      return {
        name,
        traceId,
        ...(event.spanId !== undefined ? { spanId: event.spanId } : {}),
        startTime: event.at,
        endTime,
        attributes: baseAttributes,
      }
    }
    case 'tool_cache': {
      const data = event.data as { toolName: string; toolUseId: string; outcome: 'hit' | 'miss' }
      name = `tool.cache.${data.outcome}`
      baseAttributes['tool.name'] = data.toolName
      baseAttributes['tool.cache.outcome'] = data.outcome
      baseAttributes['tool.use_id'] = data.toolUseId
      return {
        name,
        traceId,
        ...(event.spanId !== undefined ? { spanId: event.spanId } : {}),
        startTime: event.at,
        endTime,
        attributes: baseAttributes,
      }
    }
    default: {
      // Pass-through with the verbatim payload as attributes if it's an object.
      if (event.data && typeof event.data === 'object') {
        baseAttributes['trace.data'] = event.data
      } else {
        baseAttributes['trace.data'] = event.data
      }
      return {
        name,
        traceId,
        ...(event.spanId !== undefined ? { spanId: event.spanId } : {}),
        startTime: event.at,
        endTime,
        attributes: baseAttributes,
      }
    }
  }
}

/** Console exporter — prints one human-readable line per span. */
export class ConsoleExporter implements TraceExporter {
  readonly name = 'console'
  private writer: (line: string) => void

  constructor(writer: (line: string) => void = (l) => console.log(l)) {
    this.writer = writer
  }

  export(spans: OtelSpanLike[]): void {
    for (const s of spans) {
      const dur = s.endTime !== undefined ? `${s.endTime - s.startTime}ms` : '-'
      const status = s.status?.code === 'error' ? 'ERR' : 'OK '
      const attrs = Object.entries(s.attributes)
        .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
        .join(' ')
      this.writer(`[${status}] ${s.name.padEnd(28)} dur=${dur.padStart(6)}  ${attrs}`)
    }
  }
}

/** JSONL exporter — collects one OTel-shape JSON object per line. */
export class JsonlExporter implements TraceExporter {
  readonly name = 'jsonl'
  private buffer: string[] = []

  export(spans: OtelSpanLike[]): void {
    for (const s of spans) {
      this.buffer.push(JSON.stringify(s))
    }
  }

  /** Drain and return the collected JSONL string. */
  drain(): string {
    const out = this.buffer.join('\n')
    this.buffer = []
    return out
  }

  size(): number {
    return this.buffer.length
  }
}
