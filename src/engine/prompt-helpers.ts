/**
 * Pure system-prompt builder helpers used by `QueryEngine`. Extracted
 * from `src/engine.ts` to shrink the god-class while preserving the
 * exact prompt assembly order.
 *
 * None of these functions read engine instance state. They take
 * `QueryEngineConfig` and return strings, prompt fragments, or memory
 * traces. The hot-path call sites in engine.ts are 1:1 replacements.
 */

import { randomUUID } from 'node:crypto'

import type {
  AgentAutonomyMode,
  AgentRunMemoryTrace,
  MemoryPolicyMode,
  QueryEngineConfig,
  ToolContext,
  ToolDefinition,
} from '../types.js'
import { MEMORY_TRACE_SCHEMA_VERSION } from '../types.js'
import type { NormalizedTool } from '../providers/types.js'
import { queryMemoryMatches, type MemoryEntry } from '../memory.js'
import { getSystemContext, getUserContext } from '../utils/context.js'
import { formatInjectedMemories, toMemorySelectionTrace } from './memory-helpers.js'

/** Convert a ToolDefinition to the normalized provider tool format. */
export function toProviderTool(tool: ToolDefinition): NormalizedTool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }
}

export function createToolContext(
  config: QueryEngineConfig,
  tools: ToolDefinition[] = config.tools,
): ToolContext {
  return {
    cwd: config.cwd,
    workspaceRoot: config.cwd,
    abortSignal: config.abortSignal,
    provider: config.provider,
    model: config.model,
    apiType: config.provider.apiType,
    policy: config.policy,
    runtimeNamespace: config.runtimeNamespace,
    availableTools: tools.map((tool) => tool.name),
    autonomyMode: config.autonomyMode,
  }
}

export async function collectToolPromptFragments(
  config: QueryEngineConfig,
): Promise<string[]> {
  const context = createToolContext(config)
  const fragments: string[] = []
  const maxChars = 8_000
  const maxFragmentChars = 2_000
  let used = 0

  for (const tool of config.tools) {
    if (!tool.prompt) continue
    if (tool.isEnabled && !tool.isEnabled(context)) continue

    try {
      const prompt = (await tool.prompt(context)).trim()
      if (!prompt) continue

      const trimmedPrompt = prompt.length > maxFragmentChars
        ? `${prompt.slice(0, maxFragmentChars)}\n...(tool guidance truncated)...`
        : prompt
      const fragment = `## ${tool.name}\n${trimmedPrompt}`
      if (used + fragment.length > maxChars) continue
      fragments.push(fragment)
      used += fragment.length
    } catch {
      // Tool prompt fragments are best-effort and should not block a run.
    }
  }

  return fragments
}

export function getMemoryPolicyMode(config: QueryEngineConfig): MemoryPolicyMode {
  if (!config.memory?.enabled) return 'off'
  if (config.memory.policy?.mode) return config.memory.policy.mode
  return config.memory.autoInject === false ? 'off' : 'autoInject'
}

export function getAutonomyMode(config: QueryEngineConfig): AgentAutonomyMode {
  if (config.autonomyMode) return config.autonomyMode
  return config.policy.permissionMode === 'trustedAutomation'
    ? 'autonomous'
    : 'proactive'
}

export function getAutonomyPrompt(mode: AgentAutonomyMode): string {
  switch (mode) {
    case 'supervised':
      return [
        'Autonomy mode: supervised.',
        'Proceed with analysis and low-risk read-only work, but ask the user before choosing between materially different product directions, making broad edits, or taking externally visible actions.',
        'Still avoid low-value confirmations: if the next step is obvious, safe, and within granted tools, do it.',
      ].join('\n')

    case 'autonomous':
      return [
        'Autonomy mode: autonomous development.',
        'Default to action. Do not pause for routine confirmations, implementation choices, dependency-free refactors, test runs, focused fixes, or P0-P3 todo execution when the request and allowed tools already authorize the work.',
        'Choose the best technical solution yourself using current code context, tests, product goals, and risk. When multiple viable approaches exist, select the smallest high-quality path that preserves public compatibility and maximizes verification evidence.',
        'Use a tight loop: inspect, hypothesize, edit, verify, repair, and summarize. Keep moving until the task is complete, blocked by tool policy, or a defined stop condition is reached.',
        'Stop and ask only for irreversible or externally visible actions, credential/secret decisions, destructive data loss, publishing/deployment/tagging, legal/compliance ambiguity, spending real money, or mutually exclusive product choices that cannot be inferred from local context.',
        'Human review is the final acceptance gate; during development, provide evidence-backed progress rather than asking the user to make routine engineering decisions.',
      ].join('\n')

    case 'proactive':
    default:
      return [
        'Autonomy mode: proactive.',
        'Prefer proceeding over asking. Ask at most one concise question only when missing information would create a real risk or materially change the solution.',
        'For ambiguous engineering choices, inspect the codebase, choose a defensible default, document the assumption, and verify the result.',
        'For todo lists and P0-P3 fixes, execute the next highest-priority safe slice instead of returning only a plan.',
        'Never claim completion without concrete evidence when verification is available.',
      ].join('\n')
  }
}

export async function getInjectedMemories(
  config: QueryEngineConfig,
): Promise<{ entries: MemoryEntry[]; trace: AgentRunMemoryTrace }> {
  const started = performance.now()
  const policy = getMemoryPolicyMode(config)
  const repoPath = config.memory?.repoPath || config.cwd
  const text = typeof config.initialPrompt === 'string' ? config.initialPrompt : undefined
  const limit = config.memory?.maxInjectedEntries ?? 5
  const strategy = policy === 'brainFirst' ? 'brain_first' : 'auto_inject'
  const filters = {
    repo_path: repoPath,
    text,
    limit,
  }
  const trace: AgentRunMemoryTrace = {
    schema_version: MEMORY_TRACE_SCHEMA_VERSION,
    retrieval_id: `memret_${randomUUID()}`,
    policy,
    strategy,
    query: text,
    repo_path: repoPath,
    filters,
    store: {
      configured: Boolean(config.memory?.dir),
      dir: config.memory?.dir,
    },
    selected_ids: [],
    injected_count: 0,
    injection_status: policy === 'off' || !config.memory?.enabled ? 'off' : 'empty',
    selection_source: policy === 'off' || !config.memory?.enabled ? 'off' : 'empty',
    retrieval_steps: [],
    retrieved_before_first_model_call: true,
  }

  try {
    if (policy === 'off' || !config.memory?.enabled) {
      return { entries: [], trace }
    }

    const store = { dir: config.memory.dir }
    const targetedStarted = performance.now()
    const targeted = await queryMemoryMatches(
      {
        repoPath,
        text,
        limit,
      },
      store,
    )
    trace.retrieval_steps?.push({
      source: 'targeted',
      strategy,
      query: text,
      repo_path: repoPath,
      filters,
      candidate_count: targeted.length,
      selected_count: targeted.length,
      duration_ms: Math.round(performance.now() - targetedStarted),
    })

    let matches = targeted
    if (matches.length > 0) {
      trace.selection_source = 'targeted'
    } else {
      const fallbackFilters = {
        repo_path: repoPath,
        limit,
      }
      const fallbackStarted = performance.now()
      matches = await queryMemoryMatches(
        {
          repoPath,
          limit,
        },
        store,
      )
      trace.retrieval_steps?.push({
        source: 'repo_fallback',
        strategy,
        repo_path: repoPath,
        filters: fallbackFilters,
        candidate_count: matches.length,
        selected_count: matches.length,
        duration_ms: Math.round(performance.now() - fallbackStarted),
      })
      trace.selection_source = matches.length > 0 ? 'repo_fallback' : 'empty'
    }

    const entries = matches.map(({ entry }) => entry)
    trace.selected_ids = entries.map((entry) => entry.id)
    trace.selected = matches.map((match) => toMemorySelectionTrace(match, {
      includeRichFields: policy === 'brainFirst',
      queryText: text,
    }))
    trace.injected_count = entries.length
    trace.injection_status = entries.length > 0 ? 'injected' : 'empty'
    return { entries, trace }
  } finally {
    trace.duration_ms = Math.round(performance.now() - started)
  }
}

export async function buildSystemPrompt(
  config: QueryEngineConfig,
): Promise<{ systemPrompt: string; memoryTrace: AgentRunMemoryTrace }> {
  if (config.systemPrompt) {
    const parts = [config.systemPrompt]
    const { entries: injectedMemories, trace: memoryTrace } = await getInjectedMemories(config)
    if (injectedMemories.length > 0) {
      parts.push('\n# Relevant Memory\n')
      parts.push(formatInjectedMemories(injectedMemories))
    }
    if (config.appendSystemPrompt) {
      parts.push('\n' + config.appendSystemPrompt)
    }
    return { systemPrompt: parts.join('\n'), memoryTrace }
  }

  const parts: string[] = [
    config.policy.permissionMode === 'trustedAutomation'
      ? 'You are running in trusted automation mode inside the host application.'
      : `You are running with permission mode ${config.policy.permissionMode} inside the host application.`,
    'Use the available tools to complete the user\'s task. Inspect the project, make focused changes, and verify concrete results before claiming completion.',
  ]

  parts.push('\n# Autonomy And Calibration\n')
  parts.push(getAutonomyPrompt(getAutonomyMode(config)))

  if (config.policy.permissionMode === 'trustedAutomation') {
    parts.push('Tool permissions are high trust, but this does not authorize publishing, deployment, credential exposure, destructive data loss, or irreversible external-state changes unless the user explicitly requested them.')
  } else {
    parts.push('Tool access is governed by the host application\'s available tool set, canUseTool policy, and hooks.')
  }

  parts.push(
    'Keep changes surgical and goal-driven: understand the existing code first, reuse existing patterns, avoid speculative abstractions, and do not expand scope beyond the request.',
  )

  // List available tools with descriptions
  parts.push('\n# Available Tools\n')
  for (const tool of config.tools) {
    parts.push(`- **${tool.name}**: ${tool.description}`)
  }

  const toolPromptFragments = await collectToolPromptFragments(config)
  if (toolPromptFragments.length > 0) {
    parts.push('\n# Tool Guidance\n')
    parts.push(toolPromptFragments.join('\n\n'))
  }

  // Add agent definitions
  if (config.agents && Object.keys(config.agents).length > 0) {
    parts.push('\n# Available Subagents\n')
    for (const [name, def] of Object.entries(config.agents)) {
      parts.push(`- **${name}**: ${def.description}`)
    }
  }

  // System context (git status, etc.)
  try {
    const sysCtx = await getSystemContext(config.cwd)
    if (sysCtx) {
      parts.push('\n# Environment\n')
      parts.push(sysCtx)
    }
  } catch {
    // Context is best-effort
  }

  // User context (AGENT.md, date)
  try {
    const userCtx = await getUserContext(config.cwd)
    if (userCtx) {
      parts.push('\n# Project Context\n')
      parts.push(userCtx)
    }
  } catch {
    // Context is best-effort
  }

  const { entries: injectedMemories, trace: memoryTrace } = await getInjectedMemories(config)
  if (injectedMemories.length > 0) {
    parts.push('\n# Relevant Memory\n')
    parts.push(formatInjectedMemories(injectedMemories))
  }

  // Working directory
  parts.push(`\n# Working Directory\n${config.cwd}`)

  if (config.appendSystemPrompt) {
    parts.push('\n' + config.appendSystemPrompt)
  }

  return { systemPrompt: parts.join('\n'), memoryTrace }
}
