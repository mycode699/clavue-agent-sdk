/**
 * v3.1 Multi-Agent Graph DSL — public surface.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.1 section).
 * @module
 */

export type {
  AgentGraph,
  GraphAgentLike,
  GraphContext,
  GraphEdge,
  GraphNode,
  GraphNodeOutput,
  GraphStep,
  RunGraphOptions,
  RunGraphResult,
} from './types.js'

export { runGraph, validateGraph } from './runtime.js'
