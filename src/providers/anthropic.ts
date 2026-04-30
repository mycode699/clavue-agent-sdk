/**
 * Anthropic Messages API Provider
 *
 * Wraps the @anthropic-ai/sdk client. Since our internal format is
 * Anthropic-like, this is mostly a thin pass-through.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  ProviderError,
  ProviderErrorCategory,
} from './types.js'

function categorizeAnthropicStatus(status?: number): ProviderErrorCategory {
  switch (status) {
    case 400:
      return 'invalid_request'
    case 401:
      return 'authentication'
    case 403:
      return 'authorization'
    case 404:
      return 'unsupported'
    case 408:
    case 504:
      return 'timeout'
    case 429:
      return 'rate_limit'
    default:
      return status && status >= 500 ? 'provider_error' : 'unknown'
  }
}

function normalizeAnthropicError(err: unknown): ProviderError {
  const source = err as Error & {
    status?: number
    headers?: Record<string, string>
    body?: string
    error?: unknown
  }
  const normalized = source instanceof Error
    ? source as ProviderError
    : new Error(String(err)) as ProviderError

  normalized.provider = 'anthropic'
  normalized.category = categorizeAnthropicStatus(source?.status)
  if (source?.status !== undefined) normalized.status = source.status
  if (source?.headers) normalized.headers = source.headers
  if (source?.body !== undefined) normalized.body = source.body
  if (source?.error !== undefined) normalized.error = source.error
  return normalized
}

export class AnthropicProvider implements LLMProvider {
  readonly apiType = 'anthropic-messages' as const
  private client: Anthropic

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      baseURL: opts.baseURL,
    })
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      messages: params.messages as Anthropic.MessageParam[],
      tools: params.tools
        ? (params.tools as Anthropic.Tool[])
        : undefined,
    }

    // Add extended thinking if configured
    if (params.thinking?.type === 'enabled' && params.thinking.budget_tokens) {
      (requestParams as any).thinking = {
        type: 'enabled',
        budget_tokens: params.thinking.budget_tokens,
      }
    }

    let response: Anthropic.Messages.Message
    try {
      response = await this.client.messages.create(requestParams, {
        signal: params.abortSignal,
      })
    } catch (err) {
      throw normalizeAnthropicError(err)
    }

    return {
      content: response.content as CreateMessageResponse['content'],
      stopReason: response.stop_reason || 'end_turn',
      usage: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        cache_creation_input_tokens:
          (response.usage as any).cache_creation_input_tokens,
        cache_read_input_tokens:
          (response.usage as any).cache_read_input_tokens,
      },
    }
  }
}
