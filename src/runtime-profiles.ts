import {
  AGENT_JOB_RECORD_SCHEMA_VERSION,
  AGENT_RUN_RESULT_SCHEMA_VERSION,
  AGENT_RUN_TRACE_SCHEMA_VERSION,
  MEMORY_TRACE_SCHEMA_VERSION,
  SDK_EVENT_SCHEMA_VERSION,
  type AgentOptions,
  type ControlledExecutionContract,
  type MemoryConfig,
  type PermissionMode,
  type QualityGatePolicy,
  type ToolsetName,
  type WorkflowMode,
  type RuntimeProfile,
} from './types.js'

export const CONTROLLED_EXECUTION_CONTRACT_VERSION = '1.0.0'

export const CONTROLLED_EXECUTION_CONTRACT_SCHEMA: ControlledExecutionContract = {
  version: CONTROLLED_EXECUTION_CONTRACT_VERSION,
  schemaVersions: {
    sdk_event: SDK_EVENT_SCHEMA_VERSION,
    agent_run_result: AGENT_RUN_RESULT_SCHEMA_VERSION,
    agent_run_trace: AGENT_RUN_TRACE_SCHEMA_VERSION,
    agent_job_record: AGENT_JOB_RECORD_SCHEMA_VERSION,
    memory_trace: MEMORY_TRACE_SCHEMA_VERSION,
  },
  workflowModes: ['collect', 'organize', 'plan', 'solve', 'build', 'verify', 'review', 'ship'],
  messageTypes: ['assistant', 'tool_result', 'result', 'partial_message', 'system'],
  resultFields: ['status', 'subtype', 'text', 'usage', 'events', 'evidence', 'quality_gates', 'trace'],
  traceFields: ['turns', 'tools', 'concurrency_batches', 'tool_concurrency_limit', 'tool_concurrency_source', 'retry_count', 'compaction_count', 'compactions', 'permission_denials', 'policy_decisions', 'memory'],
  profileRequiredFields: ['toolsets_or_allowedTools', 'permissionMode', 'memory.policy.mode', 'qualityGatePolicy.failStatuses', 'appendSystemPrompt'],
}

const workflowProfiles: Record<WorkflowMode, RuntimeProfile> = {
  collect: {
    name: 'collect',
    description: 'Gather source material, resources, files, and user inputs with provenance.',
    toolsets: ['repo-readonly', 'research', 'mcp'],
    permissionMode: 'auto',
    autonomyMode: 'proactive',
    memory: { enabled: true, policy: { mode: 'brainFirst' } },
    qualityGatePolicy: { failStatuses: ['failed'] },
    appendSystemPrompt: 'Workflow mode: collect. Prioritize source collection, citations, provenance, and a concise collection summary.',
  },
  organize: {
    name: 'organize',
    description: 'Turn raw material into tagged notes, summaries, todos, decisions, and open questions.',
    toolsets: ['repo-readonly', 'tasks', 'skills'],
    permissionMode: 'auto',
    autonomyMode: 'proactive',
    memory: { enabled: true, policy: { mode: 'autoInject' } },
    qualityGatePolicy: { failStatuses: ['failed'] },
    appendSystemPrompt: 'Workflow mode: organize. Produce structured notes, tags, decisions, open questions, and follow-up tasks when useful.',
  },
  plan: {
    name: 'plan',
    description: 'Define scope, assumptions, sequence, risks, and verification gates.',
    toolsets: ['repo-readonly', 'planning', 'skills'],
    permissionMode: 'plan',
    autonomyMode: 'supervised',
    memory: { enabled: true, policy: { mode: 'brainFirst' } },
    qualityGatePolicy: { required: ['plan-reviewable'], failStatuses: ['failed'] },
    appendSystemPrompt: 'Workflow mode: plan. Inspect context before planning, keep implementation frozen, and produce acceptance criteria, risks, and verification gates.',
  },
  solve: {
    name: 'solve',
    description: 'Diagnose ambiguous problems through hypotheses, checks, evidence, and a verification path.',
    toolsets: ['repo-readonly', 'research', 'skills'],
    permissionMode: 'auto',
    autonomyMode: 'proactive',
    memory: { enabled: true, policy: { mode: 'brainFirst' } },
    qualityGatePolicy: { failStatuses: ['failed'] },
    appendSystemPrompt: 'Workflow mode: solve. Work hypothesis-first, separate facts from assumptions, and record the verification path.',
  },
  build: {
    name: 'build',
    description: 'Execute a scoped implementation or content change with verification evidence.',
    toolsets: ['repo-edit', 'skills'],
    allowedTools: ['Bash'],
    permissionMode: 'trustedAutomation',
    autonomyMode: 'autonomous',
    memory: { enabled: true, policy: { mode: 'autoInject' } },
    qualityGatePolicy: { failStatuses: ['failed'] },
    appendSystemPrompt: 'Workflow mode: build. Make focused edits, preserve scope, follow existing patterns, and verify concrete behavior before claiming completion.',
  },
  verify: {
    name: 'verify',
    description: 'Prove behavior with tests, builds, checks, review, or manual evidence.',
    toolsets: ['repo-readonly'],
    allowedTools: ['Bash'],
    permissionMode: 'auto',
    autonomyMode: 'proactive',
    memory: { enabled: false, policy: { mode: 'off' } },
    qualityGatePolicy: { required: ['verification-passed'], failStatuses: ['failed'] },
    appendSystemPrompt: 'Workflow mode: verify. Run relevant checks, preserve decisive output, map results to acceptance criteria, and report residual risk.',
  },
  review: {
    name: 'review',
    description: 'Find defects, risks, missing evidence, and weak assumptions.',
    toolsets: ['repo-readonly', 'skills'],
    allowedTools: ['Bash'],
    permissionMode: 'auto',
    autonomyMode: 'proactive',
    memory: { enabled: true, policy: { mode: 'brainFirst' } },
    qualityGatePolicy: { required: ['review-complete'], failStatuses: ['failed'] },
    appendSystemPrompt: 'Workflow mode: review. Prioritize correctness, security, compatibility, performance, and missing verification with concrete file references.',
  },
  ship: {
    name: 'ship',
    description: 'Prepare handoff, release notes, package checks, or final status without publishing unless authorized.',
    toolsets: ['repo-readonly', 'skills'],
    allowedTools: ['Bash'],
    permissionMode: 'auto',
    autonomyMode: 'supervised',
    memory: { enabled: true, policy: { mode: 'autoInject' } },
    qualityGatePolicy: { failStatuses: ['failed'] },
    appendSystemPrompt: 'Workflow mode: ship. Summarize impact, verification, release readiness, known limitations, and do not push, publish, deploy, or tag without authorization.',
  },
}

function unique<T>(values: Array<T | undefined>): T[] {
  return [...new Set(values.filter((value): value is T => value !== undefined))]
}

function mergeMemory(profile: MemoryConfig | undefined, configured: MemoryConfig | undefined): MemoryConfig | undefined {
  if (!profile && !configured) return undefined
  return {
    ...(profile ?? {}),
    ...(configured ?? {}),
    policy: {
      ...(profile?.policy ?? {}),
      ...(configured?.policy ?? {}),
    },
  }
}

function mergeToolsets(profileToolsets: ToolsetName[] | undefined, configuredToolsets: ToolsetName[] | undefined): ToolsetName[] | undefined {
  const merged = unique([...(profileToolsets ?? []), ...(configuredToolsets ?? [])])
  return merged.length > 0 ? merged : undefined
}

function mergeToolNames(profileTools: string[] | undefined, configuredTools: string[] | undefined): string[] | undefined {
  const merged = unique([...(profileTools ?? []), ...(configuredTools ?? [])])
  return merged.length > 0 ? merged : undefined
}

function mergeAppendPrompt(profilePrompt: string | undefined, configuredPrompt: string | undefined): string | undefined {
  if (profilePrompt && configuredPrompt) return `${profilePrompt}\n\n${configuredPrompt}`
  return configuredPrompt ?? profilePrompt
}

export function getRuntimeProfile(mode: WorkflowMode): RuntimeProfile {
  const profile = workflowProfiles[mode]
  if (!profile) throw new Error(`Unknown workflow mode: ${mode}`)
  return {
    ...profile,
    toolsets: profile.toolsets ? [...profile.toolsets] : undefined,
    allowedTools: profile.allowedTools ? [...profile.allowedTools] : undefined,
    disallowedTools: profile.disallowedTools ? [...profile.disallowedTools] : undefined,
    memory: profile.memory ? { ...profile.memory, policy: profile.memory.policy ? { ...profile.memory.policy } : undefined } : undefined,
    qualityGatePolicy: profile.qualityGatePolicy ? { ...profile.qualityGatePolicy } : undefined,
  }
}

export function getAllRuntimeProfiles(): RuntimeProfile[] {
  return (Object.keys(workflowProfiles) as WorkflowMode[]).map(getRuntimeProfile)
}

export function getControlledExecutionContract(): ControlledExecutionContract {
  return {
    ...CONTROLLED_EXECUTION_CONTRACT_SCHEMA,
    schemaVersions: { ...CONTROLLED_EXECUTION_CONTRACT_SCHEMA.schemaVersions },
    workflowModes: [...CONTROLLED_EXECUTION_CONTRACT_SCHEMA.workflowModes],
    messageTypes: [...CONTROLLED_EXECUTION_CONTRACT_SCHEMA.messageTypes],
    resultFields: [...CONTROLLED_EXECUTION_CONTRACT_SCHEMA.resultFields],
    traceFields: [...CONTROLLED_EXECUTION_CONTRACT_SCHEMA.traceFields],
    profileRequiredFields: [...CONTROLLED_EXECUTION_CONTRACT_SCHEMA.profileRequiredFields],
  }
}

export function applyRuntimeProfile<T extends AgentOptions>(options: T): T {
  if (!options.workflowMode) return { ...options }

  const profile = getRuntimeProfile(options.workflowMode)
  return {
    ...options,
    toolsets: mergeToolsets(profile.toolsets, options.toolsets),
    allowedTools: mergeToolNames(profile.allowedTools, options.allowedTools),
    disallowedTools: mergeToolNames(profile.disallowedTools, options.disallowedTools),
    permissionMode: options.permissionMode ?? (profile.permissionMode as PermissionMode | undefined),
    autonomyMode: options.autonomyMode ?? profile.autonomyMode,
    memory: mergeMemory(profile.memory, options.memory),
    qualityGatePolicy: options.qualityGatePolicy ?? (profile.qualityGatePolicy as QualityGatePolicy | undefined),
    appendSystemPrompt: mergeAppendPrompt(profile.appendSystemPrompt, options.appendSystemPrompt),
    maxTurns: options.maxTurns ?? profile.maxTurns,
  }
}
