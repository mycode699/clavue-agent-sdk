/**
 * Build the per-turn request payload — system prompt, model, tools, and the
 * streaming callback wiring. Pure helper extracted from
 * `QueryEngine.submitMessage` (Slice K1).
 *
 * Notes:
 * - Active-skill scope is applied here: when a skill is inline-active we
 *   filter the tool list and prepend the skill's instructions to the system
 *   prompt. The skill's `model` overrides the engine default for this turn.
 * - The streaming callback is intentionally optional: when
 *   `includePartialMessages` is false we return `stream: undefined` so the
 *   provider takes its non-streaming code path.
 */

import type {
  CreateMessageParams,
  CreateMessageResponse,
  LLMProvider,
  NormalizedMessageParam,
  NormalizedTool,
  OutputSchema,
} from '../providers/types.js'
import type { ThinkingConfig, ToolDefinition } from '../types.js'
import { filterToolsForSkill, type SkillActivation } from './skill-helpers.js'
import { toProviderTool } from './prompt-helpers.js'

export interface BuildTurnRequestInput {
  /** Engine config slice — only the fields the request actually needs. */
  config: {
    model: string
    maxTokens?: number
    thinking?: ThinkingConfig
    abortSignal?: AbortSignal
    outputSchema?: OutputSchema
    jsonSchema?: unknown
    fallbackModel?: string
    includePartialMessages?: boolean
    tools: ToolDefinition[]
  }
  /** The provider that will actually issue the call. */
  provider: LLMProvider
  /** Cleaned-up system prompt (already includes context, memory, etc.) */
  systemPrompt: string
  /** Messages already normalized + micro-compacted for the API. */
  apiMessages: NormalizedMessageParam[]
  /** Active inline skill, if any. Applies tool filter + prompt append. */
  activeSkill?: SkillActivation
  /** Where streaming text deltas are pushed; release notifies the drain. */
  partialQueue: string[]
  releaseDrain: () => void
}

export interface BuiltTurnRequest {
  /** Final model id used for this turn (skill-overridden if applicable). */
  requestModel: string
  /** Optional fallback model for retry-after-failure. */
  fallbackModel?: string
  /** Provider-shaped tool list this turn is allowed to call. */
  providerTools: NormalizedTool[]
  /**
   * Issue the actual API call against the chosen model. The engine wraps
   * this in `withRetry` + fallback in one place.
   */
  createModelMessage: (model: string) => Promise<CreateMessageResponse>
}

export function buildTurnRequest(input: BuildTurnRequestInput): BuiltTurnRequest {
  const { activeSkill, config, provider, systemPrompt, apiMessages, partialQueue, releaseDrain } = input

  const activeTools = activeSkill
    ? filterToolsForSkill(config.tools, activeSkill.allowedTools)
    : config.tools
  const providerTools = activeTools.map(toProviderTool)

  const requestModel = activeSkill?.model || config.model
  const requestSystemPrompt = activeSkill
    ? `${systemPrompt}\n\n# Active Skill: ${activeSkill.skillName || activeSkill.commandName || 'unknown'}\n${activeSkill.prompt}\n\nRemain within this active skill until the current workflow is complete. Use only the tools available for this request.`
    : systemPrompt

  // A separate fallback model is only meaningful if it differs from the model
  // we'll actually try first (otherwise the "fallback" is just the same call).
  const fallbackModel = config.fallbackModel && config.fallbackModel !== requestModel
    ? config.fallbackModel
    : undefined

  const wantStreaming = config.includePartialMessages === true
  const streamCallbacks = wantStreaming
    ? {
        onText: (delta: string) => {
          if (!delta) return
          partialQueue.push(delta)
          releaseDrain()
        },
      }
    : undefined

  const createModelMessage = (model: string): Promise<CreateMessageResponse> => {
    const params: CreateMessageParams = {
      model,
      // CreateMessageParams.maxTokens is required; the engine config always
      // populates it (Agent default = 16384). Coerce to a sane fallback so
      // mid-flight callers without maxTokens still get a deterministic value
      // instead of a runtime "undefined" cast.
      maxTokens: config.maxTokens ?? 16384,
      system: requestSystemPrompt,
      messages: apiMessages,
      tools: providerTools.length > 0 ? providerTools : undefined,
      thinking:
        config.thinking?.type === 'enabled' && config.thinking.budgetTokens
          ? { type: 'enabled', budget_tokens: config.thinking.budgetTokens }
          : undefined,
      abortSignal: config.abortSignal,
      outputSchema:
        config.outputSchema
        ?? (config.jsonSchema
          ? { schema: config.jsonSchema as Record<string, unknown> }
          : undefined),
      stream: streamCallbacks,
    }
    return provider.createMessage(params)
  }

  return { requestModel, fallbackModel, providerTools, createModelMessage }
}
