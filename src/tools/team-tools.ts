/**
 * Team Management Tools
 *
 * TeamCreate, TeamDelete - Multi-agent team coordination.
 * Manages team composition, task lists, and inter-agent messaging.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from '../utils/runtime.js'

/**
 * Team definition.
 */
export interface Team {
  id: string
  name: string
  members: string[]
  leaderId: string
  taskListId?: string
  createdAt: string
  status: 'active' | 'disbanded'
}

interface TeamNamespaceState {
  store: Map<string, Team>
  counter: number
}

const teamNamespaces = new Map<string, TeamNamespaceState>()

function getTeamState(context?: RuntimeNamespaceContext): TeamNamespaceState {
  const namespace = getRuntimeNamespace(context)
  let state = teamNamespaces.get(namespace)
  if (!state) {
    state = { store: new Map(), counter: 0 }
    teamNamespaces.set(namespace, state)
  }
  return state
}

/**
 * Get all teams.
 */
export function getAllTeams(context?: RuntimeNamespaceContext): Team[] {
  return Array.from(getTeamState(context).store.values())
}

/**
 * Get a team by ID.
 */
export function getTeam(id: string, context?: RuntimeNamespaceContext): Team | undefined {
  return getTeamState(context).store.get(id)
}

/**
 * Clear all teams.
 */
export function clearTeams(context?: RuntimeNamespaceContext): void {
  const namespace = getRuntimeNamespace(context)
  if (namespace === 'default') {
    teamNamespaces.clear()
    return
  }
  teamNamespaces.delete(namespace)
}

// ============================================================================
// TeamCreateTool
// ============================================================================

export const TeamCreateTool: ToolDefinition = {
  name: 'TeamCreate',
  description: 'Create a multi-agent team for coordinated work. Assigns a lead and manages member composition.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Team name' },
      members: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of agent/teammate names',
      },
      task_description: { type: 'string', description: 'Description of the team\'s mission' },
    },
    required: ['name'],
  },
  safety: {
    write: true,
    externalState: true,
    approvalRequired: true,
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Create a team for multi-agent coordination.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getTeamState(context)
    const id = `team_${++state.counter}`
    const team: Team = {
      id,
      name: input.name,
      members: input.members || [],
      leaderId: 'self',
      createdAt: new Date().toISOString(),
      status: 'active',
    }
    state.store.set(id, team)

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Team created: ${id} "${team.name}" with ${team.members.length} members`,
    }
  },
}

// ============================================================================
// TeamDeleteTool
// ============================================================================

export const TeamDeleteTool: ToolDefinition = {
  name: 'TeamDelete',
  description: 'Disband a team and clean up resources.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Team ID to disband' },
    },
    required: ['id'],
  },
  safety: {
    write: true,
    externalState: true,
    destructive: true,
    approvalRequired: true,
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Delete/disband a team.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getTeamState(context)
    const team = state.store.get(input.id)
    if (!team) {
      return { type: 'tool_result', tool_use_id: '', content: `Team not found: ${input.id}`, is_error: true }
    }

    team.status = 'disbanded'
    state.store.delete(input.id)

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Team disbanded: ${team.name}`,
    }
  },
}
