/**
 * OpenTelemetry SDK shim — bridge OtelSpanLike → real OTel SDK spans.
 *
 * The SDK does not depend on `@opentelemetry/api` directly. This shim takes
 * a host-provided `OtelTracerLike` (structurally compatible with the OTel
 * `Tracer` interface) and emits real spans for each `OtelSpanLike` that
 * passes through the exporter. Hosts wire it like:
 *
 *   import { trace } from '@opentelemetry/api'
 *   const tracer = trace.getTracer('clavue-agent-sdk')
 *   const exporter = new OtelTraceExporter(tracer)
 *
 * Why a shim instead of a hard dep: keeps the SDK install footprint small
 * (peer adopters of `winston` / `pino` / vendor SDKs get the same benefit)
 * and lets every tracing backend that re-exports the OTel `Tracer` shape
 * plug in unchanged.
 *
 * @module
 */

import type { OtelSpanLike, TraceExporter } from './exporter.js'

/**
 * Structural subset of `@opentelemetry/api` Span — just what we need to
 * record a single converted event. Hosts pass real OTel spans which match
 * this shape automatically.
 */
export interface OtelSpanHandleLike {
  setAttribute(key: string, value: unknown): unknown
  setStatus(status: { code: number; message?: string }): unknown
  end(endTime?: number): void
}

/**
 * Structural subset of `@opentelemetry/api` Tracer. The real `tracer.startSpan`
 * returns an OTel `Span`; we depend only on the methods we use, so a real
 * tracer satisfies this interface without casting.
 */
export interface OtelTracerLike {
  startSpan(
    name: string,
    options?: { startTime?: number; attributes?: Record<string, unknown> },
  ): OtelSpanHandleLike
}

/**
 * OTel SDK SpanStatusCode values (mirrors `@opentelemetry/api`):
 *   UNSET = 0, OK = 1, ERROR = 2
 *
 * Inlined to avoid the import; hosts that pass a real OTel tracer get the
 * same numeric codes back.
 */
const OTEL_STATUS = {
  OK: 1,
  ERROR: 2,
} as const

/**
 * Exporter that forwards each `OtelSpanLike` to a host-provided OTel tracer
 * as a real OTel span. Use this when the host already runs an OTel SDK
 * pipeline (Jaeger, Tempo, vendor) and wants Clavue spans alongside HTTP /
 * DB / queue spans.
 */
export class OtelTraceExporter implements TraceExporter {
  readonly name = 'otel'
  private tracer: OtelTracerLike

  constructor(tracer: OtelTracerLike) {
    if (!tracer || typeof tracer.startSpan !== 'function') {
      throw new Error('OtelTraceExporter: tracer.startSpan is required')
    }
    this.tracer = tracer
  }

  export(spans: OtelSpanLike[]): void {
    for (const s of spans) {
      const handle = this.tracer.startSpan(s.name, {
        startTime: s.startTime,
        attributes: { ...s.attributes },
      })
      // Some OTel SDKs don't apply attributes from options uniformly across
      // versions; setting them explicitly is cheap and bullet-proof.
      for (const [k, v] of Object.entries(s.attributes)) {
        try {
          handle.setAttribute(k, v as never)
        } catch {
          // Tracer attribute errors must not break the export pipeline.
        }
      }
      if (s.status) {
        const code = s.status.code === 'error' ? OTEL_STATUS.ERROR : OTEL_STATUS.OK
        try {
          handle.setStatus(s.status.message ? { code, message: s.status.message } : { code })
        } catch {
          // see above
        }
      }
      handle.end(s.endTime ?? s.startTime)
    }
  }
}
