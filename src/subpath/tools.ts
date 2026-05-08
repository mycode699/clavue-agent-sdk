/**
 * Subpath barrel: `clavue-agent-sdk/tools`
 *
 * Tool catalog + tool-helper API. Pulls only the tool surface so callers
 * building custom agents do not import the entire SDK.
 */

export { tool, sdkToolToToolDefinition } from '../tool-helper.js'
export type {
  ToolAnnotations,
  CallToolResult,
  SdkMcpToolDefinition,
} from '../tool-helper.js'

export { createSdkMcpServer, isSdkServerConfig } from '../sdk-mcp-server.js'
export type { McpSdkServerConfig } from '../sdk-mcp-server.js'

// Built-in tool catalog (re-exported from src/tools/index.ts)
export * from '../tools/index.js'
