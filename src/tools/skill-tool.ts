/**
 * Skill Tool
 *
 * Allows the model to invoke registered skills by name.
 * Skills are prompt templates that provide specialized capabilities.
 */

import type { ToolDefinition, ToolResult, ToolContext } from '../types.js'
import { formatSkillsForPrompt, getSkill, getUserInvocableSkills } from '../skills/registry.js'
import { formatImageBlockForText } from '../utils/messages.js'
import { createAgentJob, runAgentJob } from '../agent-jobs.js'
import { runAgentSubagent } from './agent-tool.js'

export const SkillTool: ToolDefinition = {
  name: 'Skill',
  description:
    'Execute a skill within the current conversation. ' +
    'Skills provide specialized capabilities and domain knowledge. ' +
    'Use this tool with the skill name and optional arguments. ' +
    'Available skills are listed in system-reminder messages.',
  inputSchema: {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill name to execute (e.g., "commit", "review", "simplify")',
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill',
      },
    },
    required: ['skill'],
  },

  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  isEnabled: (context?: ToolContext) => getUserInvocableSkills(context).length > 0,

  async prompt(context: ToolContext): Promise<string> {
    const skillListing = formatSkillsForPrompt(undefined, context)
    if (!skillListing) return ''

    return (
      'Execute a skill within the main conversation.\n\n' +
      'Available skills:\n' +
      skillListing +
      '\n\nWhen a skill matches the user\'s request, invoke it using the Skill tool.'
    )
  },

  async call(input: any, context: ToolContext): Promise<ToolResult> {
    const skillName: string = input.skill
    const args: string = input.args || ''

    if (!skillName) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: 'Error: skill name is required',
        is_error: true,
      }
    }

    const skill = getSkill(skillName, context)
    if (!skill) {
      const available = getUserInvocableSkills(context)
        .map((s) => s.name)
        .join(', ')
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: Unknown skill "${skillName}". Available skills: ${available || 'none'}`,
        is_error: true,
      }
    }

    // Check if skill is enabled
    if (skill.isEnabled && !skill.isEnabled(context)) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error: Skill "${skillName}" is currently disabled`,
        is_error: true,
      }
    }

    try {
      // Get skill prompt
      const contentBlocks = await skill.getPrompt(args, context)

      // Convert content blocks to text
      const promptText = contentBlocks
        .map((b) => b.type === 'text' ? b.text : formatImageBlockForText(b))
        .join('\n\n')

      if (skill.context === 'fork') {
        const job = await createAgentJob({
          kind: 'subagent',
          prompt: promptText,
          description: `Skill ${skill.name}`,
          subagent_type: skill.agent || 'general-purpose',
          model: skill.model,
          allowedTools: skill.allowedTools,
        }, { runtimeNamespace: context.runtimeNamespace })

        runAgentJob(job.id, (signal) => runAgentSubagent({
          input: {
            prompt: promptText,
            description: `Skill ${skill.name}`,
            subagent_type: skill.agent || 'general-purpose',
            model: skill.model,
          },
          context,
          abortSignal: signal,
          allowedTools: skill.allowedTools,
          appendSystemPrompt: promptText,
        }), { runtimeNamespace: context.runtimeNamespace })

        return {
          type: 'tool_result',
          tool_use_id: '',
          content: JSON.stringify({
            type: 'clavue.skill.activation',
            version: 1,
            success: true,
            skillName: skill.name,
            commandName: skill.name,
            status: 'forked',
            job_id: job.id,
            agent: skill.agent || 'general-purpose',
            prompt: promptText,
            allowedTools: skill.allowedTools,
            model: skill.model,
          }),
        }
      }

      // Build result with metadata
      const result: Record<string, unknown> = {
        type: 'clavue.skill.activation',
        version: 1,
        success: true,
        skillName: skill.name,
        commandName: skill.name,
        status: 'inline',
        prompt: promptText,
      }

      if (skill.allowedTools) {
        result.allowedTools = skill.allowedTools
      }

      if (skill.model) {
        result.model = skill.model
      }

      return {
        type: 'tool_result',
        tool_use_id: '',
        content: JSON.stringify(result),
      }
    } catch (err: any) {
      return {
        type: 'tool_result',
        tool_use_id: '',
        content: `Error executing skill "${skillName}": ${err.message}`,
        is_error: true,
      }
    }
  },
}
