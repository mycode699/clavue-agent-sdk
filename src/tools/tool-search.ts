/**
 * ToolSearchTool - Discover deferred/lazy-loaded tools
 *
 * Allows the model to search for tools that haven't been loaded yet.
 * Supports keyword search and exact name selection.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import { parseCommaSeparatedList } from '../utils/parsing.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from '../utils/runtime.js'

const deferredToolNamespaces = new Map<string, ToolDefinition[]>()

function getDeferredTools(context?: RuntimeNamespaceContext): ToolDefinition[] {
  return deferredToolNamespaces.get(getRuntimeNamespace(context)) || []
}

/**
 * Set deferred tools available for search.
 */
export function setDeferredTools(
  tools: ToolDefinition[],
  context?: RuntimeNamespaceContext,
): void {
  deferredToolNamespaces.set(getRuntimeNamespace(context), tools)
}

export const ToolSearchTool: ToolDefinition = {
  name: 'ToolSearch',
  description: 'Search for additional tools that may be available but not yet loaded. Use keyword search or exact name selection.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query. Use "select:ToolName" for exact match or keywords for search.',
      },
      max_results: {
        type: 'number',
        description: 'Maximum results to return (default: 5)',
      },
    },
    required: ['query'],
  },
  safety: {
    read: true,
    externalState: true,
    idempotent: true,
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() { return 'Search for available tools.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const { query, max_results = 5 } = input
    const deferredTools = getDeferredTools(context)

    if (deferredTools.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'No deferred tools available.',
      }
    }

    let matches: ToolDefinition[]

    if (query.startsWith('select:')) {
      // Exact name selection
      const names = parseCommaSeparatedList(query.slice(7))
      matches = deferredTools.filter(t => names.includes(t.name))
    } else {
      // Keyword search
      const keywords: string[] = query.toLowerCase().split(/\s+/)
      matches = deferredTools
        .filter(t => {
          const searchText = `${t.name} ${t.description}`.toLowerCase()
          return keywords.some((kw: string) => searchText.includes(kw))
        })
        .slice(0, max_results)
    }

    if (matches.length === 0) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `No tools found matching "${query}"`,
      }
    }

    const lines = matches.map(t =>
      `- ${t.name}: ${t.description.slice(0, 200)}`
    )

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Found ${matches.length} tool(s):\n${lines.join('\n')}`,
    }
  },
}
