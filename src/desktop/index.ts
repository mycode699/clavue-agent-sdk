/**
 * `clavue-agent-sdk/desktop` — cross-platform desktop integration.
 *
 * Opt-in. Not loaded by the SDK root. Host imports explicitly:
 *
 *   import { buildDesktopServer } from 'clavue-agent-sdk/desktop'
 *
 *   const server = buildDesktopServer({ tier: 'safe' })  // or 'automation' / 'all'
 *   const agent = createAgent({
 *     mcpServers: { desktop: server },
 *     allowedTools: [`mcp__desktop__*`],
 *     canUseTool: hostConsentGate,
 *   })
 *
 * Tiers:
 *   safe        → read clipboard, write clipboard, screen capture, file
 *                 search, open path, reveal in finder
 *   automation  → launch app, compose email (draft only), open in browser,
 *                 system notification, AppleScript (macOS), PowerShell (Win)
 *   all         → safe ∪ automation
 *
 * Every automation-tier tool returns a draft / opens UI rather than
 * autonomously acting on the user's behalf (no auto-send email, no auto-post
 * to chat). RPA-style keystroke injection is out of scope — define it
 * yourself if you really need it.
 */

import { createSdkMcpServer, type McpSdkServerConfig } from '../sdk-mcp-server.js'
import type { SdkMcpToolDefinition } from '../tool-helper.js'

import {
  captureScreenTool,
  findFilesTool,
  openPathTool,
  readClipboardTool,
  revealInFinderTool,
  writeClipboardTool,
} from './safe-tools.js'

import {
  composeEmailTool,
  launchAppTool,
  notifyTool,
  openInBrowserTool,
  runAppleScriptTool,
  runPowerShellTool,
} from './automation-tools.js'

export type DesktopTier = 'safe' | 'automation' | 'all'

export interface BuildDesktopServerOptions {
  /** Which tier of tools to include. Default: `'safe'`. */
  tier?: DesktopTier
  /** Override the MCP server name. Default: `'desktop'`. */
  serverName?: string
  /** Override server version. */
  version?: string
  /** Drop tools by name (post-tier filter). */
  exclude?: string[]
  /** Add custom tools alongside the built-ins. */
  extraTools?: SdkMcpToolDefinition<any>[]
}

const SAFE_TOOLS: SdkMcpToolDefinition<any>[] = [
  readClipboardTool,
  writeClipboardTool,
  captureScreenTool,
  findFilesTool,
  openPathTool,
  revealInFinderTool,
]

const AUTOMATION_TOOLS: SdkMcpToolDefinition<any>[] = [
  launchAppTool,
  composeEmailTool,
  openInBrowserTool,
  notifyTool,
  runAppleScriptTool,
  runPowerShellTool,
]

/**
 * Build an in-process MCP server exposing the requested desktop tools.
 */
export function buildDesktopServer(opts: BuildDesktopServerOptions = {}): McpSdkServerConfig {
  const tier = opts.tier ?? 'safe'
  let tools: SdkMcpToolDefinition<any>[]
  if (tier === 'safe') tools = [...SAFE_TOOLS]
  else if (tier === 'automation') tools = [...AUTOMATION_TOOLS]
  else tools = [...SAFE_TOOLS, ...AUTOMATION_TOOLS]

  if (opts.exclude?.length) {
    const drop = new Set(opts.exclude)
    tools = tools.filter((t) => !drop.has(t.name))
  }
  if (opts.extraTools?.length) tools.push(...opts.extraTools)

  return createSdkMcpServer({
    name: opts.serverName ?? 'desktop',
    version: opts.version ?? '0.1.0',
    tools,
  })
}

// Named exports for hosts that want to compose their own MCP server or use
// individual tools standalone (e.g. behind a custom consent gate).
export {
  // safe tier
  readClipboardTool,
  writeClipboardTool,
  captureScreenTool,
  findFilesTool,
  openPathTool,
  revealInFinderTool,
  // automation tier
  launchAppTool,
  composeEmailTool,
  openInBrowserTool,
  notifyTool,
  runAppleScriptTool,
  runPowerShellTool,
}

export { currentPlatform, hasBinary } from './platform.js'
export type { DesktopPlatform } from './platform.js'
