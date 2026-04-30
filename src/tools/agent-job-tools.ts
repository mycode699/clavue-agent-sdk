import type { ToolDefinition, ToolContext, ToolResult } from '../types.js'
import {
  getAgentJob,
  listAgentJobs,
  stopAgentJob,
} from '../agent-jobs.js'

function jobStoreContext(context?: ToolContext): { runtimeNamespace?: string } {
  return { runtimeNamespace: context?.runtimeNamespace }
}

export const AgentJobListTool: ToolDefinition = {
  name: 'AgentJobList',
  description: 'List background subagent jobs for the current runtime namespace.',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: 'Optional status filter' },
    },
  },
  safety: {
    read: true,
    externalState: true,
    idempotent: true,
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return 'List background subagent jobs and their current status.'
  },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    let jobs = await listAgentJobs(jobStoreContext(context))
    if (input.status) {
      jobs = jobs.filter((job) => job.status === input.status)
    }

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify(jobs, null, 2),
    }
  },
}

export const AgentJobGetTool: ToolDefinition = {
  name: 'AgentJobGet',
  description: 'Get full details for a background subagent job.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background job ID' },
    },
    required: ['id'],
  },
  safety: {
    read: true,
    externalState: true,
    idempotent: true,
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return 'Inspect a background subagent job by ID.'
  },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const job = await getAgentJob(input.id, jobStoreContext(context))
    if (!job) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Agent job not found: ${input.id}`,
        is_error: true,
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify(job, null, 2),
    }
  },
}

export const AgentJobStopTool: ToolDefinition = {
  name: 'AgentJobStop',
  description: 'Cancel a running or queued background subagent job.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Background job ID' },
      reason: { type: 'string', description: 'Optional cancellation reason' },
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
  isConcurrencySafe: () => true,
  isEnabled: () => true,
  async prompt() {
    return 'Cancel a background subagent job.'
  },
  async call(input: any, context?: ToolContext): Promise<ToolResult> {
    const job = await stopAgentJob(input.id, input.reason, jobStoreContext(context))
    if (!job) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Agent job not found: ${input.id}`,
        is_error: true,
      }
    }

    return {
      type: 'tool_result',
      tool_use_id: '',
      content: JSON.stringify(job, null, 2),
    }
  },
}
