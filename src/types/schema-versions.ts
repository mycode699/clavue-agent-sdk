/**
 * Public schema version constants for runtime introspection.
 */

export const SDK_EVENT_SCHEMA_VERSION = '1.0.0'
export const AGENT_RUN_RESULT_SCHEMA_VERSION = '1.0.0'
export const AGENT_RUN_TRACE_SCHEMA_VERSION = '2.0.0'
export const AGENT_JOB_RECORD_SCHEMA_VERSION = '1.0.0'
export const MEMORY_TRACE_SCHEMA_VERSION = '1.0.0'

export interface PublicSchemaVersions {
  sdk_event: string
  agent_run_result: string
  agent_run_trace: string
  agent_job_record: string
  memory_trace: string
}
