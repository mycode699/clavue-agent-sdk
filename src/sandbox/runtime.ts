/**
 * v3.2 Sandbox — CapabilityRegistry runtime (prototype).
 *
 * Pure in-memory issuer/checker. Tokens are minted, optionally revoked, and
 * checked per call. `check()` is the hot path: it walks tokens, applies
 * pattern + capability + freshness + budget rules, and returns the first
 * allowing token while incrementing its usage counter.
 *
 * No I/O, no crypto. Hosts that need cryptographically bearer-checkable
 * tokens wrap this with their own signing layer.
 *
 * @module
 */

import type {
  CapabilityDecision,
  CapabilityName,
  CapabilityRegistryQuery,
  CapabilityToken,
  MintTokenInput,
  ResourcePattern,
} from './types.js'

interface MutableToken extends CapabilityToken {
  usedCount: number
  revoked: boolean
}

function generateTokenId(): string {
  const stamp = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return `cap_${stamp}_${rand}`
}

/**
 * Compile a glob pattern to a tester. Supports `*` (single segment, no '/')
 * and `**` (any segments). Other regex metacharacters are escaped.
 */
export function matchResource(pattern: ResourcePattern, resource: string): boolean {
  if (pattern === '*' || pattern === '**') return true
  // Build regex by escaping then re-allowing wildcards.
  let re = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!
    // `/**` (slash + double-star) is a special token meaning "/", "/x", "/x/y", or empty tail.
    if (ch === '/' && pattern[i + 1] === '*' && pattern[i + 2] === '*') {
      re += '(?:/.*)?'
      i += 2
    } else if (ch === '*' && pattern[i + 1] === '*') {
      re += '.*'
      i += 1
    } else if (ch === '*') {
      re += '[^/]*'
    } else if (/[.+?^${}()|[\]\\]/.test(ch)) {
      re += `\\${ch}`
    } else {
      re += ch
    }
  }
  return new RegExp(`^${re}$`).test(resource)
}

export class CapabilityRegistry {
  private tokens = new Map<string, MutableToken>()

  mint(input: MintTokenInput, id?: string): CapabilityToken {
    if (!input.capability || typeof input.capability !== 'string') {
      throw new Error('mint: capability required')
    }
    if (!input.resource || typeof input.resource !== 'string') {
      throw new Error('mint: resource required')
    }
    const tokenId = id ?? generateTokenId()
    if (this.tokens.has(tokenId)) {
      throw new Error(`mint: token id "${tokenId}" already exists`)
    }
    const token: MutableToken = {
      id: tokenId,
      capability: input.capability,
      resource: input.resource,
      issuedAt: Date.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.maxUses !== undefined ? { maxUses: input.maxUses } : {}),
      usedCount: 0,
      revoked: false,
      ...(input.meta !== undefined ? { meta: { ...input.meta } } : {}),
    }
    this.tokens.set(tokenId, token)
    return cloneToken(token)
  }

  revoke(tokenId: string): boolean {
    const t = this.tokens.get(tokenId)
    if (!t) return false
    if (t.revoked) return false
    t.revoked = true
    return true
  }

  get(tokenId: string): CapabilityToken | undefined {
    const t = this.tokens.get(tokenId)
    return t ? cloneToken(t) : undefined
  }

  list(query: CapabilityRegistryQuery = {}): CapabilityToken[] {
    const now = Date.now()
    const out: CapabilityToken[] = []
    for (const t of this.tokens.values()) {
      if (!query.includeRevoked && t.revoked) continue
      if (!query.includeExpired && t.expiresAt !== undefined && t.expiresAt <= now) continue
      if (query.capability !== undefined && t.capability !== query.capability) continue
      if (query.resource !== undefined && !matchResource(t.resource, query.resource)) continue
      out.push(cloneToken(t))
    }
    return out
  }

  /**
   * Decide whether a (capability, resource) request is allowed.
   *
   * Walks tokens in mint order; first token that is fresh, matching, and
   * within budget wins. The winning token's `usedCount` is incremented as a
   * side-effect — the caller has consumed one slot.
   *
   * Specific reasons are reported only when no token matches at all. If at
   * least one token has the right capability+resource but is stale, the most
   * specific failure reason for that token is returned.
   */
  check(capability: CapabilityName, resource: string): CapabilityDecision {
    const now = Date.now()
    let bestDeny: CapabilityDecision | null = null
    for (const t of this.tokens.values()) {
      if (t.capability !== capability) continue
      if (!matchResource(t.resource, resource)) continue
      // Capability + resource match — now check freshness/budget.
      if (t.revoked) {
        bestDeny = bestDeny ?? { allowed: false, reason: 'revoked' }
        continue
      }
      if (t.expiresAt !== undefined && t.expiresAt <= now) {
        bestDeny = bestDeny ?? { allowed: false, reason: 'expired' }
        continue
      }
      if (t.maxUses !== undefined && t.usedCount >= t.maxUses) {
        bestDeny = bestDeny ?? { allowed: false, reason: 'exhausted' }
        continue
      }
      // Allow: consume one use.
      t.usedCount += 1
      return { allowed: true, tokenId: t.id }
    }
    if (bestDeny) return bestDeny
    // No tokens with right capability at all? capability_mismatch.
    // Otherwise resource_mismatch.
    for (const t of this.tokens.values()) {
      if (t.capability === capability) {
        return { allowed: false, reason: 'resource_mismatch' }
      }
    }
    return { allowed: false, reason: 'capability_mismatch' }
  }

  /** Total number of tokens (including revoked / expired). */
  size(): number {
    return this.tokens.size
  }
}

function cloneToken(t: MutableToken): CapabilityToken {
  return {
    id: t.id,
    capability: t.capability,
    resource: t.resource,
    issuedAt: t.issuedAt,
    ...(t.expiresAt !== undefined ? { expiresAt: t.expiresAt } : {}),
    ...(t.maxUses !== undefined ? { maxUses: t.maxUses } : {}),
    usedCount: t.usedCount,
    revoked: t.revoked,
    ...(t.meta !== undefined ? { meta: { ...t.meta } } : {}),
  }
}
