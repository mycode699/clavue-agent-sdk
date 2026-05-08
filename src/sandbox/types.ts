/**
 * v3.2 Sandbox — capability token types (prototype).
 *
 * A capability token is a revocable, expiring, use-limited grant for a
 * specific (capability, resource pattern) pair. Peer SDKs only have coarse
 * permission modes / hooks; tokens give per-call, per-resource decisions.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.2 section).
 *
 * @module
 */

/** Logical capability name. Convention: dotted scope, e.g. `fs.read`, `net.fetch`. */
export type CapabilityName = string

/**
 * Pattern for the resource the capability targets.
 *
 *   - `*`  matches a single segment (no `/`).
 *   - `**` matches any number of segments (including `/`).
 *   - everything else is literal.
 *
 * Examples:
 *   `file:///repo/src/**`           → any file under src
 *   `https://api.example.com/**`    → any URL on that host
 *   `cmd:git *`                     → any single-arg git command
 */
export type ResourcePattern = string

export interface MintTokenInput {
  /** Logical capability name, e.g. 'fs.read'. */
  capability: CapabilityName
  /** Resource glob; `*` for everything is allowed but discouraged. */
  resource: ResourcePattern
  /** Absolute epoch-ms expiry. Omit for non-expiring (still revocable). */
  expiresAt?: number
  /** Hard cap on `check()` allow decisions. Omit for unlimited. */
  maxUses?: number
  /** Free-form attribution. Stored verbatim, useful for trace/audit. */
  meta?: Record<string, unknown>
}

export interface CapabilityToken {
  readonly id: string
  readonly capability: CapabilityName
  readonly resource: ResourcePattern
  readonly issuedAt: number
  readonly expiresAt?: number
  readonly maxUses?: number
  readonly usedCount: number
  readonly revoked: boolean
  readonly meta?: Record<string, unknown>
}

export type CapabilityDenyReason =
  | 'unknown_token'
  | 'revoked'
  | 'expired'
  | 'exhausted'
  | 'capability_mismatch'
  | 'resource_mismatch'

export interface CapabilityDecision {
  allowed: boolean
  /** Set when `allowed=false`. */
  reason?: CapabilityDenyReason
  /** Set when `allowed=true`; the token id that satisfied the request. */
  tokenId?: string
}

export interface CapabilityRegistryQuery {
  capability?: CapabilityName
  /** Match tokens whose `resource` pattern would accept this concrete resource. */
  resource?: string
  includeRevoked?: boolean
  includeExpired?: boolean
}
