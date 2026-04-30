/**
 * Plan Mode Tools
 *
 * EnterPlanMode / ExitPlanMode - Structured planning workflow.
 * Allows the agent to enter a design/planning phase before execution.
 */

import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import { getRuntimeNamespace, type RuntimeNamespaceContext } from '../utils/runtime.js'

interface PlanNamespaceState {
  active: boolean
  currentPlan: string | null
}

const planNamespaces = new Map<string, PlanNamespaceState>()

function getPlanState(context?: RuntimeNamespaceContext): PlanNamespaceState {
  const namespace = getRuntimeNamespace(context)
  let state = planNamespaces.get(namespace)
  if (!state) {
    state = { active: false, currentPlan: null }
    planNamespaces.set(namespace, state)
  }
  return state
}

export function isPlanModeActive(context?: RuntimeNamespaceContext): boolean {
  return getPlanState(context).active
}

export function getCurrentPlan(context?: RuntimeNamespaceContext): string | null {
  return getPlanState(context).currentPlan
}

export const EnterPlanModeTool: ToolDefinition = {
  name: 'EnterPlanMode',
  description: 'Enter plan/design mode for complex tasks. In plan mode, the agent focuses on designing the approach before executing.',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  safety: {
    write: true,
    externalState: true,
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Enter plan mode for structured planning.' },
  async call(_input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getPlanState(context)
    if (state.active) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Already in plan mode.',
      }
    }

    state.active = true
    state.currentPlan = null

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: 'Entered plan mode. Design your approach before executing. Use ExitPlanMode when the plan is ready.',
    }
  },
}

export const ExitPlanModeTool: ToolDefinition = {
  name: 'ExitPlanMode',
  description: 'Exit plan mode with a completed plan. The plan will be recorded and execution can proceed.',
  inputSchema: {
    type: 'object',
    properties: {
      plan: { type: 'string', description: 'The completed plan' },
      approved: { type: 'boolean', description: 'Whether the plan is approved for execution' },
    },
  },
  safety: {
    write: true,
    externalState: true,
  },
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
  async prompt() { return 'Exit plan mode with a completed plan.' },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const state = getPlanState(context)
    if (!state.active) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Not in plan mode.',
        is_error: true,
      }
    }

    state.active = false
    state.currentPlan = input.plan || null

    const status = input.approved !== false ? 'approved' : 'pending approval'

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: `Plan mode exited. Plan status: ${status}.${state.currentPlan ? `\n\nPlan:\n${state.currentPlan}` : ''}`,
    }
  },
}
