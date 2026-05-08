/**
 * Multi-Agent Graph DSL — type surface (v3.1 prototype).
 *
 * Goal: a peer-comparable handoff DSL (vs openai-agents handoffs / Mastra
 * workflows) with one extra node kind class per peer:
 *
 *   - agent     ─ run an AgentLike on the current input/context
 *   - verifier  ─ reuse src/workflow/verifier Verifier; gate routing on results
 *   - router    ─ pure function deciding the next node id
 *   - parallel  ─ fan-out to N branches, join by 'all' or 'race'
 *   - human     ─ async approval gate; output carries approved + optional note
 *
 * Intentionally *not* a full BPMN engine. The runtime is ~250 lines, has no
 * external dependencies, and reuses Verifier so the existing quality_gate /
 * proof-of-work plumbing already works inside graphs.
 *
 * Status: prototype. Public types are subject to change before v3.1 GA.
 *
 * @module
 */

import type { QualityGateResult } from '../types.js'
import type { GuardrailEvaluation, GuardrailRegistry } from '../guardrails/index.js'
import type { Retriever, RetrievalHit } from '../rag/index.js'
import type { TraceStore } from '../tracing/runtime.js'
import type { Verifier } from '../workflow/verifier.js'

/**
 * Minimal agent-like interface a graph node can drive. The real `Agent` class
 * already satisfies this via its public `prompt(text)` method.
 */
export interface GraphAgentLike {
  prompt(text: string): Promise<{ text: string }>
}

/** Read-only execution context handed to routers / when-guards. */
export interface GraphContext {
  /** Initial input handed to the graph's entry node. */
  input: string
  /** Per-node final output, keyed by node id. */
  outputs: Readonly<Record<string, GraphNodeOutput>>
  /** Latest verifier results, keyed by verifier-node id. */
  gates: Readonly<Record<string, ReadonlyArray<QualityGateResult>>>
  /** Visited nodes in execution order, with status. */
  history: ReadonlyArray<GraphStep>
}

export type GraphNodeOutput =
  | { kind: 'text'; text: string }
  | { kind: 'gates'; gates: QualityGateResult[]; passed: boolean }
  | { kind: 'parallel'; branches: Record<string, GraphNodeOutput> }
  | { kind: 'human'; approved: boolean; note?: string }
  | { kind: 'retrieval'; hits: RetrievalHit[]; query: string }

export interface GraphStep {
  nodeId: string
  kind: GraphNode['kind']
  status: 'ok' | 'failed'
  startedAt: number
  endedAt: number
  /** Final output snapshot for this step (omitted on failure). */
  output?: GraphNodeOutput
}

/** Async approval response from a human-in-the-loop node. */
export interface HumanResponse {
  approved: boolean
  note?: string
}

export type GraphNode =
  | {
      kind: 'agent'
      id: string
      agent: GraphAgentLike
      /** Build the prompt sent to the agent from current context. Default: ctx.input. */
      prompt?: (ctx: GraphContext) => string
    }
  | {
      kind: 'verifier'
      id: string
      verifier: Verifier
      /** Working directory passed to verifier.verify(). Default: process.cwd(). */
      cwd?: string
    }
  | {
      kind: 'router'
      id: string
      /** Return the id of the next node to visit, or `null` to stop. */
      route: (ctx: GraphContext) => string | null
    }
  | {
      kind: 'parallel'
      id: string
      branches: string[]
      /** 'all' waits for every branch; 'race' resolves on first success. */
      join: 'all' | 'race'
    }
  | {
      kind: 'human'
      id: string
      /**
       * Ask a human (or any IO surface) for an approval decision.
       * Hosts wire this to CLI prompt, web UI, Slack, hook chain, etc.
       */
      ask: (ctx: GraphContext) => Promise<HumanResponse>
    }
  | {
      kind: 'retriever'
      id: string
      retriever: Retriever
      /** How to build the query text from context. Default: ctx.input. */
      query?: (ctx: GraphContext) => string
      /** Top-k hits to request from the retriever. Default: 5. */
      topK?: number
      /** Optional metadata filter passed through to the retriever. */
      where?: Record<string, unknown>
    }

export interface GraphEdge {
  from: string
  to: string
  /** Optional guard. If absent, edge always fires. */
  when?: (ctx: GraphContext) => boolean
}

export interface AgentGraph {
  /** Node id where execution begins. */
  entry: string
  nodes: GraphNode[]
  edges: GraphEdge[]
}

export interface RunGraphOptions {
  /** Hard ceiling on node visits to avoid runaway loops. Default: 64. */
  maxSteps?: number
  /** Per-node revisit cap (cycle protection). Default: 10. */
  maxRevisitsPerNode?: number
  /**
   * Telemetry callback fired after every node finishes (success or skip).
   * Used by hosts to forward to OpenTelemetry, dashboards, or replay buffers.
   * Errors thrown from the callback are swallowed — telemetry must never
   * break a graph run.
   */
  onStep?: (step: GraphStep) => void
  /**
   * Optional TraceStore — if provided, every graph step is also appended as
   * a `graph_step` event. The caller owns `startRun()` / `endRun()`; the
   * runtime only appends. Composes v3.1 Graph DSL + v3.3 Live Tracing.
   */
  trace?: TraceStore
  /**
   * Optional GuardrailRegistry — if provided, the runtime evaluates the
   * `output` scope after every successful agent step. Composes v3.1 Graph
   * DSL + v3.4 Guardrails. Tool-scope evaluations are still owned by the
   * tool dispatcher (graph nodes don't see raw tool calls).
   *
   * If `trace` is also provided, each evaluation is appended as a
   * `guardrail` event automatically.
   */
  guardrails?: GuardrailRegistry
  /**
   * Policy hook invoked when a guardrail evaluation reports
   * `passed=false` (i.e. at least one blocking violation).
   *
   *   - return 'continue' → log only; the run proceeds.
   *   - return 'abort'    → the run terminates with status 'aborted'.
   *   - omit              → default is 'abort' (safe-by-default).
   *
   * The callback is async-friendly. Throwing also aborts.
   */
  onViolation?: (
    evaluation: GuardrailEvaluation,
    step: GraphStep,
  ) => 'continue' | 'abort' | Promise<'continue' | 'abort'>
}

export interface RunGraphResult {
  status: 'completed' | 'aborted'
  /** Reason — only present when status is 'aborted'. */
  reason?: string
  /** Last-visited node id. */
  finalNodeId: string
  /** Final outputs by node id. */
  outputs: Record<string, GraphNodeOutput>
  /** Verifier gate results captured during the run. */
  gates: Record<string, QualityGateResult[]>
  /** Visited nodes, in order. */
  history: GraphStep[]
}
