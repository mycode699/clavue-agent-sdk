/**
 * v3.2 Sandbox capability tokens (prototype) — public surface.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.2 section).
 * @module
 */

export type {
  CapabilityDecision,
  CapabilityDenyReason,
  CapabilityName,
  CapabilityRegistryQuery,
  CapabilityToken,
  MintTokenInput,
  ResourcePattern,
} from './types.js'

export { CapabilityRegistry, matchResource } from './runtime.js'
