/**
 * v3.3 Live Tracing (prototype) — public surface.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.3 section).
 * @module
 */

export type {
  GraphStepEventData,
  GuardrailEventData,
  ToolCacheEventData,
  ToolCallEventData,
  ToolConcurrencyAdjustEventData,
  TraceEvent,
  TraceQuery,
  TraceRun,
} from './types.js'

export { TraceStore } from './runtime.js'

export type { OtelSpanLike, TraceExporter } from './exporter.js'
export { ConsoleExporter, JsonlExporter, eventToOtelSpan } from './exporter.js'
export type { OtelSpanHandleLike, OtelTracerLike } from './otel-shim.js'
export { OtelTraceExporter } from './otel-shim.js'
