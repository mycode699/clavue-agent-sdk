/**
 * ConfigTool - Dynamic configuration management
 *
 * Get/set global configuration and session settings.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from '../utils/runtime.js'

const configNamespaces = new Map<string, Map<string, unknown>>()

function getConfigStore(context?: RuntimeNamespaceContext): Map<string, unknown> {
  const namespace = getRuntimeNamespace(context)
  let store = configNamespaces.get(namespace)
  if (!store) {
    store = new Map()
    configNamespaces.set(namespace, store)
  }
  return store
}

/**
 * Get a config value.
 */
export function getConfig(key: string, context?: RuntimeNamespaceContext): unknown {
  return getConfigStore(context).get(key)
}

/**
 * Set a config value.
 */
export function setConfig(key: string, value: unknown, context?: RuntimeNamespaceContext): void {
  getConfigStore(context).set(key, value)
}

/**
 * Clear all config.
 */
export function clearConfig(context?: RuntimeNamespaceContext): void {
  const namespace = getRuntimeNamespace(context)
  if (namespace === 'default') {
    configNamespaces.clear()
    return
  }
  configNamespaces.delete(namespace)
}

export const ConfigTool: ToolDefinition = {
  name: 'Config',
  description: 'Get or set configuration values. Supports session-scoped settings.',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['get', 'set', 'list'],
        description: 'Operation to perform',
      },
      key: { type: 'string', description: 'Config key' },
      value: { description: 'Config value (for set)' },
    },
    required: ['action'],
  },
  safety: {
    read: true,
    write: true,
    externalState: true,
    approvalRequired: true,
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Manage configuration settings.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const configStore = getConfigStore(context)
    switch (input.action) {
      case 'get': {
        if (!input.key) {
          return { type: 'tool_result', tool_use_id: '', content: 'key required for get', is_error: true }
        }
        const value = configStore.get(input.key)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: value !== undefined ? JSON.stringify(value) : `Config key "${input.key}" not found`,
        }
      }
      case 'set': {
        if (!input.key) {
          return { type: 'tool_result', tool_use_id: '', content: 'key required for set', is_error: true }
        }
        configStore.set(input.key, input.value)
        return {
          type: 'tool_result',
          tool_use_id: '',
          content: `Config set: ${input.key} = ${JSON.stringify(input.value)}`,
        }
      }
      case 'list': {
        const entries = Array.from(configStore.entries())
        if (entries.length === 0) {
          return { type: 'tool_result', tool_use_id: '', content: 'No config values set.' }
        }
        const lines = entries.map(([k, v]) => `${k} = ${JSON.stringify(v)}`)
        return { type: 'tool_result', tool_use_id: '', content: lines.join('\n') }
      }
      default:
        return { type: 'tool_result', tool_use_id: '', content: `Unknown action: ${input.action}`, is_error: true }
    }
  },
}
