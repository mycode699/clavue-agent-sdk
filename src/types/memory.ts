/**
 * Memory and session storage configuration types.
 */

export type MemoryPolicyMode = 'off' | 'autoInject' | 'brainFirst'

export interface MemoryPolicy {
  mode?: MemoryPolicyMode
}

export interface MemoryConfig {
  enabled?: boolean
  dir?: string
  autoInject?: boolean
  policy?: MemoryPolicy
  autoSaveSessionSummary?: boolean
  maxInjectedEntries?: number
  repoPath?: string
}

export interface SessionConfig {
  dir?: string
}
