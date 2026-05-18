/**
 * v1-compat trace shim.
 *
 * v2.0 added `pipeline_stages` to AgentRunTrace and bumped
 * `schema_version` to '2.0.0'. Hosts that still consume the v1 schema
 * can call `downgradeTraceToV1` to receive a structurally-identical
 * trace with the new field stripped and the version pinned to '1.0.0'.
 *
 * This shim is published in v2.0 GA and will be removed in v2.1 (see
 * docs/v1_to_v2_pipeline_migration.md).
 */

import type { AgentRunTrace } from '../types/trace.js'

export function downgradeTraceToV1(trace: AgentRunTrace): AgentRunTrace {
  // Shallow clone is enough — v1 consumers ignore unknown nested fields.
  // We only need to strip pipeline_stages and rewrite schema_version.
  const { pipeline_stages: _stripped, ...rest } = trace
  void _stripped
  return {
    ...rest,
    schema_version: '1.0.0',
  }
}
