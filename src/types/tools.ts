/**
 * Tool definition, context, result, safety annotations, and the policy
 * factory used to translate permission modes into runtime tool gates.
 */

import type { Evidence, QualityGateResult } from './evidence.js'
import type { PendingInputQuestion } from './messages.js'
import type { PermissionBehavior, PermissionMode } from './permissions.js'
import type { AgentAutonomyMode } from './runtime.js'
import type { AgentRunPolicyDecisionSource } from './trace.js'

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: ToolInputSchema
  call: (input: any, context: ToolContext) => Promise<ToolResult>
  safety?: ToolSafetyAnnotations
  isReadOnly?: () => boolean
  isConcurrencySafe?: () => boolean
  isEnabled?: (context?: ToolContext) => boolean
  prompt?: (context: ToolContext) => Promise<string>
}

export interface ToolSafetyAnnotations {
  /** Tool only reads local or external state. Defaults to ToolDefinition.isReadOnly() when omitted. */
  read?: boolean
  /** Tool can modify local files, in-memory runtime state, or other local workspace state. */
  write?: boolean
  /** Tool can execute shell commands or arbitrary local processes. */
  shell?: boolean
  /** Tool can call remote network services. */
  network?: boolean
  /** Tool can affect systems outside the local workspace, such as messages, cron, MCP, or remote triggers. */
  externalState?: boolean
  /** Tool can delete, stop, overwrite, or otherwise perform hard-to-reverse operations. */
  destructive?: boolean
  /** Repeating the same call should normally be safe and produce the same effect. */
  idempotent?: boolean
  /** Tool should require explicit approval unless the host selects a high-trust policy. */
  approvalRequired?: boolean
}

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, any>
  required?: string[]
}

export interface ToolContext {
  cwd: string
  /** Root directory that filesystem tools must stay within. Defaults to cwd. */
  workspaceRoot?: string
  abortSignal?: AbortSignal
  /** Isolates module-level tool state for hosts running multiple SDK instances in one process. */
  runtimeNamespace?: string
  /** Tool names available to the current runtime/tool execution turn. */
  availableTools?: string[]
  /** Parent agent's LLM provider (inherited by subagents) */
  provider?: import('../providers/types.js').LLMProvider
  /** Parent agent's model ID */
  model?: string
  /** Parent agent's API type */
  apiType?: import('../providers/types.js').ApiType
  /** Query engine policy inherited by nested agents */
  policy?: ToolPolicy
  /** Parent agent autonomy mode inherited by nested agents */
  autonomyMode?: AgentAutonomyMode
  /** Optional shared file state cache (Slice I): Read populates, Edit verifies stale-ness. */
  fileStateCache?: import('../utils/fileCache.js').FileStateCache
  /**
   * M3 sandbox settings forwarded by the engine. Tools that spawn shell
   * commands (BashTool) wrap their spawn through
   * `sandbox/exec-sandbox.ts` when `sandbox.enabled === true`. Other
   * tools may ignore it.
   */
  sandbox?: import('./sandbox.js').SandboxSettings
}

export interface ToolResult {
  type: 'tool_result'
  tool_use_id: string
  content: string | any[]
  is_error?: boolean
  pending_input?: PendingInputQuestion
  evidence?: Evidence[]
  quality_gates?: QualityGateResult[]
}

// --------------------------------------------------------------------------
// Permission policy
// --------------------------------------------------------------------------

export type CanUseToolResult = {
  behavior: PermissionBehavior
  updatedInput?: unknown
  message?: string
  source?: AgentRunPolicyDecisionSource
}

export type CanUseToolFn = (
  tool: ToolDefinition,
  input: unknown,
) => Promise<CanUseToolResult>

export interface ToolPolicy {
  canUseTool: CanUseToolFn
  permissionMode: PermissionMode
}

/**
 * Build the default tool policy for a given `permissionMode`.
 *
 * The default — `'trustedAutomation'` — is intentionally permissive so the
 * library-first SDK works out of the box. Production hosts SHOULD pass an
 * explicit `permissionMode` (e.g. `'plan'`, `'acceptEdits'`, `'auto'`) and
 * narrow the tool surface via `toolsets`, `allowedTools`, `disallowedTools`,
 * and `canUseTool`. For untrusted prompts, prefer the `'sandboxed'` agent
 * preset, which forces `permissionMode: 'auto'` + `repo-readonly` toolset.
 *
 * See README §"Enforce production controls" for the recommended layering.
 */
export function createDefaultToolPolicy(permissionMode: PermissionMode = 'trustedAutomation'): ToolPolicy {
  const allow = (): CanUseToolResult => ({ behavior: 'allow', source: 'permission_mode' })
  const deny = (tool: ToolDefinition, reason: string): CanUseToolResult => ({
    behavior: 'deny',
    message: `Permission denied for ${tool.name}: ${reason}`,
    source: 'permission_mode',
  })

  return {
    canUseTool: async (tool) => {
      switch (permissionMode) {
        case 'bypassPermissions':
        case 'trustedAutomation':
          return allow()

        case 'plan':
          return isPlanModeAllowedTool(tool)
            ? allow()
            : deny(tool, 'plan mode only allows read-only and planning tools')

        case 'acceptEdits':
          return isAcceptEditsAllowedTool(tool)
            ? allow()
            : deny(tool, 'acceptEdits mode allows local file edits but blocks shell, network, external-state, destructive, or approval-required tools')

        case 'default':
          return isDefaultModeAllowedTool(tool)
            ? allow()
            : deny(tool, 'default mode only allows read-only tools unless the host selects a broader permission mode')

        case 'dontAsk':
        case 'auto':
          return isNonDestructiveTool(tool)
            ? allow()
            : deny(tool, `${permissionMode} mode blocks destructive or approval-required tools`)

        default:
          return allow()
      }
    },
    permissionMode,
  }
}

function getToolSafety(tool: ToolDefinition): Required<Pick<ToolSafetyAnnotations, 'read' | 'write' | 'shell' | 'network' | 'externalState' | 'destructive' | 'approvalRequired'>> & ToolSafetyAnnotations {
  const safety = tool.safety ?? {}
  const read = safety.read ?? tool.isReadOnly?.() === true
  const write = safety.write ?? !read

  return {
    ...safety,
    read,
    write,
    shell: safety.shell ?? false,
    network: safety.network ?? false,
    externalState: safety.externalState ?? false,
    destructive: safety.destructive ?? false,
    approvalRequired: safety.approvalRequired ?? false,
  }
}

function isPlanModeAllowedTool(tool: ToolDefinition): boolean {
  if (tool.isReadOnly?.() === true) return true
  const safety = getToolSafety(tool)
  if (safety.read && !safety.write && !safety.shell && !safety.network && !safety.externalState && !safety.destructive) {
    return true
  }

  return new Set([
    'EnterPlanMode',
    'ExitPlanMode',
    'AskUserQuestion',
    'TodoWrite',
    'Skill',
  ]).has(tool.name)
}

function isAcceptEditsAllowedTool(tool: ToolDefinition): boolean {
  const safety = getToolSafety(tool)
  if (isLocalFileEditTool(tool)) return true
  if (safety.shell || safety.network || safety.externalState || safety.destructive || safety.approvalRequired) {
    return false
  }

  return safety.read || safety.write
}

function isDefaultModeAllowedTool(tool: ToolDefinition): boolean {
  const safety = getToolSafety(tool)
  return safety.read && !safety.shell && !safety.network && !safety.externalState && !safety.destructive && !safety.approvalRequired
}

function isNonDestructiveTool(tool: ToolDefinition): boolean {
  const safety = getToolSafety(tool)
  return !safety.destructive && !safety.approvalRequired
}

function isLocalFileEditTool(tool: ToolDefinition): boolean {
  return new Set(['Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit', 'LSP']).has(tool.name)
}
