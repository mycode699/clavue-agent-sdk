/**
 * Subpath barrel: `clavue-agent-sdk/v1-compat`
 *
 * v2.0 trace downgrade shim for hosts that still consume v1 AgentRunTrace.
 * Removed in v2.1. See docs/v1_to_v2_pipeline_migration.md.
 */

export { downgradeTraceToV1 } from '../v1-compat/trace-shim.js'
