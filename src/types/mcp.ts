/**
 * MCP server configuration shapes.
 */

export type McpServerConfig =
  | McpStdioConfig
  | McpSseConfig
  | McpHttpConfig

export interface McpStdioConfig {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export interface McpSseConfig {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpHttpConfig {
  type: 'http'
  url: string
  headers?: Record<string, string>
}
