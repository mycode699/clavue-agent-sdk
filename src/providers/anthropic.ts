/**
 * Anthropic Messages API Provider
 *
 * Wraps the @anthropic-ai/sdk client. Since our internal format is
 * Anthropic-like, this is mostly a thin pass-through.
 *
 * Prompt caching (audit P0-5): when the model supports prompt caching, we
 * mark the trailing tool definition and the system prompt with
 * `cache_control: ephemeral` so subsequent turns hit the read-cache. This
 * trims multi-turn input cost by roughly 70-80% with no behavior change.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  ProviderError,
  ProviderErrorCategory,
  OutputSchema,
} from './types.js'

function categorizeAnthropicTransportError(err: unknown): ProviderErrorCategory | undefined {
  const source = err as { name?: string; code?: string; cause?: { code?: string } }
  const code = source?.code ?? source?.cause?.code

  if (source?.name === 'AbortError' || code === 'ABORT_ERR') {
    return 'aborted'
  }

  if (code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return 'timeout'
  }

  if (code || err instanceof TypeError) {
    return 'network'
  }

  return undefined
}

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
  normalized.category = categorizeAnthropicTransportError(err) ?? categorizeAnthropicStatus(source?.status)
  if (source?.status !== undefined) normalized.status = source.status
  if (source?.headers) normalized.headers = source.headers
  if (source?.body !== undefined) normalized.body = source.body
  if (source?.error !== undefined) normalized.error = source.error
  return normalized
}

/**
 * Models that don't support prompt caching. The list is intentionally narrow
 * because Anthropic now caches by default on supported endpoints, but legacy
 * Claude 2.x / Claude Instant don't accept the cache_control field.
 */
function modelSupportsPromptCaching(model: string): boolean {
  if (!model) return false
  if (model.startsWith('claude-2')) return false
  if (model.includes('claude-instant')) return false
  return true
}

/**
 * Tag the trailing tool with cache_control so the tool list (typically
 * stable across a run) is reused from cache. Returns a shallow-cloned array.
 */
function applyToolCaching(
  tools: ReadonlyArray<Anthropic.Tool> | undefined,
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined
  const result = tools.map((tool) => ({ ...tool })) as Anthropic.Tool[]
  const last = result[result.length - 1] as Anthropic.Tool & {
    cache_control?: { type: 'ephemeral' }
  }
  last.cache_control = { type: 'ephemeral' }
  return result
}

/**
 * Convert a string system prompt into the structured form Anthropic accepts
 * and tag the (single) block with cache_control.
 */
function applySystemCaching(system: string | undefined): Anthropic.MessageCreateParamsNonStreaming['system'] {
  if (!system || system.length === 0) return undefined
  const block: any = {
    type: 'text',
    text: system,
    cache_control: { type: 'ephemeral' },
  }
  return [block]
}

const DEFAULT_OUTPUT_TOOL_NAME = '_output'

/**
 * Translate an OutputSchema constraint into the Anthropic shape: a synthesized
 * tool whose `input_schema` is the user-supplied schema, plus a forced
 * `tool_choice` selecting that tool. The model's structured output then
 * appears as that tool's `input` payload.
 *
 * Returns the synthesized tool (to append to the tools list) and the
 * tool_choice fragment to overlay onto the request.
 */
function buildAnthropicOutputBinding(outputSchema: OutputSchema): {
  outputTool: Anthropic.Tool
  toolChoice: { type: 'tool'; name: string }
} {
  const name = outputSchema.name || DEFAULT_OUTPUT_TOOL_NAME
  const description = outputSchema.description
    || 'Return the structured output by invoking this tool with arguments matching the schema.'
  const schema = outputSchema.schema as Anthropic.Tool['input_schema']
  const outputTool: Anthropic.Tool = {
    name,
    description,
    input_schema: schema,
  }
  return { outputTool, toolChoice: { type: 'tool', name } }
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
    const cachingEligible = modelSupportsPromptCaching(params.model)

    // If structured output is requested, synthesize the output tool BEFORE
    // applying caching so the cache_control marker still lands on the trailing
    // tool entry (which is now the output tool — fine, schemas are usually
    // stable across a run too).
    let toolsForRequest = params.tools as Anthropic.Tool[] | undefined
    let toolChoice: { type: 'tool'; name: string } | undefined
    if (params.outputSchema) {
      const { outputTool, toolChoice: tc } = buildAnthropicOutputBinding(params.outputSchema)
      toolsForRequest = [...(toolsForRequest ?? []), outputTool]
      toolChoice = tc
    }

    const cachedTools = cachingEligible ? applyToolCaching(toolsForRequest) : toolsForRequest

    const systemForRequest = cachingEligible
      ? applySystemCaching(params.system)
      : params.system

    const requestParams: Anthropic.MessageCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      system: systemForRequest as any,
      messages: params.messages as Anthropic.MessageParam[],
      tools: cachedTools,
    }
    if (toolChoice) {
      (requestParams as any).tool_choice = toolChoice
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
      if (params.stream?.onText) {
        // Streaming path. We still return the same aggregated CreateMessageResponse
        // shape — the only behavioral difference is that text deltas are emitted
        // through the caller's onText callback as they arrive. This trades the
        // single round-trip latency of `.create()` for incremental TTFT.
        const streamParams: Anthropic.MessageCreateParamsStreaming = {
          ...requestParams,
          stream: true,
        }
        const stream = this.client.messages.stream(streamParams, {
          signal: params.abortSignal,
        })

        const onText = params.stream.onText
        stream.on('text', (delta: string) => {
          try {
            onText(delta)
          } catch {
            // Streaming callbacks must never poison the model call.
          }
        })

        try {
          response = await stream.finalMessage()
        } catch (err) {
          throw normalizeAnthropicError(err)
        }
      } else {
        response = await this.client.messages.create(requestParams, {
          signal: params.abortSignal,
        })
      }
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
