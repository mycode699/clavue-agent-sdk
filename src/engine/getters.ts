/**
 * Defensive copy helpers for QueryEngine accessor methods.
 *
 * These were inlined on the QueryEngine class but never used any private
 * state beyond their primary input — moving them out of engine.ts trims
 * ~120 LoC and keeps the agentic loop in engine.ts focused on the pipeline.
 */

import type {
  AgentRunMemorySelectionTrace,
  AgentRunMemoryTrace,
  AgentRunTrace,
  Evidence,
  QualityGateResult,
  TokenUsage,
} from '../types.js'

export function cloneUsage(usage: TokenUsage): TokenUsage {
  return { ...usage }
}

export function cloneModelUsage(
  modelUsage: Record<string, { input_tokens: number; output_tokens: number }>,
): Record<string, { input_tokens: number; output_tokens: number }> {
  const out: Record<string, { input_tokens: number; output_tokens: number }> = {}
  for (const [model, value] of Object.entries(modelUsage)) {
    out[model] = { ...value }
  }
  return out
}

export function cloneEvidence(evidence: Evidence[]): Evidence[] {
  return evidence.map((entry) => {
    const copy: Evidence = { ...entry }
    if (entry.metadata) copy.metadata = { ...entry.metadata }
    return copy
  })
}

export function cloneQualityGates(gates: QualityGateResult[]): QualityGateResult[] {
  return gates.map((gate) => {
    const copy: QualityGateResult = { ...gate }
    if (gate.evidence) {
      copy.evidence = gate.evidence.map((entry) => {
        const evidenceCopy: Evidence = { ...entry }
        if (entry.metadata) evidenceCopy.metadata = { ...entry.metadata }
        return evidenceCopy
      })
    }
    if (gate.metadata) copy.metadata = { ...gate.metadata }
    return copy
  })
}

export function cloneTrace(trace: AgentRunTrace): AgentRunTrace {
  return {
    schema_version: trace.schema_version,
    turns: trace.turns.map((turn) => ({ ...turn })),
    tools: trace.tools.map((tool) => ({ ...tool })),
    concurrency_batches: [...trace.concurrency_batches],
    tool_concurrency_limit: trace.tool_concurrency_limit,
    tool_concurrency_source: trace.tool_concurrency_source,
    retry_count: trace.retry_count,
    compaction_count: trace.compaction_count,
    compactions: trace.compactions?.map((compaction) => ({ ...compaction })),
    permission_denials: trace.permission_denials.map((denial) => ({ ...denial })),
    policy_decisions: (trace.policy_decisions ?? []).map((decision) => ({
      ...decision,
      input_summary: {
        ...decision.input_summary,
        keys: decision.input_summary.keys ? [...decision.input_summary.keys] : undefined,
      },
      updated_input_summary: decision.updated_input_summary
        ? {
            ...decision.updated_input_summary,
            keys: decision.updated_input_summary.keys
              ? [...decision.updated_input_summary.keys]
              : undefined,
          }
        : undefined,
      safety: { ...decision.safety },
    })),
    memory: trace.memory?.map((entry) => {
      const memoryEntry: AgentRunMemoryTrace = {
        ...entry,
        selected_ids: [...entry.selected_ids],
        selected: entry.selected?.map((selection) => {
          const selectionCopy: AgentRunMemorySelectionTrace = { ...selection }
          if (selection.score_reasons) selectionCopy.score_reasons = [...selection.score_reasons]
          if (selection.score_components)
            selectionCopy.score_components = selection.score_components.map((c) => ({ ...c }))
          if (selection.matched_fields) selectionCopy.matched_fields = [...selection.matched_fields]
          if (selection.tags) selectionCopy.tags = [...selection.tags]
          return selectionCopy
        }),
        retrieval_steps: entry.retrieval_steps?.map((step) => {
          const stepCopy = { ...step }
          if (step.filters) {
            stepCopy.filters = { ...step.filters }
            if (step.filters.tags) stepCopy.filters.tags = [...step.filters.tags]
          }
          return stepCopy
        }),
      }
      if (entry.filters) {
        memoryEntry.filters = { ...entry.filters }
        if (entry.filters.tags) memoryEntry.filters.tags = [...entry.filters.tags]
      }
      if (entry.store) memoryEntry.store = { ...entry.store }
      return memoryEntry
    }),
    tool_cache: trace.tool_cache ? { ...trace.tool_cache } : undefined,
    tool_concurrency_adaptive: trace.tool_concurrency_adaptive
      ? {
          ...trace.tool_concurrency_adaptive,
          adjustments: trace.tool_concurrency_adaptive.adjustments.map((a) => ({ ...a })),
        }
      : undefined,
    pipeline_stages: trace.pipeline_stages
      ? Object.fromEntries(
          Object.entries(trace.pipeline_stages).map(([k, v]) => [k, { ...v }]),
        )
      : undefined,
  }
}
