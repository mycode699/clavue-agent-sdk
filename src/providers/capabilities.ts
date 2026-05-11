import type {
  ApiType,
  ModelCapabilities,
  ModelCapabilityDecision,
  ModelCapabilityName,
  ModelCapabilityOptions,
} from './types.js'

export function normalizeModelId(model: string): string {
  const trimmed = model.trim().toLowerCase()
  const segments = trimmed.split('/').filter(Boolean)
  return segments[segments.length - 1] || trimmed
}

function modelMatchesAny(model: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => model === prefix || model.startsWith(`${prefix}-`))
}

function inferApiType(model: string, requested?: ApiType): ApiType {
  if (requested) return requested

  const normalized = normalizeModelId(model)
  if (
    normalized.startsWith('gpt-') ||
    normalized.startsWith('chatgpt-') ||
    modelMatchesAny(normalized, ['o1', 'o3', 'o4']) ||
    normalized.startsWith('deepseek') ||
    normalized.startsWith('qwen') ||
    normalized.startsWith('yi-') ||
    normalized.startsWith('glm') ||
    normalized.startsWith('grok') ||
    normalized.startsWith('kimi') ||
    normalized.startsWith('moonshot') ||
    normalized.startsWith('mistral') ||
    normalized.startsWith('gemma') ||
    normalized.startsWith('gemini')
  ) {
    return 'openai-completions'
  }

  return 'anthropic-messages'
}

function getContextWindow(model: string, apiType: ApiType): number | undefined {
  if (model.includes('opus-4') && model.includes('1m')) return 1_000_000
  if (model.includes('opus-4')) return 200_000
  if (model.includes('sonnet-4')) return 200_000
  if (model.includes('haiku-4')) return 200_000
  if (model.includes('claude-3')) return 200_000

  if (model.includes('gpt-4.1') || model.includes('gpt-4-1')) return 1_000_000
  if (model.includes('gpt-5')) return 400_000
  if (model.includes('gpt-4o')) return 128_000
  if (model.includes('gpt-4-turbo')) return 128_000
  if (model.includes('gpt-4')) return 128_000
  if (model.includes('gpt-3.5')) return 16_385
  if (modelMatchesAny(model, ['o1', 'o3', 'o4'])) return 200_000
  if (model.startsWith('deepseek')) return 128_000

  // Third-party OpenAI-compatible families.
  if (model.startsWith('grok-4') || model.startsWith('grok-3')) return 256_000
  if (model.startsWith('grok-2') || model.startsWith('grok-')) return 131_072
  if (model.startsWith('glm-4.6') || model.startsWith('glm-4-6')) return 200_000
  if (model.startsWith('glm-4.5') || model.startsWith('glm-4-5')) return 128_000
  if (model.startsWith('glm-4-plus') || model.startsWith('glm-4-long')) return 128_000
  if (model.startsWith('glm-4')) return 128_000
  if (model.startsWith('qwen2.5-max') || model.startsWith('qwen-max')) return 32_768
  if (model.startsWith('qwen3') || model.startsWith('qwen2.5') || model.startsWith('qwen2-5')) return 131_072
  if (model.startsWith('qwen')) return 32_768
  if (model.startsWith('kimi-k2') || model.startsWith('moonshot-v1-128k')) return 128_000
  if (model.startsWith('kimi') || model.startsWith('moonshot')) return 128_000
  if (model.startsWith('gemini-2.5') || model.startsWith('gemini-1.5-pro')) return 2_000_000
  if (model.startsWith('gemini-1.5-flash')) return 1_000_000
  if (model.startsWith('gemini-2.0')) return 1_000_000
  if (model.startsWith('gemini')) return 1_000_000

  return apiType === 'anthropic-messages' && model.includes('claude') ? 200_000 : undefined
}

function getKnownPricing(model: string): ModelCapabilities['pricing'] | undefined {
  if (model.includes('claude-opus-4')) return { inputPerMillionUsd: 15, outputPerMillionUsd: 75 }
  if (model.includes('claude-sonnet-4')) return { inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
  if (model.includes('claude-haiku-4')) return { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 }
  if (model.includes('claude-3-opus')) return { inputPerMillionUsd: 15, outputPerMillionUsd: 75 }
  if (model.includes('claude-3-5-sonnet')) return { inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
  if (model.includes('claude-3-5-haiku')) return { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 }

  if (model.includes('gpt-4o-mini')) return { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 }
  if (model.includes('gpt-4o')) return { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 }
  if (model.includes('gpt-4-turbo')) return { inputPerMillionUsd: 10, outputPerMillionUsd: 30 }
  if (model.includes('gpt-4.1') || model.includes('gpt-4-1')) return { inputPerMillionUsd: 2, outputPerMillionUsd: 8 }
  if (modelMatchesAny(model, ['o1'])) return { inputPerMillionUsd: 15, outputPerMillionUsd: 60 }
  if (modelMatchesAny(model, ['o3'])) return { inputPerMillionUsd: 10, outputPerMillionUsd: 40 }
  if (model === 'o4-mini' || model.startsWith('o4-mini-')) return { inputPerMillionUsd: 1.1, outputPerMillionUsd: 4.4 }
  if (model.includes('deepseek-chat')) return { inputPerMillionUsd: 0.27, outputPerMillionUsd: 1.1 }
  if (model.includes('deepseek-reasoner')) return { inputPerMillionUsd: 0.55, outputPerMillionUsd: 2.19 }

  // Third-party OpenAI-compatible families (list prices, may vary by region/quota).
  if (model.startsWith('grok-4')) return { inputPerMillionUsd: 5, outputPerMillionUsd: 25 }
  if (model.startsWith('grok-3-mini') || model.startsWith('grok-3-fast') || model.startsWith('grok-3-mini-fast')) return { inputPerMillionUsd: 0.3, outputPerMillionUsd: 0.5 }
  if (model.startsWith('grok-3')) return { inputPerMillionUsd: 3, outputPerMillionUsd: 15 }
  if (model.startsWith('grok-2')) return { inputPerMillionUsd: 2, outputPerMillionUsd: 10 }
  if (model.startsWith('glm-4.6') || model.startsWith('glm-4-6')) return { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.2 }
  if (model.startsWith('glm-4.5-air') || model.startsWith('glm-4-5-air')) return { inputPerMillionUsd: 0.2, outputPerMillionUsd: 1.1 }
  if (model.startsWith('glm-4.5') || model.startsWith('glm-4-5')) return { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.2 }
  if (model.startsWith('glm-4-plus')) return { inputPerMillionUsd: 7.1, outputPerMillionUsd: 7.1 }
  if (model.startsWith('qwen-max')) return { inputPerMillionUsd: 1.6, outputPerMillionUsd: 6.4 }
  if (model.startsWith('qwen-plus')) return { inputPerMillionUsd: 0.4, outputPerMillionUsd: 1.2 }
  if (model.startsWith('qwen-turbo')) return { inputPerMillionUsd: 0.05, outputPerMillionUsd: 0.2 }
  if (model.startsWith('kimi-k2') || model.startsWith('moonshot-v1-128k')) return { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.5 }
  if (model.startsWith('moonshot-v1-32k')) return { inputPerMillionUsd: 0.34, outputPerMillionUsd: 1.4 }
  if (model.startsWith('moonshot-v1-8k')) return { inputPerMillionUsd: 0.17, outputPerMillionUsd: 0.69 }
  if (model.startsWith('gemini-2.5-pro') || model.startsWith('gemini-1.5-pro')) return { inputPerMillionUsd: 1.25, outputPerMillionUsd: 10 }
  if (model.startsWith('gemini-2.5-flash') || model.startsWith('gemini-2.0-flash') || model.startsWith('gemini-1.5-flash')) return { inputPerMillionUsd: 0.075, outputPerMillionUsd: 0.3 }

  return undefined
}

function capabilityValue(capabilities: ModelCapabilities, capability: ModelCapabilityName): boolean {
  switch (capability) {
    case 'tools':
      return capabilities.supportsTools
    case 'images':
      return capabilities.supportsImages
    case 'thinking':
      return capabilities.supportsThinking
    case 'json_schema':
      return capabilities.supportsJsonSchema
    case 'streaming':
      return capabilities.supportsStreaming
  }
}

export function getModelCapabilities(
  model: string,
  options: ModelCapabilityOptions = {},
): ModelCapabilities {
  const normalizedModel = normalizeModelId(model)
  const apiType = inferApiType(model, options.apiType)
  const isOpenAI = apiType === 'openai-completions'
  const isAnthropic = apiType === 'anthropic-messages'
  const isClaude = isAnthropic && normalizedModel.includes('claude')
  const isGpt = isOpenAI && (normalizedModel.startsWith('gpt-') || normalizedModel.startsWith('chatgpt-'))
  const isGpt5 = isGpt && (normalizedModel.includes('gpt-5') || normalizedModel.includes('chatgpt-5'))
  const isChatSpecificGpt5 = isGpt5 && normalizedModel.includes('chat')
  const isGpt5Responses = isGpt5 && !isChatSpecificGpt5
  const isGpt4Family = isGpt && (normalizedModel.includes('gpt-4') || normalizedModel.includes('gpt-4o'))
  const isReasoning = isOpenAI && (modelMatchesAny(normalizedModel, ['o1', 'o3', 'o4']) || normalizedModel.includes('reasoner'))
  const isDeepseek = isOpenAI && normalizedModel.startsWith('deepseek')
  // Third-party OpenAI-compatible families. Each is recognized as "known" so
  // capability gates do not silently disable tools/streaming/json_schema. They
  // still go over the OpenAI Chat Completions transport.
  const isGrok = isOpenAI && normalizedModel.startsWith('grok')
  const isGlm = isOpenAI && normalizedModel.startsWith('glm')
  const isQwen = isOpenAI && normalizedModel.startsWith('qwen')
  const isKimi = isOpenAI && (normalizedModel.startsWith('kimi') || normalizedModel.startsWith('moonshot'))
  const isGemini = isOpenAI && normalizedModel.startsWith('gemini')
  const isThirdParty = isGrok || isGlm || isQwen || isKimi || isGemini
  const known = isClaude || isGpt || isReasoning || isDeepseek || isThirdParty

  // Vision support per family (best-effort current generation).
  const isGrokVision = isGrok && (normalizedModel.startsWith('grok-4') || normalizedModel.startsWith('grok-2-vision') || normalizedModel.includes('vision'))
  const isGlmVision = isGlm && (normalizedModel.includes('-v') || normalizedModel.startsWith('glm-4.5v') || normalizedModel.startsWith('glm-4-5v') || normalizedModel.startsWith('glm-4v') || normalizedModel.startsWith('glm-4.6'))
  const isQwenVision = isQwen && (normalizedModel.includes('vl') || normalizedModel.includes('omni'))
  const isKimiVision = isKimi && (normalizedModel.includes('vision') || normalizedModel.startsWith('kimi-k2'))

  // Reasoning / extended thinking surfaces per family.
  const isGrokThinking = isGrok && (normalizedModel.startsWith('grok-4') || normalizedModel.includes('reason') || normalizedModel.includes('think'))
  const isGlmThinking = isGlm && (normalizedModel.includes('think') || normalizedModel.startsWith('glm-zero') || normalizedModel.startsWith('glm-4.6'))
  const isQwenThinking = isQwen && (normalizedModel.startsWith('qwq') || normalizedModel.includes('thinking') || normalizedModel.startsWith('qwen3'))
  const isKimiThinking = isKimi && normalizedModel.startsWith('kimi-k2')

  const supportsTools = isAnthropic
    ? isClaude
    : isGpt || isReasoning || isDeepseek || isThirdParty
  const supportsImages = isAnthropic
    ? isClaude
    : isGpt5 || isGpt4Family || isGemini || isGrokVision || isGlmVision || isQwenVision || isKimiVision
  const supportsThinking = isAnthropic
    ? isClaude && (normalizedModel.includes('opus-4') || normalizedModel.includes('sonnet-4'))
    : isReasoning || isGpt5Responses || isGrokThinking || isGlmThinking || isQwenThinking || isKimiThinking

  const capabilities: ModelCapabilities = {
    model,
    normalizedModel,
    apiType,
    transport: isOpenAI && isGpt5Responses ? 'responses' : isOpenAI ? 'chat_completions' : 'messages',
    known,
    supportsTools,
    supportsImages,
    supportsThinking,
    supportsJsonSchema: isOpenAI ? isGpt || isReasoning || isDeepseek || isThirdParty : isClaude,
    supportsStreaming: known,
  }

  const contextWindow = getContextWindow(normalizedModel, apiType)
  if (contextWindow !== undefined) capabilities.contextWindow = contextWindow

  const pricing = getKnownPricing(normalizedModel)
  if (pricing) capabilities.pricing = pricing

  if (isOpenAI && isGpt5Responses) {
    capabilities.fallback = { responsesToChatCompletionsStatuses: [400, 404, 405, 501] }
  }

  return capabilities
}

export function decideModelCapability(
  model: string,
  capability: ModelCapabilityName,
  options: ModelCapabilityOptions = {},
): ModelCapabilityDecision {
  const capabilities = getModelCapabilities(model, options)
  const supported = capabilityValue(capabilities, capability)

  if (supported) {
    return {
      model,
      normalizedModel: capabilities.normalizedModel,
      apiType: capabilities.apiType,
      capability,
      supported: true,
      support: 'supported',
      reason: `Model ${capabilities.normalizedModel} is known to support ${capability}.`,
    }
  }

  if (!capabilities.known) {
    return {
      model,
      normalizedModel: capabilities.normalizedModel,
      apiType: capabilities.apiType,
      capability,
      supported: false,
      support: 'unknown',
      reason: `Model ${capabilities.normalizedModel} is unknown; ${capability} is disabled by conservative default.`,
    }
  }

  return {
    model,
    normalizedModel: capabilities.normalizedModel,
    apiType: capabilities.apiType,
    capability,
    supported: false,
    support: 'unsupported',
    reason: `Model ${capabilities.normalizedModel} is known, but ${capability} support is not enabled for it.`,
  }
}
