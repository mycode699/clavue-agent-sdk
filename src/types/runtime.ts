/**
 * Runtime profiles, workflow modes, autonomy levels, controlled execution
 * contract, and doctor/benchmark/self-improvement diagnostics.
 */

import type { PublicSchemaVersions } from './schema-versions.js'
import type { QualityGatePolicy } from './evidence.js'
import type { MemoryConfig, SessionConfig } from './memory.js'
import type { PermissionMode } from './permissions.js'
import type { ToolDefinition } from './tools.js'
import type { McpServerConfig } from './mcp.js'

export type ToolsetName =
  | 'repo-readonly'
  | 'repo-edit'
  | 'research'
  | 'planning'
  | 'tasks'
  | 'automation'
  | 'agents'
  | 'mcp'
  | 'skills'

export type WorkflowMode =
  | 'collect'
  | 'organize'
  | 'plan'
  | 'solve'
  | 'build'
  | 'verify'
  | 'review'
  | 'ship'

export type AgentAutonomyMode =
  | 'supervised'
  | 'proactive'
  | 'autonomous'

export interface RuntimeProfile {
  name: WorkflowMode
  description: string
  toolsets?: ToolsetName[]
  allowedTools?: string[]
  disallowedTools?: string[]
  permissionMode?: PermissionMode
  autonomyMode?: AgentAutonomyMode
  memory?: MemoryConfig
  qualityGatePolicy?: QualityGatePolicy
  appendSystemPrompt?: string
  maxTurns?: number
}

export interface ControlledExecutionContract {
  version: string
  schemaVersions: PublicSchemaVersions
  workflowModes: WorkflowMode[]
  messageTypes: string[]
  resultFields: string[]
  traceFields: string[]
  profileRequiredFields: string[]
}

// --------------------------------------------------------------------------
// Setting sources
// --------------------------------------------------------------------------

export type SettingSource = 'user' | 'project' | 'local'

// --------------------------------------------------------------------------
// Model info
// --------------------------------------------------------------------------

export interface ModelInfo {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ('low' | 'medium' | 'high' | 'max')[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
}

// --------------------------------------------------------------------------
// Doctor / health check
// --------------------------------------------------------------------------

export type DoctorCheckStatus = 'ok' | 'warn' | 'error' | 'skipped'

export type DoctorCheckCategory =
  | 'provider'
  | 'tools'
  | 'skills'
  | 'mcp'
  | 'storage'
  | 'package'
  | 'contracts'

export interface DoctorCheck {
  name: string
  category: DoctorCheckCategory
  status: DoctorCheckStatus
  message: string
  details?: Record<string, unknown>
}

export interface DoctorReport {
  status: Exclude<DoctorCheckStatus, 'skipped'>
  checked_at: string
  cwd: string
  summary: Record<DoctorCheckStatus, number>
  checks: DoctorCheck[]
}

export interface DoctorOptions {
  workflowMode?: WorkflowMode
  cwd?: string
  model?: string
  apiType?: import('../providers/types.js').ApiType
  apiKey?: string
  baseURL?: string
  env?: Record<string, string | undefined>
  tools?: ToolDefinition[] | string[] | { type: 'preset'; preset: 'default' }
  toolsets?: ToolsetName[]
  allowedTools?: string[]
  disallowedTools?: string[]
  mcpServers?: Record<string, McpServerConfig | any>
  memory?: MemoryConfig
  session?: SessionConfig
  agentJobs?: { dir?: string; runtimeNamespace?: string; staleAfterMs?: number }
  runtimeNamespace?: string
  initializeBundledSkills?: boolean
  checkPackageEntrypoints?: boolean
  packageRoot?: string
}

// --------------------------------------------------------------------------
// Benchmark
// --------------------------------------------------------------------------

export type BenchmarkMetricName =
  | 'readOnlyFanOut'
  | 'serialMutationOrdering'
  | 'contextBuild'
  | 'runtimeProfileResolve'
  | 'memoryQuery'
  | 'agentJobStorage'

export interface BenchmarkMetric {
  name: BenchmarkMetricName
  iterations: number
  total_ms: number
  mean_ms: number
  min_ms: number
  max_ms: number
  metadata?: Record<string, unknown>
}

export interface BenchmarkReport {
  id: string
  started_at: string
  completed_at: string
  duration_ms: number
  cwd: string
  metrics: BenchmarkMetric[]
}

export interface BenchmarkOptions {
  cwd?: string
  iterations?: number
  memory?: MemoryConfig
  agentJobs?: { dir?: string; runtimeNamespace?: string }
}

// --------------------------------------------------------------------------
// Self-improvement
// --------------------------------------------------------------------------

export interface SelfImprovementMemoryConfig {
  enabled?: boolean
  dir?: string
  repoPath?: string
  maxEntriesPerRun?: number
  captureSuccessfulRuns?: boolean
}

export interface SelfImprovementRetroLoopConfig {
  enabled?: boolean
  maxAttempts?: number
  retryPrompt?: string
}

export interface SelfImprovementRetroConfig {
  enabled?: boolean
  targetName?: string
  cwd?: string
  gates?: import('../retro/types.js').RetroQualityGate[]
  policy?: import('../retro/types.js').RetroPolicy
  ledger?: import('../retro/types.js').RetroLedgerOptions
  loop?: SelfImprovementRetroLoopConfig
  skills?: import('../retro/skill-evaluators.js').SkillRetroTarget[]
}

export interface SelfImprovementConfig {
  enabled?: boolean
  memory?: SelfImprovementMemoryConfig
  retro?: SelfImprovementRetroConfig
}

export interface AgentSelfImprovementResult {
  savedMemories: import('../memory.js').MemoryEntry[]
  retroCycle?: import('../retro/types.js').RetroCycleResult
  retroLoop?: import('../retro/types.js').RetroLoopResult
  errors?: string[]
}
