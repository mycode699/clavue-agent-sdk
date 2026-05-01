/**
 * OpenAI Chat Completions API Provider
 *
 * Converts between the SDK's internal Anthropic-like message format
 * and OpenAI's Chat Completions API format.
 *
 * Uses native fetch (no openai SDK dependency required).
 */

import type {
  LLMProvider,
  CreateMessageParams,
  CreateMessageResponse,
  NormalizedMessageParam,
  NormalizedContentBlock,
  NormalizedTool,
  NormalizedResponseBlock,
  ProviderError,
  ProviderErrorCategory,
  ModelCapabilityName,
} from './types.js'
import { decideModelCapability, getModelCapabilities } from './capabilities.js'

// --------------------------------------------------------------------------
// OpenAI-specific types (minimal, just what we need)
// --------------------------------------------------------------------------

interface OpenAIImageUrlPart {
  type: 'image_url'
  image_url: {
    url: string
    detail?: string
  }
}

interface OpenAITextPart {
  type: 'text'
  text: string
}

interface OpenAIResponsesInputTextPart {
  type: 'input_text'
  text: string
}

interface OpenAIResponsesInputImagePart {
  type: 'input_image'
  image_url: string
  detail?: string
}

type OpenAIResponsesContentPart = OpenAIResponsesInputTextPart | OpenAIResponsesInputImagePart

interface OpenAIResponsesMessage {
  role: 'system' | 'user' | 'assistant'
  content?: string | OpenAIResponsesContentPart[] | null
  tool_calls?: OpenAIToolCall[]
}

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | Array<OpenAITextPart | OpenAIImageUrlPart> | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
}

interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, any>
  }
}

interface OpenAIChatResponse {
  id: string
  choices: Array<{
    index: number
    message: {
      role: 'assistant'
      content: string | null
      tool_calls?: OpenAIToolCall[]
    }
    finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

interface OpenAIResponseItem {
  type: string
  role?: string
  content?: Array<{ type: string; text?: string }>
  id?: string
  name?: string
  call_id?: string
  arguments?: string
  result?: string
  revised_prompt?: string
}

interface OpenAIResponsesFunctionCallOutput {
  type: 'function_call_output'
  call_id: string
  output: string
}

interface OpenAIResponsesResponse {
  id: string
  output?: OpenAIResponseItem[]
  output_text?: string
  status?: string
  incomplete_details?: {
    reason?: string
  }
  error?: {
    message?: string
    type?: string
    code?: string
  }
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
}

type OpenAIError = ProviderError

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries())
}

function getOpenAIErrorField(error: unknown, field: 'message' | 'type' | 'code' | 'param'): string {
  if (!error || typeof error !== 'object') return ''
  const root = error as Record<string, any>
  const nested = root.error && typeof root.error === 'object' ? root.error as Record<string, any> : root
  const value = nested[field]
  return typeof value === 'string' ? value : ''
}

function categorizeOpenAIErrorBody(error: unknown): ProviderErrorCategory | undefined {
  const message = getOpenAIErrorField(error, 'message').toLowerCase()
  const type = getOpenAIErrorField(error, 'type').toLowerCase()
  const code = getOpenAIErrorField(error, 'code').toLowerCase()
  const param = getOpenAIErrorField(error, 'param').toLowerCase()
  const signature = `${message} ${type} ${code} ${param}`

  if (signature.includes('content_filter') || signature.includes('content filter') || signature.includes('filtered')) {
    return 'content_filter'
  }

  if (signature.includes('context_length') || signature.includes('context length') || signature.includes('maximum context')) {
    return 'context_overflow'
  }

  if (signature.includes('tool_call') || signature.includes('tool call') || signature.includes('tool_call_id')) {
    return 'tool_protocol_error'
  }

  return undefined
}

function categorizeOpenAIStatus(status?: number): ProviderErrorCategory {
  switch (status) {
    case 400:
      return 'invalid_request'
    case 401:
      return 'authentication'
    case 403:
      return 'authorization'
    case 404:
    case 405:
    case 501:
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

function createOpenAIProviderError(input: {
  message: string
  category?: ProviderErrorCategory
  status?: number
  headers?: Record<string, string>
  body?: string
  error?: unknown
  model?: string
  capability?: ModelCapabilityName
}): OpenAIError {
  const err = new Error(input.message) as OpenAIError
  err.provider = 'openai'
  err.category = input.category ?? categorizeOpenAIErrorBody(input.error) ?? categorizeOpenAIStatus(input.status)
  if (input.status !== undefined) err.status = input.status
  if (input.headers) err.headers = input.headers
  if (input.body !== undefined) err.body = input.body
  if (input.error !== undefined) err.error = input.error
  if (input.model !== undefined) err.model = input.model
  if (input.capability !== undefined) err.capability = input.capability
  return err
}

async function createOpenAIError(response: Response): Promise<OpenAIError> {
  const body = await response.text().catch(() => '')
  let parsed: unknown
  try {
    parsed = body ? JSON.parse(body) : undefined
  } catch {
    parsed = undefined
  }

  return createOpenAIProviderError({
    message: `OpenAI API error: ${response.status} ${response.statusText}: ${body}`,
    status: response.status,
    headers: headersToRecord(response.headers),
    body,
    error: parsed,
  })
}

function categorizeOpenAIFetchError(error: unknown): ProviderErrorCategory {
  const source = error as { name?: string; code?: string; cause?: { code?: string } }
  const code = source?.code ?? source?.cause?.code

  if (source?.name === 'AbortError' || code === 'ABORT_ERR') {
    return 'aborted'
  }

  if (code === 'ETIMEDOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') {
    return 'timeout'
  }

  return 'network'
}

function createOpenAIFetchError(error: unknown): OpenAIError {
  const message = error instanceof Error ? error.message : String(error)
  return createOpenAIProviderError({
    message: `OpenAI API request failed: ${message}`,
    category: categorizeOpenAIFetchError(error),
    error,
  })
}

// --------------------------------------------------------------------------
// Provider
// --------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  private apiKey: string
  private baseURL: string

  constructor(opts: { apiKey?: string; baseURL?: string }) {
    this.apiKey = opts.apiKey || ''
    this.baseURL = (opts.baseURL || 'https://api.openai.com/v1').replace(/\/$/, '')
  }

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.preflightCapabilities(params)

    if (this.shouldUseResponsesApi(params.model)) {
      return this.createResponsesMessage(params)
    }

    return this.createChatCompletionsMessage(params)
  }

  private preflightCapabilities(params: CreateMessageParams): void {
    if (params.tools && params.tools.length > 0) {
      this.assertCapability(params.model, 'tools')
    }

    if (params.thinking?.type === 'enabled') {
      this.assertCapability(params.model, 'thinking')
    }

    if (this.hasImageContent(params.messages)) {
      this.assertCapability(params.model, 'images')
    }
  }

  private assertCapability(model: string, capability: ModelCapabilityName): void {
    const decision = decideModelCapability(model, capability, { apiType: this.apiType })
    if (decision.support !== 'unsupported') return

    throw createOpenAIProviderError({
      message: `OpenAI model ${decision.normalizedModel} does not support ${capability}: ${decision.reason}`,
      category: 'unsupported_capability',
      model,
      capability,
    })
  }

  private hasImageContent(messages: NormalizedMessageParam[]): boolean {
    return messages.some((message) => Array.isArray(message.content)
      && message.content.some((block) => block.type === 'image'))
  }

  private shouldUseResponsesApi(model: string): boolean {
    return getModelCapabilities(model, { apiType: this.apiType }).transport === 'responses'
  }

  private async createChatCompletionsMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    const messages = this.convertMessages(params.system, params.messages)
    const tools = params.tools ? this.convertTools(params.tools) : undefined

    const body: Record<string, any> = {
      model: params.model,
      max_tokens: params.maxTokens,
      messages,
    }

    if (tools && tools.length > 0) {
      body.tools = tools
    }

    let response: Response
    try {
      response = await fetch(`${this.baseURL}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: params.abortSignal,
      })
    } catch (error) {
      throw createOpenAIFetchError(error)
    }

    if (!response.ok) {
      throw await createOpenAIError(response)
    }

    const data = await this.parseJsonResponse<OpenAIChatResponse>(response, 'OpenAI Chat Completions')
    return this.convertChatCompletionsResponse(data)
  }

  private async createResponsesMessage(
    params: CreateMessageParams,
  ): Promise<CreateMessageResponse> {
    const input = this.convertResponsesInput(params.system, params.messages)
    const tools = params.tools ? this.convertResponsesTools(params.tools) : undefined

    const body: Record<string, any> = {
      model: params.model,
      max_output_tokens: params.maxTokens,
      input,
    }

    if (tools && tools.length > 0) {
      body.tools = tools
    }

    let response: Response
    try {
      response = await fetch(`${this.baseURL}/responses`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: params.abortSignal,
      })
    } catch (error) {
      throw createOpenAIFetchError(error)
    }

    if (!response.ok) {
      const error = await createOpenAIError(response)
      if (!params.abortSignal?.aborted && this.shouldFallbackToChatCompletions(params.model, error)) {
        return this.createChatCompletionsMessage(params)
      }

      throw error
    }

    const data = await this.parseJsonResponse<OpenAIResponsesResponse>(response, 'OpenAI Responses')
    return this.convertResponsesResponse(data)
  }

  private async parseJsonResponse<T>(response: Response, label: string): Promise<T> {
    try {
      return await response.json() as T
    } catch (error) {
      throw createOpenAIProviderError({
        message: `Failed to parse ${label} response JSON`,
        category: 'provider_conversion_error',
        error,
      })
    }
  }

  private shouldFallbackToChatCompletions(model: string, error: OpenAIError): boolean {
    if (error.category !== 'unsupported' && error.category !== 'invalid_request') return false

    return getModelCapabilities(model, { apiType: this.apiType }).fallback?.responsesToChatCompletionsStatuses?.includes(error.status ?? 0) === true
  }

  // --------------------------------------------------------------------------
  // Message Conversion: Internal → OpenAI
  // --------------------------------------------------------------------------

  private convertMessages(
    system: string,
    messages: NormalizedMessageParam[],
  ): OpenAIChatMessage[] {
    const result: OpenAIChatMessage[] = []

    // System prompt as first message
    if (system) {
      result.push({ role: 'system', content: system })
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        this.convertUserMessage(msg, result)
      } else if (msg.role === 'assistant') {
        this.convertAssistantMessage(msg, result)
      }
    }

    return result
  }

  private convertUserMessage(
    msg: NormalizedMessageParam,
    result: OpenAIChatMessage[],
  ): void {
    if (typeof msg.content === 'string') {
      result.push({ role: 'user', content: msg.content })
      return
    }

    const contentParts: Array<OpenAITextPart | OpenAIImageUrlPart> = []
    const toolResults: Array<{ tool_use_id: string; content: string }> = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        contentParts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        contentParts.push(this.convertChatImagePart(block.source))
      } else if (block.type === 'tool_result') {
        toolResults.push({
          tool_use_id: block.tool_use_id,
          content: typeof block.content === 'string'
            ? block.content
            : JSON.stringify(block.content),
        })
      }
    }

    for (const tr of toolResults) {
      result.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      })
    }

    if (contentParts.length > 0) {
      result.push({
        role: 'user',
        content: this.collapseTextOnlyChatParts(contentParts),
      })
    }
  }

  private convertImageSourceToUrl(source: any): { url: string; detail?: string } {
    if (typeof source === 'string') {
      return { url: source }
    }

    if (source?.type === 'url' && typeof source.url === 'string') {
      return { url: source.url, detail: source.detail }
    }

    if (source?.type === 'base64' && typeof source.data === 'string') {
      const mediaType = source.media_type || source.mediaType || 'image/png'
      return { url: `data:${mediaType};base64,${source.data}`, detail: source.detail }
    }

    if (source?.type === 'data_url' && typeof source.url === 'string') {
      return { url: source.url, detail: source.detail }
    }

    if (typeof source?.url === 'string') {
      return { url: source.url, detail: source.detail }
    }

    if (typeof source?.data === 'string') {
      const mediaType = source.media_type || source.mediaType || 'image/png'
      const data = source.data.startsWith('data:')
        ? source.data
        : `data:${mediaType};base64,${source.data}`
      return { url: data, detail: source.detail }
    }

    return { url: String(source ?? '') }
  }

  private convertChatImagePart(source: any): OpenAIImageUrlPart {
    const image = this.convertImageSourceToUrl(source)
    return {
      type: 'image_url',
      image_url: image.detail
        ? { url: image.url, detail: image.detail }
        : { url: image.url },
    }
  }

  private collapseTextOnlyChatParts(
    parts: Array<OpenAITextPart | OpenAIImageUrlPart>,
  ): string | Array<OpenAITextPart | OpenAIImageUrlPart> {
    if (parts.every((part) => part.type === 'text')) {
      return parts.map((part) => part.text).join('\n')
    }

    return parts
  }

  private convertAssistantMessage(
    msg: NormalizedMessageParam,
    result: Array<OpenAIChatMessage | OpenAIResponsesMessage | OpenAIResponsesFunctionCallOutput>,
  ): void {
    if (typeof msg.content === 'string') {
      result.push({ role: 'assistant', content: msg.content })
      return
    }

    // Extract text and tool_use blocks
    const textParts: string[] = []
    const toolCalls: OpenAIToolCall[] = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          type: 'function',
          function: {
            name: block.name,
            arguments: typeof block.input === 'string'
              ? block.input
              : JSON.stringify(block.input),
          },
        })
      }
    }

    const assistantMsg: OpenAIChatMessage = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : null,
    }

    if (toolCalls.length > 0) {
      assistantMsg.tool_calls = toolCalls
    }

    result.push(assistantMsg)
  }

  // --------------------------------------------------------------------------
  // Tool Conversion: Internal → OpenAI
  // --------------------------------------------------------------------------

  private convertTools(tools: NormalizedTool[]): OpenAITool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.input_schema,
      },
    }))
  }

  private convertResponsesInput(
    system: string,
    messages: NormalizedMessageParam[],
  ): Array<OpenAIResponsesMessage | OpenAIResponsesFunctionCallOutput> {
    const result: Array<OpenAIResponsesMessage | OpenAIResponsesFunctionCallOutput> = []

    if (system) {
      result.push({ role: 'system', content: system })
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content })
          continue
        }

        const contentParts: Array<OpenAIResponsesInputTextPart | OpenAIResponsesInputImagePart> = []

        for (const block of msg.content) {
          if (block.type === 'text') {
            contentParts.push({ type: 'input_text', text: block.text })
          } else if (block.type === 'image') {
            contentParts.push(this.convertResponsesImagePart(block.source))
          } else if (block.type === 'tool_result') {
            result.push({
              type: 'function_call_output',
              call_id: block.tool_use_id,
              output: typeof block.content === 'string'
                ? block.content
                : JSON.stringify(block.content),
            })
          }
        }

        if (contentParts.length > 0) {
          result.push({
            role: 'user',
            content: this.collapseTextOnlyResponsesParts(contentParts),
          })
        }

        continue
      }

      this.convertAssistantMessage(msg, result)
    }

    return result
  }

  private convertResponsesImagePart(source: any): OpenAIResponsesInputImagePart {
    const image = this.convertImageSourceToUrl(source)
    return image.detail
      ? { type: 'input_image', image_url: image.url, detail: image.detail }
      : { type: 'input_image', image_url: image.url }
  }

  private collapseTextOnlyResponsesParts(
    parts: Array<OpenAIResponsesInputTextPart | OpenAIResponsesInputImagePart>,
  ): string | Array<OpenAIResponsesInputTextPart | OpenAIResponsesInputImagePart> {
    if (parts.every((part) => part.type === 'input_text')) {
      return parts.map((part) => part.text).join('\n')
    }

    return parts
  }

  private convertResponsesTools(tools: NormalizedTool[]): Record<string, any>[] {
    return tools.map((t) => ({
      type: 'function',
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    }))
  }

  // --------------------------------------------------------------------------
  // Response Conversion: OpenAI → Internal
  // --------------------------------------------------------------------------

  private convertChatCompletionsResponse(data: OpenAIChatResponse): CreateMessageResponse {
    const choice = data.choices[0]
    if (!choice) {
      return {
        content: [{ type: 'text', text: '' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 0 },
      }
    }

    const content: NormalizedResponseBlock[] = []

    // Add text content
    if (choice.message.content) {
      content.push({ type: 'text', text: choice.message.content })
      content.push(...this.extractMarkdownImageBlocks(choice.message.content))
    }

    // Add tool calls
    if (choice.message.tool_calls) {
      for (const tc of choice.message.tool_calls) {
        let input: any
        try {
          input = JSON.parse(tc.function.arguments)
        } catch {
          input = tc.function.arguments
        }

        content.push({
          type: 'tool_use',
          id: tc.id,
          name: tc.function.name,
          input,
        })
      }
    }

    // If no content at all, add empty text
    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    // Map finish_reason to our normalized stop reasons
    const stopReason = this.mapFinishReason(choice.finish_reason)

    return {
      content,
      stopReason,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
      },
    }
  }

  private convertResponsesResponse(
    data: OpenAIResponsesResponse,
  ): CreateMessageResponse {
    if (data.status === 'failed' || data.status === 'cancelled') {
      throw createOpenAIProviderError({
        message: data.error?.message || `OpenAI Responses API returned ${data.status}`,
        category: data.status === 'cancelled' ? 'aborted' : 'provider_error',
        error: data.error,
      })
    }

    const content: NormalizedResponseBlock[] = []

    for (const item of data.output || []) {
      if (item.type === 'message') {
        for (const block of item.content || []) {
          if (block.type === 'output_text' && block.text) {
            content.push({ type: 'text', text: block.text })
            content.push(...this.extractMarkdownImageBlocks(block.text))
          }
        }
      }

      if (item.type === 'image_generation_call' && item.result) {
        content.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: item.result,
            ...(item.id ? { id: item.id } : {}),
            ...(item.revised_prompt ? { revised_prompt: item.revised_prompt } : {}),
          },
        })
      }

      if (item.type === 'function_call' && item.call_id && item.name) {
        let input: any = item.arguments || '{}'
        try {
          input = JSON.parse(item.arguments || '{}')
        } catch {
          input = item.arguments || '{}'
        }

        content.push({
          type: 'tool_use',
          id: item.call_id,
          name: item.name,
          input,
        })
      }
    }

    if (content.length === 0 && data.output_text) {
      content.push({ type: 'text', text: data.output_text })
      content.push(...this.extractMarkdownImageBlocks(data.output_text))
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    return {
      content,
      stopReason: this.mapResponsesStopReason(data, content),
      usage: {
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
      },
    }
  }

  private extractMarkdownImageBlocks(text: string): NormalizedResponseBlock[] {
    const blocks: NormalizedResponseBlock[] = []
    const imageMarkdown = /!\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g
    const seen = new Set<string>()
    let match: RegExpExecArray | null

    while ((match = imageMarkdown.exec(text)) !== null) {
      const url = match[1]
      if (!url || seen.has(url)) continue
      seen.add(url)
      blocks.push({
        type: 'image',
        source: {
          type: 'url',
          url,
          format: 'markdown_image',
        },
      })
    }

    return blocks
  }

  private mapResponsesStopReason(
    data: OpenAIResponsesResponse,
    content: NormalizedResponseBlock[],
  ): 'end_turn' | 'max_tokens' | 'tool_use' | string {
    if (content.some((block) => block.type === 'tool_use')) {
      return 'tool_use'
    }

    if (data.status === 'incomplete') {
      const reason = data.incomplete_details?.reason
      if (reason === 'max_output_tokens' || reason === 'max_tokens') {
        return 'max_tokens'
      }
      return reason || 'incomplete'
    }

    return 'end_turn'
  }

  private mapFinishReason(
    reason: string,
  ): 'end_turn' | 'max_tokens' | 'tool_use' | string {
    switch (reason) {
      case 'stop':
        return 'end_turn'
      case 'length':
        return 'max_tokens'
      case 'tool_calls':
        return 'tool_use'
      default:
        return reason
    }
  }
}
