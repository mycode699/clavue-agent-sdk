/**
 * Graph DSL runtime — the smallest executor that can prove the design works.
 *
 * Algorithm: pure forward-edge traversal driven by node kind.
 *   1. Start at graph.entry.
 *   2. Execute the current node, store its output in ctx.outputs.
 *   3. Pick the next node:
 *        - router    → call route(ctx); a returned id wins, null stops.
 *        - parallel  → fan out branches concurrently, join, then advance via edge.
 *        - default   → first edge whose `when` passes (or has no guard).
 *   4. Stop on no next node, on maxSteps, or when a node is revisited too often.
 *
 * Failure handling: a node throwing rejects the run with status 'aborted'. The
 * caller already has `outputs` / `gates` / `history` up to that point.
 *
 * No retry, no timeout, no telemetry yet — that lands when the prototype graduates
 * out of `src/graph/` into the engine pipeline (v3 final).
 *
 * @module
 */

import type {
  AgentGraph,
  GraphContext,
  GraphEdge,
  GraphNode,
  GraphNodeOutput,
  GraphStep,
  RunGraphOptions,
  RunGraphResult,
} from './types.js'

/** Validate the graph statically. Throws if structure is malformed. */
export function validateGraph(graph: AgentGraph): void {
  if (!graph || typeof graph !== 'object') {
    throw new Error('graph must be an object')
  }
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    throw new Error('graph.nodes must be a non-empty array')
  }
  const ids = new Set<string>()
  for (const node of graph.nodes) {
    if (!node.id || typeof node.id !== 'string') {
      throw new Error('every node must have a non-empty string id')
    }
    if (ids.has(node.id)) {
      throw new Error(`duplicate node id: ${node.id}`)
    }
    ids.add(node.id)
  }
  if (!ids.has(graph.entry)) {
    throw new Error(`graph.entry "${graph.entry}" is not a known node id`)
  }
  if (!Array.isArray(graph.edges)) {
    throw new Error('graph.edges must be an array')
  }
  for (const edge of graph.edges) {
    if (!ids.has(edge.from)) {
      throw new Error(`edge.from "${edge.from}" is not a known node id`)
    }
    if (!ids.has(edge.to)) {
      throw new Error(`edge.to "${edge.to}" is not a known node id`)
    }
  }
  for (const node of graph.nodes) {
    if (node.kind === 'parallel') {
      for (const b of node.branches) {
        if (!ids.has(b)) {
          throw new Error(`parallel node "${node.id}" references unknown branch "${b}"`)
        }
      }
    }
  }
}

function findEntry<T>(map: Record<string, T>, id: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(map, id) ? map[id] : undefined
}

function snapshotContext(
  input: string,
  outputs: Record<string, GraphNodeOutput>,
  gates: Record<string, ReadonlyArray<import('../types.js').QualityGateResult>>,
  history: GraphStep[],
): GraphContext {
  // Defensive shallow freezes; cheap given small graphs.
  return {
    input,
    outputs: { ...outputs },
    gates: { ...gates },
    history: history.slice(),
  }
}

async function executeNode(
  node: GraphNode,
  ctx: GraphContext,
): Promise<GraphNodeOutput> {
  switch (node.kind) {
    case 'agent': {
      const text = node.prompt ? node.prompt(ctx) : ctx.input
      const result = await node.agent.prompt(text)
      return { kind: 'text', text: result.text }
    }
    case 'verifier': {
      const cwd = node.cwd ?? process.cwd()
      const gates = await node.verifier.verify({ cwd })
      const passed = gates.every((g) => g.status === 'passed')
      return { kind: 'gates', gates, passed }
    }
    case 'router': {
      // Router emits no output of its own; the route() callback decides next node.
      return { kind: 'text', text: '' }
    }
    case 'human': {
      const response = await node.ask(ctx)
      return {
        kind: 'human',
        approved: response.approved === true,
        ...(response.note !== undefined ? { note: response.note } : {}),
      }
    }
    case 'retriever': {
      const q = node.query ? node.query(ctx) : ctx.input
      const topK = node.topK ?? 5
      const hits = await node.retriever.retrieve({
        text: q,
        topK,
        ...(node.where !== undefined ? { where: node.where } : {}),
      })
      return { kind: 'retrieval', hits, query: q }
    }
    case 'parallel': {
      // Branches are executed by the runner (it owns history + edges); this branch
      // is a marker — output is filled by runner after fan-out.
      throw new Error('parallel node must be executed by runGraph')
    }
  }
}

function pickNext(
  current: GraphNode,
  ctx: GraphContext,
  edges: GraphEdge[],
  routerDecision?: string | null,
): string | null {
  if (current.kind === 'router') {
    // Router decision already includes "stop" semantics.
    return routerDecision ?? null
  }
  for (const edge of edges) {
    if (edge.from !== current.id) continue
    if (edge.when && !edge.when(ctx)) continue
    return edge.to
  }
  return null
}

/**
 * Run a graph to completion (or maxSteps).
 *
 * Returns a structured RunGraphResult — never throws for graph-level termination
 * (cycles, max steps). Node-thrown errors do propagate so callers see real bugs.
 */
export async function runGraph(
  graph: AgentGraph,
  input: { input: string },
  options: RunGraphOptions = {},
): Promise<RunGraphResult> {
  validateGraph(graph)
  const maxSteps = options.maxSteps ?? 64
  const maxRevisits = options.maxRevisitsPerNode ?? 10
  const onStep = options.onStep
  const trace = options.trace
  const guardrails = options.guardrails
  const onViolation = options.onViolation

  function emit(step: GraphStep): void {
    if (trace) {
      try {
        trace.appendGraphStep(step)
      } catch {
        // Telemetry must never break a run.
      }
    }
    if (!onStep) return
    try {
      onStep(step)
    } catch {
      // Telemetry must never break a run.
    }
  }

  const nodesById: Record<string, GraphNode> = {}
  for (const n of graph.nodes) nodesById[n.id] = n

  const outputs: Record<string, GraphNodeOutput> = {}
  const gates: Record<string, import('../types.js').QualityGateResult[]> = {}
  const history: GraphStep[] = []
  const visitCount: Record<string, number> = {}

  let currentId: string | null = graph.entry
  let lastVisited = currentId
  let stepCount = 0

  while (currentId !== null) {
    if (stepCount >= maxSteps) {
      return {
        status: 'aborted',
        reason: `maxSteps ${maxSteps} reached`,
        finalNodeId: lastVisited,
        outputs,
        gates,
        history,
      }
    }
    visitCount[currentId] = (visitCount[currentId] ?? 0) + 1
    if (visitCount[currentId] > maxRevisits) {
      return {
        status: 'aborted',
        reason: `node "${currentId}" visited more than ${maxRevisits} times (cycle)`,
        finalNodeId: lastVisited,
        outputs,
        gates,
        history,
      }
    }

    const node = findEntry(nodesById, currentId)
    if (!node) {
      return {
        status: 'aborted',
        reason: `unknown node "${currentId}"`,
        finalNodeId: lastVisited,
        outputs,
        gates,
        history,
      }
    }

    const startedAt = Date.now()
    let routerDecision: string | null | undefined
    let stepStatus: 'ok' | 'failed' = 'ok'

    try {
      if (node.kind === 'parallel') {
        const ctx = snapshotContext(input.input, outputs, gates, history)
        const branchOutputs: Record<string, GraphNodeOutput> = {}
        if (node.join === 'all') {
          await Promise.all(
            node.branches.map(async (bid) => {
              const branch = findEntry(nodesById, bid)
              if (!branch) throw new Error(`parallel branch "${bid}" not found`)
              const out = await executeNode(branch, ctx)
              branchOutputs[bid] = out
              outputs[bid] = out
            }),
          )
        } else {
          // 'race' — first resolved wins; record only that branch.
          const winner = await Promise.race(
            node.branches.map(async (bid) => {
              const branch = findEntry(nodesById, bid)
              if (!branch) throw new Error(`parallel branch "${bid}" not found`)
              const out = await executeNode(branch, ctx)
              return { bid, out }
            }),
          )
          branchOutputs[winner.bid] = winner.out
          outputs[winner.bid] = winner.out
        }
        outputs[node.id] = { kind: 'parallel', branches: branchOutputs }
      } else {
        const ctx = snapshotContext(input.input, outputs, gates, history)
        const out = await executeNode(node, ctx)
        outputs[node.id] = out
        if (out.kind === 'gates') gates[node.id] = out.gates
        if (node.kind === 'router') {
          routerDecision = node.route(ctx)
        }
      }
    } catch (err) {
      stepStatus = 'failed'
      const failedStep: GraphStep = {
        nodeId: node.id,
        kind: node.kind,
        status: 'failed',
        startedAt,
        endedAt: Date.now(),
      }
      history.push(failedStep)
      emit(failedStep)
      throw err
    }

    const finalOutput = outputs[node.id]
    const okStep: GraphStep = {
      nodeId: node.id,
      kind: node.kind,
      status: stepStatus,
      startedAt,
      endedAt: Date.now(),
      ...(finalOutput !== undefined ? { output: finalOutput } : {}),
    }
    history.push(okStep)
    emit(okStep)
    lastVisited = node.id

    // Guardrail composition: evaluate `output` scope on agent text outputs.
    // Tool-scope evaluation belongs to the tool dispatcher, not the graph.
    if (guardrails && node.kind === 'agent' && finalOutput?.kind === 'text') {
      const evaluation = await guardrails.evaluate('output', finalOutput.text, {
        agentId: node.id,
      })
      if (trace) {
        try {
          trace.appendGuardrail('output', evaluation, { agentId: node.id })
        } catch {
          // Telemetry must never break a run.
        }
      }
      if (!evaluation.passed) {
        let action: 'continue' | 'abort' = 'abort'
        if (onViolation) {
          try {
            action = await onViolation(evaluation, okStep)
          } catch {
            action = 'abort'
          }
        }
        if (action === 'abort') {
          return {
            status: 'aborted',
            reason: `guardrail violation at "${node.id}": ${evaluation.violations
              .map((v) => v.guardrail)
              .join(', ')}`,
            finalNodeId: lastVisited,
            outputs,
            gates,
            history,
          }
        }
      }
    }

    const ctxAfter = snapshotContext(input.input, outputs, gates, history)
    currentId = pickNext(node, ctxAfter, graph.edges, routerDecision)
    stepCount += 1
  }

  return {
    status: 'completed',
    finalNodeId: lastVisited,
    outputs,
    gates,
    history,
  }
}
