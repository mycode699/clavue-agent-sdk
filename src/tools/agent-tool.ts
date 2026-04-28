/**
 * AgentTool - Spawn subagents for parallel/delegated work
 *
 * Supports built-in agents (Explore, Plan) and custom agent definitions.
 * Agents run as nested query loops with their own context and tool sets.
 */

import type { ToolDefinition, ToolContext, ToolResult, AgentDefinition } from '../types.js'
import { createDefaultToolPolicy } from '../types.js'
import { formatImageBlockForText } from '../utils/messages.js'
import { QueryEngine } from '../engine.js'
import { getAllBaseTools, filterTools } from './index.js'
import { createProvider, type ApiType } from '../providers/index.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from '../utils/runtime.js'

const agentDefinitionNamespaces = new Map<string, Record<string, AgentDefinition>>()

function getRegisteredAgents(context?: RuntimeNamespaceContext): Record<string, AgentDefinition> {
  return agentDefinitionNamespaces.get(getRuntimeNamespace(context)) || {}
}

export function getRegisteredAgentDefinitions(
  context?: RuntimeNamespaceContext,
): Record<string, AgentDefinition> {
  return { ...getRegisteredAgents(context) }
}

/**
 * Register agent definitions for the AgentTool to use.
 */
export function registerAgents(
  agents: Record<string, AgentDefinition>,
  context?: RuntimeNamespaceContext,
): void {
  const namespace = getRuntimeNamespace(context)
  agentDefinitionNamespaces.set(namespace, {
    ...getRegisteredAgents(context),
    ...agents,
  })
}

/**
 * Clear registered agents.
 */
export function clearAgents(context?: RuntimeNamespaceContext): void {
  const namespace = getRuntimeNamespace(context)
  if (namespace === 'default') {
    agentDefinitionNamespaces.clear()
    return
  }
  agentDefinitionNamespaces.delete(namespace)
}

/**
 * Built-in agent definitions.
 */
const BUILTIN_AGENTS: Record<string, AgentDefinition> = {
  Explore: {
    description: 'Fast agent for exploring codebases. Use for finding files, searching code, and answering questions about the codebase.',
    prompt: 'You are a codebase exploration agent. Search through files and code to answer questions. Be thorough but efficient. Use Glob to find files, Grep to search content, and Read to examine files.',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
  },
  Plan: {
    description: 'Software architect agent for designing implementation plans. Returns step-by-step plans and identifies critical files.',
    prompt: 'You are a software architect. Design implementation plans for the given task. Identify critical files, consider trade-offs, and provide step-by-step plans. Use search tools to understand the codebase before planning.',
    tools: ['Read', 'Glob', 'Grep', 'Bash'],
  },
}

export const AgentTool: ToolDefinition = {
  name: 'Agent',
  description: 'Launch a subagent to handle complex, multi-step tasks autonomously. Subagents have their own context and can run specialized tool sets.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The task for the agent to perform',
      },
      description: {
        type: 'string',
        description: 'A short (3-5 word) description of the task',
      },
      subagent_type: {
        type: 'string',
        description: 'The type of agent to use (e.g., "Explore", "Plan", or a custom agent name)',
      },
      model: {
        type: 'string',
        description: 'Optional model override for this agent',
      },
      name: {
        type: 'string',
        description: 'Name for the spawned agent',
      },
      run_in_background: {
        type: 'boolean',
        description: 'Whether to run in background',
      },
    },
    required: ['prompt', 'description'],
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() {
    return 'Launch a subagent to handle complex tasks autonomously.'
  },
  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const agentType = input.subagent_type || 'general-purpose'

    // Find agent definition
    const registeredAgents = getRegisteredAgents(context)
    const agentDef = registeredAgents[agentType] || BUILTIN_AGENTS[agentType]

    // Determine tools for subagent
    let tools = getAllBaseTools()
    if (agentDef?.tools) {
      tools = filterTools(tools, agentDef.tools)
    }

    // Remove AgentTool from subagent to prevent infinite recursion
    tools = tools.filter(t => t.name !== 'Agent')

    // Inherit provider and model from parent agent context, fall back to env vars
    const subModel = input.model || context.model || process.env.CLAVUE_AGENT_MODEL || 'claude-sonnet-4-6'
    const provider = context.provider ?? createProvider(
      (context.apiType || process.env.CLAVUE_AGENT_API_TYPE as ApiType) || 'anthropic-messages',
      {
        apiKey: process.env.CLAVUE_AGENT_API_KEY,
        baseURL: process.env.CLAVUE_AGENT_BASE_URL,
      },
    )

    const policy = context.policy ?? createDefaultToolPolicy()
    // Create subagent engine
    const engine = new QueryEngine({
      cwd: context.cwd,
      model: subModel,
      provider,
      tools,
      appendSystemPrompt: agentDef?.prompt,
      initialPrompt: input.prompt,
      maxTurns: agentDef?.maxTurns || 10,
      maxTokens: 16384,
      policy,
      includePartialMessages: false,
      agents: registeredAgents,
      runtimeNamespace: context.runtimeNamespace,
    })

    // Run the subagent
    let finalResult = ''
    let lastAssistantText = ''
    const toolCalls: string[] = []

    try {
      for await (const event of engine.submitMessage(input.prompt)) {
        if (event.type === 'assistant') {
          const fragments: string[] = []
          for (const block of event.message.content) {
            if (block.type === 'text' && block.text.trim()) {
              fragments.push(block.text)
            } else if (block.type === 'image') {
              fragments.push(formatImageBlockForText(block))
            }
            if ('name' in block && typeof block.name === 'string') {
              toolCalls.push(block.name)
            }
          }
          if (fragments.length > 0) {
            lastAssistantText = fragments.join('\n')
          }
        } else if (event.type === 'result' && event.result?.trim()) {
          finalResult = event.result
        }
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Subagent error: ${err.message}`,
        is_error: true,
      }
    }

    const output = finalResult || lastAssistantText || '(Subagent completed with no text output)'
    const uniqueToolCalls = [...new Set(toolCalls)]
    const displayedTools = uniqueToolCalls.slice(0, 10)
    const toolSummary = displayedTools.length > 0
      ? `\n[Tools used: ${displayedTools.join(', ')}${uniqueToolCalls.length > displayedTools.length ? `, ...${uniqueToolCalls.length - displayedTools.length} more` : ''}]`
      : ''

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: output + toolSummary,
    }
  },
}
