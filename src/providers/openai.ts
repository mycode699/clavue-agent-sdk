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
} from './types.js'

// --------------------------------------------------------------------------
// OpenAI-specific types (minimal, just what we need)
// --------------------------------------------------------------------------

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string | null
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
  usage?: {
    input_tokens?: number
    output_tokens?: number
    total_tokens?: number
  }
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
    if (this.shouldUseResponsesApi(params.model)) {
      return this.createResponsesMessage(params)
    }

    return this.createChatCompletionsMessage(params)
  }

  private shouldUseResponsesApi(model: string): boolean {
    const normalized = model.toLowerCase()
    return normalized.includes('gpt-5')
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

    const response = await fetch(`${this.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errBody = await response.text().catch(() => '')
      const err: any = new Error(
        `OpenAI API error: ${response.status} ${response.statusText}: ${errBody}`,
      )
      err.status = response.status
      throw err
    }

    const data = (await response.json()) as OpenAIChatResponse
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

    const response = await fetch(`${this.baseURL}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      if (this.shouldFallbackToChatCompletions(response.status)) {
        return this.createChatCompletionsMessage(params)
      }

      const errBody = await response.text().catch(() => '')
      const err: any = new Error(
        `OpenAI API error: ${response.status} ${response.statusText}: ${errBody}`,
      )
      err.status = response.status
      throw err
    }

    const data = (await response.json()) as OpenAIResponsesResponse
    return this.convertResponsesResponse(data)
  }

  private shouldFallbackToChatCompletions(status: number): boolean {
    return status === 400 || status === 404 || status === 405 || status === 501
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

    // Content blocks may contain text and/or tool_result blocks
    const textParts: string[] = []
    const toolResults: Array<{ tool_use_id: string; content: string }> = []

    for (const block of msg.content) {
      if (block.type === 'text') {
        textParts.push(block.text)
      } else if (block.type === 'tool_result') {
        toolResults.push({
          tool_use_id: block.tool_use_id,
          content: block.content,
        })
      }
    }

    // Tool results become separate tool messages
    for (const tr of toolResults) {
      result.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content: tr.content,
      })
    }

    // Text parts become a user message
    if (textParts.length > 0) {
      result.push({ role: 'user', content: textParts.join('\n') })
    }
  }

  private convertAssistantMessage(
    msg: NormalizedMessageParam,
    result: Array<OpenAIChatMessage | OpenAIResponsesFunctionCallOutput>,
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
  ): Array<OpenAIChatMessage | OpenAIResponsesFunctionCallOutput> {
    const result: Array<OpenAIChatMessage | OpenAIResponsesFunctionCallOutput> = []

    if (system) {
      result.push({ role: 'system', content: system })
    }

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'user', content: msg.content })
          continue
        }

        const textParts: string[] = []

        for (const block of msg.content) {
          if (block.type === 'text') {
            textParts.push(block.text)
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

        if (textParts.length > 0) {
          result.push({ role: 'user', content: textParts.join('\n') })
        }

        continue
      }

      this.convertAssistantMessage(msg, result)
    }

    return result
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
    const content: NormalizedResponseBlock[] = []

    for (const item of data.output || []) {
      if (item.type === 'message') {
        for (const block of item.content || []) {
          if (block.type === 'output_text' && block.text) {
            content.push({ type: 'text', text: block.text })
          }
        }
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
    }

    if (content.length === 0) {
      content.push({ type: 'text', text: '' })
    }

    return {
      content,
      stopReason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
      usage: {
        input_tokens: data.usage?.input_tokens || 0,
        output_tokens: data.usage?.output_tokens || 0,
      },
    }
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
