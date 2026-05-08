/**
 * Permission mode classification (data-only).
 *
 * Tool policy creation lives in `./tools.ts` because it depends on
 * `ToolDefinition` and tool safety inspection.
 */

export type PermissionMode =
  | 'trustedAutomation'
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'plan'
  | 'dontAsk'
  | 'auto'

export type PermissionBehavior = 'allow' | 'deny'
