import test from 'node:test'
import assert from 'node:assert/strict'

import { OpenAIProvider } from '../src/providers/openai.ts'
import { decideModelCapability, getModelCapabilities } from '../src/providers/index.ts'

test('model capability registry returns conservative deterministic metadata', async () => {
  assert.deepEqual(getModelCapabilities('openai/chatgpt-5.4', { apiType: 'openai-completions' }).known, true)
  assert.deepEqual(getModelCapabilities('anthropic/gpt-4.1', { apiType: 'anthropic-messages' }).known, false)
  assert.deepEqual(getModelCapabilities('foo/o123-model', { apiType: 'openai-completions' }).known, false)

  assert.deepEqual(getModelCapabilities('openai/gpt-5.4', { apiType: 'openai-completions' }), {
    model: 'openai/gpt-5.4',
    normalizedModel: 'gpt-5.4',
    apiType: 'openai-completions',
    transport: 'responses',
    known: true,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    supportsJsonSchema: true,
    supportsStreaming: true,
    contextWindow: 400000,
    fallback: { responsesToChatCompletionsStatuses: [400, 404, 405, 501] },
  })

  assert.deepEqual(getModelCapabilities('anthropic/claude-sonnet-4-6'), {
    model: 'anthropic/claude-sonnet-4-6',
    normalizedModel: 'claude-sonnet-4-6',
    apiType: 'anthropic-messages',
    transport: 'messages',
    known: true,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: true,
    supportsJsonSchema: true,
    supportsStreaming: true,
    contextWindow: 200000,
    pricing: { inputPerMillionUsd: 3, outputPerMillionUsd: 15 },
  })

  assert.deepEqual(getModelCapabilities('vendor/custom-model', { apiType: 'openai-completions' }), {
    model: 'vendor/custom-model',
    normalizedModel: 'custom-model',
    apiType: 'openai-completions',
    transport: 'chat_completions',
    known: false,
    supportsTools: false,
    supportsImages: false,
    supportsThinking: false,
    supportsJsonSchema: false,
    supportsStreaming: false,
  })

  assert.deepEqual(getModelCapabilities('openai/gpt-4.1', { apiType: 'openai-completions' }), {
    model: 'openai/gpt-4.1',
    normalizedModel: 'gpt-4.1',
    apiType: 'openai-completions',
    transport: 'chat_completions',
    known: true,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: false,
    supportsJsonSchema: true,
    supportsStreaming: true,
    contextWindow: 1000000,
    pricing: { inputPerMillionUsd: 2, outputPerMillionUsd: 8 },
  })

  assert.deepEqual(getModelCapabilities('openai/gpt-5.4-chat-latest', { apiType: 'openai-completions' }), {
    model: 'openai/gpt-5.4-chat-latest',
    normalizedModel: 'gpt-5.4-chat-latest',
    apiType: 'openai-completions',
    transport: 'chat_completions',
    known: true,
    supportsTools: true,
    supportsImages: true,
    supportsThinking: false,
    supportsJsonSchema: true,
    supportsStreaming: true,
    contextWindow: 400000,
  })
})

test('model capability decisions make unsupported and unknown features explicit', async () => {
  assert.deepEqual(decideModelCapability('gpt-4.1', 'thinking', { apiType: 'openai-completions' }), {
    model: 'gpt-4.1',
    normalizedModel: 'gpt-4.1',
    apiType: 'openai-completions',
    capability: 'thinking',
    supported: false,
    support: 'unsupported',
    reason: 'Model gpt-4.1 is known, but thinking support is not enabled for it.',
  })

  assert.deepEqual(decideModelCapability('vendor/custom-model', 'tools', { apiType: 'openai-completions' }), {
    model: 'vendor/custom-model',
    normalizedModel: 'custom-model',
    apiType: 'openai-completions',
    capability: 'tools',
    supported: false,
    support: 'unknown',
    reason: 'Model custom-model is unknown; tools is disabled by conservative default.',
  })
})

test('third-party OpenAI-compatible families are auto-routed and recognized as known', async () => {
  // Grok (xAI) — auto-routes to openai-completions, gains tools/streaming/json_schema.
  const grok = getModelCapabilities('grok-4-latest')
  assert.equal(grok.apiType, 'openai-completions')
  assert.equal(grok.known, true)
  assert.equal(grok.supportsTools, true)
  assert.equal(grok.supportsStreaming, true)
  assert.equal(grok.supportsJsonSchema, true)
  assert.equal(grok.supportsImages, true) // grok-4 is multimodal
  assert.equal(grok.supportsThinking, true) // grok-4 reasons by default
  assert.equal(grok.contextWindow, 256_000)

  // GLM (Zhipu) — glm-4.6 is the current flagship.
  const glm = getModelCapabilities('glm-4.6')
  assert.equal(glm.apiType, 'openai-completions')
  assert.equal(glm.known, true)
  assert.equal(glm.supportsTools, true)
  assert.equal(glm.supportsThinking, true)
  assert.equal(glm.contextWindow, 200_000)
  assert.deepEqual(glm.pricing, { inputPerMillionUsd: 0.6, outputPerMillionUsd: 2.2 })

  // Qwen (Alibaba).
  const qwen = getModelCapabilities('qwen-max')
  assert.equal(qwen.apiType, 'openai-completions')
  assert.equal(qwen.known, true)
  assert.equal(qwen.supportsTools, true)
  assert.equal(qwen.contextWindow, 32_768)

  // Kimi / Moonshot.
  const kimi = getModelCapabilities('kimi-k2-0711-preview')
  assert.equal(kimi.apiType, 'openai-completions')
  assert.equal(kimi.known, true)
  assert.equal(kimi.supportsTools, true)
  assert.equal(kimi.supportsThinking, true)

  // Gemini through OpenAI-compatible gateway.
  const gemini = getModelCapabilities('gemini-2.5-pro')
  assert.equal(gemini.apiType, 'openai-completions')
  assert.equal(gemini.known, true)
  assert.equal(gemini.supportsTools, true)
  assert.equal(gemini.supportsImages, true)
  assert.equal(gemini.contextWindow, 2_000_000)
})

test('third-party model capability gates no longer return "unknown"', async () => {
  const grokTools = decideModelCapability('grok-3', 'tools')
  assert.equal(grokTools.support, 'supported')
  assert.equal(grokTools.apiType, 'openai-completions')

  const glmStream = decideModelCapability('glm-4.5', 'streaming')
  assert.equal(glmStream.support, 'supported')

  // grok-3 is not vision; should be 'unsupported' (known) rather than 'unknown'.
  const grokVision = decideModelCapability('grok-3', 'images')
  assert.equal(grokVision.support, 'unsupported')
})

test('top-level package exports model capability helpers', async () => {
  const sdk = await import('../src/index.ts')

  assert.equal(typeof sdk.getModelCapabilities, 'function')
  assert.equal(typeof sdk.decideModelCapability, 'function')
  assert.equal(sdk.getModelCapabilities('gpt-5.4').transport, 'responses')
})

test('OpenAI provider allows unknown compatible models to prove capabilities at the gateway', async () => {
  const calls: Array<{ url: string; body: any }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })

    return new Response(
      JSON.stringify({
        id: 'chatcmpl_123',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'ok' },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })

    await provider.createMessage({
      model: 'vendor/custom-model',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
      tools: [{
        name: 'lookup',
        description: 'Lookup information.',
        input_schema: { type: 'object', properties: {} },
      }],
    })

    await provider.createMessage({
      model: 'gpt-4.1',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'disabled' },
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.url, 'https://example.test/v1/chat/completions')
  assert.equal(calls[0]?.body?.tools?.[0]?.function?.name, 'lookup')
  assert.equal(calls[1]?.url, 'https://example.test/v1/chat/completions')
})

test('OpenAI provider normalizes network fetch failures', async () => {
  const originalFetch = globalThis.fetch
  const networkError = new TypeError('fetch failed')
  globalThis.fetch = (async () => {
    throw networkError
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-4o',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'network')
        assert.equal(err.error, networkError)
        assert.match(err.message, /fetch failed/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OpenAI provider normalizes fetch abort failures', async () => {
  const originalFetch = globalThis.fetch
  const abortError = new Error('The operation was aborted')
  abortError.name = 'AbortError'
  globalThis.fetch = (async () => {
    throw abortError
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-4o',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'aborted')
        assert.equal(err.error, abortError)
        assert.match(err.message, /aborted/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('OpenAI provider preflights unsupported thinking and image requests', async () => {
  const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })

  await assert.rejects(
    provider.createMessage({
      model: 'gpt-4.1',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
      thinking: { type: 'enabled', budget_tokens: 1024 },
    }),
    (err: any) => {
      assert.equal(err.provider, 'openai')
      assert.equal(err.category, 'unsupported_capability')
      assert.equal(err.capability, 'thinking')
      assert.match(err.message, /thinking support is not enabled/)
      return true
    },
  )

  await assert.rejects(
    provider.createMessage({
      model: 'deepseek-chat',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'url', url: 'https://example.test/image.png' } }],
      }],
    }),
    (err: any) => {
      assert.equal(err.provider, 'openai')
      assert.equal(err.category, 'unsupported_capability')
      assert.equal(err.capability, 'images')
      assert.match(err.message, /images support is not enabled/)
      return true
    },
  )
})

test('OpenAI provider errors expose stable categories by status', async () => {
  const cases = [
    { status: 400, category: 'invalid_request' },
    { status: 404, category: 'unsupported' },
    { status: 408, category: 'timeout' },
    { status: 504, category: 'timeout' },
    { status: 418, category: 'unknown' },
  ]

  for (const { status, category } of cases) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify({ error: { message: `status ${status}` } }),
      { status, statusText: 'Rejected', headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

    try {
      const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
      await assert.rejects(
        provider.createMessage({
          model: 'gpt-4o',
          maxTokens: 256,
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        (err: any) => {
          assert.equal(err.provider, 'openai')
          assert.equal(err.category, category)
          assert.equal(err.status, status)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('OpenAI provider errors expose semantic categories from provider bodies', async () => {
  const cases = [
    {
      body: { error: { message: 'content filtered', code: 'content_filter' } },
      category: 'content_filter',
    },
    {
      body: { error: { message: 'maximum context length exceeded', type: 'context_length_exceeded' } },
      category: 'context_overflow',
    },
    {
      body: { error: { message: 'missing tool response message', param: 'messages.[3].tool_call_id' } },
      category: 'tool_protocol_error',
    },
    {
      body: { error: { message: 'unsupported parameter for the responses endpoint' } },
      category: 'unsupported',
    },
  ]

  for (const { body, category } of cases) {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () => new Response(
      JSON.stringify(body),
      { status: 400, statusText: 'Rejected', headers: { 'Content-Type': 'application/json' } },
    )) as typeof fetch

    try {
      const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
      await assert.rejects(
        provider.createMessage({
          model: 'gpt-4o',
          maxTokens: 256,
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        (err: any) => {
          assert.equal(err.provider, 'openai')
          assert.equal(err.category, category)
          assert.equal(err.status, 400)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  }
})

test('OpenAI provider wraps invalid provider JSON as conversion errors', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    '{not json',
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-4o',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'provider_conversion_error')
        assert.match(err.message, /parse OpenAI Chat Completions response/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('uses Responses API for gpt-5.4 models', async () => {
  const calls: Array<{ url: string; body: any }> = []

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })

    return new Response(
      JSON.stringify({
        id: 'resp_123',
        output: [
          {
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'ok' }],
          },
        ],
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
    })

    const result = await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 1024,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    assert.equal(result.content[0]?.type, 'text')
    if (result.content[0]?.type === 'text') {
      assert.equal(result.content[0].text, 'ok')
    }
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://example.test/v1/responses')
  assert.equal(calls[0]?.body?.model, 'gpt-5.4')
  assert.equal(calls[0]?.body?.max_output_tokens, 1024)
})

test('falls back to Chat Completions when a gateway does not support Responses', async () => {
  for (const status of [400, 404, 405, 501]) {
    const calls: Array<{ url: string; body: any }> = []

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      calls.push({ url, body })

      if (url.endsWith('/responses')) {
        return new Response(JSON.stringify({ error: { message: 'unsupported responses' } }), {
          status,
          statusText: 'Unsupported',
          headers: { 'Content-Type': 'application/json' },
        })
      }

      return new Response(
        JSON.stringify({
          id: 'chatcmpl_123',
          choices: [
            {
              index: 0,
              message: {
                role: 'assistant',
                content: 'fallback ok',
              },
              finish_reason: 'stop',
            },
          ],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 5,
            total_tokens: 15,
          },
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      )
    }) as typeof fetch

    try {
      const provider = new OpenAIProvider({
        apiKey: 'test-key',
        baseURL: 'https://gateway.test/v1',
      })

      const result = await provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      })

      assert.equal(result.content[0]?.type, 'text')
      if (result.content[0]?.type === 'text') {
        assert.equal(result.content[0].text, 'fallback ok')
      }
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.deepEqual(
      calls.map((call) => call.url),
      ['https://gateway.test/v1/responses', 'https://gateway.test/v1/chat/completions'],
    )
  }
})

test('does not fall back from Responses when the provider returns semantic 400 errors', async () => {
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ error: { message: 'content filtered', code: 'content_filter' } }), {
      status: 400,
      statusText: 'Rejected',
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://gateway.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'content_filter')
        assert.equal(err.status, 400)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls, ['https://gateway.test/v1/responses'])
})

test('does not fall back from Responses for generic invalid request errors', async () => {
  const calls: string[] = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    return new Response(JSON.stringify({ error: { message: 'invalid image input', type: 'invalid_request_error' } }), {
      status: 400,
      statusText: 'Rejected',
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://gateway.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'invalid_request')
        assert.equal(err.status, 400)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls, ['https://gateway.test/v1/responses'])
})

test('does not fall back from Responses for non-gateway provider errors', async () => {
  const cases = [
    { status: 401, category: 'authentication' },
    { status: 403, category: 'authorization' },
    { status: 429, category: 'rate_limit' },
    { status: 500, category: 'provider_error' },
  ]

  for (const { status, category } of cases) {
    const calls: string[] = []

    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input))
      return new Response(JSON.stringify({ error: { message: 'provider rejected request' } }), {
        status,
        statusText: 'Rejected',
        headers: { 'Content-Type': 'application/json' },
      })
    }) as typeof fetch

    try {
      const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://gateway.test/v1' })
      await assert.rejects(
        provider.createMessage({
          model: 'gpt-5.4',
          maxTokens: 256,
          system: 'You are helpful.',
          messages: [{ role: 'user', content: 'Hello' }],
        }),
        (err: any) => {
          assert.equal(err.provider, 'openai')
          assert.equal(err.category, category)
          assert.equal(err.status, status)
          return true
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    assert.deepEqual(calls, ['https://gateway.test/v1/responses'])
  }
})

test('uses Responses API for provider-prefixed gpt-5.4 models', async () => {
  const calls: Array<{ url: string; body: any }> = []

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })

    return new Response(
      JSON.stringify({
        id: 'resp_123',
        output_text: 'ok',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
    })

    await provider.createMessage({
      model: 'openai/gpt-5.4',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://example.test/v1/responses')
})

test('keeps Chat Completions for non-gpt-5 openai models', async () => {
  const calls: Array<{ url: string; body: any; signal?: AbortSignal | null }> = []
  const controller = new AbortController()

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body, signal: init?.signal ?? null })

    return new Response(
      JSON.stringify({
        id: 'chatcmpl_123',
        choices: [
          {
            index: 0,
            message: {
              role: 'assistant',
              content: 'ok',
            },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
    })

    await provider.createMessage({
      model: 'gpt-4o',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
      abortSignal: controller.signal,
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://example.test/v1/chat/completions')
  assert.equal(calls[0]?.body?.max_tokens, 256)
  assert.equal(calls[0]?.signal, controller.signal)
})

test('passes abort signals to Responses fetch calls', async () => {
  const calls: Array<{ url: string; signal?: AbortSignal | null }> = []
  const controller = new AbortController()

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal ?? null })

    return new Response(
      JSON.stringify({
        id: 'resp_123',
        output_text: 'ok',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
      abortSignal: controller.signal,
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://example.test/v1/responses')
  assert.equal(calls[0]?.signal, controller.signal)
})

test('does not fall back from Responses to Chat Completions after cancellation', async () => {
  const calls: string[] = []
  const controller = new AbortController()

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request) => {
    calls.push(String(input))
    controller.abort()
    return new Response(JSON.stringify({ error: { message: 'not found' } }), {
      status: 404,
      statusText: 'Not Found',
      headers: { 'Content-Type': 'application/json' },
    })
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
        abortSignal: controller.signal,
      }),
      (err: any) => err?.status === 404,
    )
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls, ['https://example.test/v1/responses'])
})

test('attaches response metadata to OpenAI HTTP errors', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({ error: { message: 'rate limited', type: 'rate_limit_error' } }),
    {
      status: 429,
      statusText: 'Too Many Requests',
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': '2',
      },
    },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-4o',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'rate_limit')
        assert.equal(err.status, 429)
        assert.equal(err.headers['retry-after'], '2')
        assert.equal(err.error.error.message, 'rate limited')
        assert.match(err.body, /rate limited/)
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('maps incomplete Responses output to max_tokens stop reason', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      id: 'resp_123',
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output_text: 'partial',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    const result = await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Hello' }],
    })

    assert.equal(result.stopReason, 'max_tokens')
    assert.deepEqual(result.content, [{ type: 'text', text: 'partial' }])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('throws categorized provider errors on failed Responses output', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      id: 'resp_123',
      status: 'failed',
      error: { message: 'model failed', code: 'server_error' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.match(err.message, /model failed/)
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'provider_error')
        assert.equal(err.error.code, 'server_error')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preserves semantic categories on failed Responses output', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      id: 'resp_123',
      status: 'failed',
      error: { message: 'content filtered', code: 'content_filter' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.match(err.message, /content filtered/)
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'content_filter')
        assert.equal(err.error.code, 'content_filter')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preserves context_overflow category on failed Responses output', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      id: 'resp_456',
      status: 'failed',
      error: { message: 'maximum context length exceeded', code: 'context_length_exceeded' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'context_overflow')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('preserves tool_protocol_error category on failed Responses output', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      id: 'resp_789',
      status: 'failed',
      error: { message: 'invalid tool_call_id reference', code: 'invalid_request' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'tool_protocol_error')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('falls back to provider_error when failed Responses error is unrecognized', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      id: 'resp_999',
      status: 'failed',
      error: { message: 'unexpected upstream condition', code: 'mystery' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'provider_error')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('throws categorized provider errors on cancelled Responses output', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      id: 'resp_123',
      status: 'cancelled',
      error: { message: 'response cancelled' },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await assert.rejects(
      provider.createMessage({
        model: 'gpt-5.4',
        maxTokens: 256,
        system: 'You are helpful.',
        messages: [{ role: 'user', content: 'Hello' }],
      }),
      (err: any) => {
        assert.match(err.message, /response cancelled/)
        assert.equal(err.provider, 'openai')
        assert.equal(err.category, 'aborted')
        return true
      },
    )
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('serializes user image blocks for Chat Completions', async () => {
  const calls: Array<{ url: string; body: any }> = []

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })

    return new Response(
      JSON.stringify({
        id: 'chatcmpl_123',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'ok' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-4o',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.test/image.png', detail: 'low' },
            },
          ],
        },
      ],
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls[0]?.body?.messages[1], {
    role: 'user',
    content: [
      { type: 'text', text: 'Describe this image.' },
      {
        type: 'image_url',
        image_url: { url: 'https://example.test/image.png', detail: 'low' },
      },
    ],
  })
})

test('serializes user image blocks for Responses', async () => {
  const calls: Array<{ url: string; body: any }> = []

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })

    return new Response(
      JSON.stringify({
        id: 'resp_123',
        output_text: 'ok',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this image.' },
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/jpeg', data: 'abc123' },
            },
          ],
        },
      ],
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.deepEqual(calls[0]?.body?.input[1], {
    role: 'user',
    content: [
      { type: 'input_text', text: 'Describe this image.' },
      {
        type: 'input_image',
        image_url: 'data:image/jpeg;base64,abc123',
      },
    ],
  })
})

test('normalizes Responses image generation output', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      id: 'resp_123',
      output: [
        {
          type: 'image_generation_call',
          id: 'ig_123',
          result: 'base64png',
          revised_prompt: 'A small cat',
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    const result = await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Generate an image.' }],
    })

    assert.deepEqual(result.content, [
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'base64png',
          id: 'ig_123',
          revised_prompt: 'A small cat',
        },
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('normalizes markdown image URLs from Chat Completions output', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => new Response(
    JSON.stringify({
      id: 'chatcmpl_123',
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: 'Done. ![image](https://example.test/generated.png)',
          },
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )) as typeof fetch

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    const result = await provider.createMessage({
      model: 'gpt-image-2',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'Generate an image.' }],
    })

    assert.deepEqual(result.content, [
      { type: 'text', text: 'Done. ![image](https://example.test/generated.png)' },
      {
        type: 'image',
        source: {
          type: 'url',
          url: 'https://example.test/generated.png',
          format: 'markdown_image',
        },
      },
    ])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('serializes Responses tool-call continuations with function_call_output items', async () => {
  const calls: Array<{ url: string; body: any }> = []

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })

    return new Response(
      JSON.stringify({
        id: 'resp_123',
        output_text: 'ok',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
        },
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  }) as typeof fetch

  try {
    const provider = new OpenAIProvider({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
    })

    await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 256,
      system: 'You are helpful.',
      messages: [
        { role: 'user', content: 'What is 2 + 2?' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'call_123',
              name: 'calculator',
              input: { expression: '2 + 2' },
            },
          ],
        },
        {
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'call_123',
              content: '4',
            },
          ],
        },
      ],
      tools: [
        {
          name: 'calculator',
          description: 'Evaluates arithmetic expressions',
          input_schema: {
            type: 'object',
            properties: {
              expression: { type: 'string' },
            },
            required: ['expression'],
          },
        },
      ],
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://example.test/v1/responses')
  assert.deepEqual(calls[0]?.body?.input, [
    { role: 'system', content: 'You are helpful.' },
    { role: 'user', content: 'What is 2 + 2?' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'call_123',
          type: 'function',
          function: {
            name: 'calculator',
            arguments: '{"expression":"2 + 2"}',
          },
        },
      ],
    },
    {
      type: 'function_call_output',
      call_id: 'call_123',
      output: '4',
    },
  ])
})

// --------------------------------------------------------------------------
// Structured output (outputSchema) — request shape verification
// --------------------------------------------------------------------------

function mockOnceJsonResponse(body: unknown) {
  const calls: Array<{ url: string; body: any }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }) as typeof fetch
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch
    },
  }
}

test('OpenAI Chat Completions request encodes outputSchema as response_format json_schema', async () => {
  const mock = mockOnceJsonResponse({
    id: 'chatcmpl_x',
    choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-4o',
      maxTokens: 64,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
      outputSchema: {
        name: 'verdict',
        description: 'verdict payload',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    })
  } finally {
    mock.restore()
  }

  const body = mock.calls[0]?.body
  assert.equal(mock.calls[0]?.url, 'https://example.test/v1/chat/completions')
  assert.deepEqual(body.response_format, {
    type: 'json_schema',
    json_schema: {
      name: 'verdict',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      strict: true,
      description: 'verdict payload',
    },
  })
  // No `text.format` in chat-completions requests.
  assert.equal(body.text, undefined)
})

test('OpenAI Chat Completions outputSchema defaults name to "output" and strict=true', async () => {
  const mock = mockOnceJsonResponse({
    id: 'chatcmpl_x',
    choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-4o',
      maxTokens: 64,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
      outputSchema: { schema: { type: 'object', properties: {} } },
    })
  } finally {
    mock.restore()
  }

  const body = mock.calls[0]?.body
  assert.equal(body.response_format.json_schema.name, 'output')
  assert.equal(body.response_format.json_schema.strict, true)
  assert.equal(body.response_format.json_schema.description, undefined)
})

test('OpenAI Chat Completions outputSchema honors strict=false', async () => {
  const mock = mockOnceJsonResponse({
    id: 'chatcmpl_x',
    choices: [{ index: 0, message: { role: 'assistant', content: '{}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-4o',
      maxTokens: 64,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
      outputSchema: { schema: { type: 'object', properties: {} }, strict: false },
    })
  } finally {
    mock.restore()
  }

  assert.equal(mock.calls[0]?.body.response_format.json_schema.strict, false)
})

test('OpenAI Chat Completions request without outputSchema omits response_format', async () => {
  const mock = mockOnceJsonResponse({
    id: 'chatcmpl_x',
    choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-4o',
      maxTokens: 64,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    })
  } finally {
    mock.restore()
  }

  assert.equal(mock.calls[0]?.body.response_format, undefined)
})

test('OpenAI Responses request encodes outputSchema as text.format json_schema (no json_schema wrapper)', async () => {
  const mock = mockOnceJsonResponse({
    id: 'resp_x',
    output_text: '{}',
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 64,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
      outputSchema: {
        name: 'verdict',
        schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      },
    })
  } finally {
    mock.restore()
  }

  const body = mock.calls[0]?.body
  assert.equal(mock.calls[0]?.url, 'https://example.test/v1/responses')
  assert.deepEqual(body.text, {
    format: {
      type: 'json_schema',
      name: 'verdict',
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
      strict: true,
    },
  })
  // Responses API uses text.format, not response_format.
  assert.equal(body.response_format, undefined)
})

test('OpenAI Responses request without outputSchema omits text.format', async () => {
  const mock = mockOnceJsonResponse({
    id: 'resp_x',
    output_text: 'hi',
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 64,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    })
  } finally {
    mock.restore()
  }

  assert.equal(mock.calls[0]?.body.text, undefined)
})

test('Tier A #4: Responses request emits a stable prompt_cache_key for repeated prefixes', async () => {
  const mock = mockOnceJsonResponse({
    id: 'resp_x',
    output_text: 'hi',
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    const params = {
      model: 'gpt-5.4',
      maxTokens: 64,
      system: 'You are a helpful assistant.',
      messages: [{ role: 'user' as const, content: 'first' }],
      tools: [{
        name: 'lookup',
        description: 'Lookup information.',
        input_schema: { type: 'object' as const, properties: {} },
      }],
    }
    await provider.createMessage(params)
  } finally {
    mock.restore()
  }

  const body = mock.calls[0]?.body
  assert.ok(typeof body.prompt_cache_key === 'string')
  assert.match(body.prompt_cache_key, /^clavue-sdk:[0-9a-f]{32}$/)
})

test('Tier A #4: prompt_cache_key is identical across turns when system + tools are stable', async () => {
  const mock = mockOnceJsonResponse({
    id: 'resp_x',
    output_text: 'ok',
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    const baseParams = {
      model: 'gpt-5.4',
      maxTokens: 64,
      system: 'You are a helpful assistant.',
      tools: [{
        name: 'lookup',
        description: 'Lookup information.',
        input_schema: { type: 'object' as const, properties: {} },
      }],
    }
    await provider.createMessage({
      ...baseParams,
      messages: [{ role: 'user', content: 'first turn' }],
    })
    await provider.createMessage({
      ...baseParams,
      messages: [
        { role: 'user', content: 'first turn' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'second turn' },
      ],
    })
  } finally {
    mock.restore()
  }

  assert.equal(mock.calls.length, 2)
  assert.equal(
    mock.calls[0]?.body.prompt_cache_key,
    mock.calls[1]?.body.prompt_cache_key,
    'prompt_cache_key must be stable when only the conversation grows',
  )
})

test('Tier A #4: prompt_cache_key changes when system prompt or tools change', async () => {
  const mock = mockOnceJsonResponse({
    id: 'resp_x',
    output_text: 'ok',
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 64,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'x' }],
    })
    await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 64,
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'x' }],
    })
    await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 64,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{
        name: 'lookup',
        description: 'Lookup',
        input_schema: { type: 'object', properties: {} },
      }],
    })
  } finally {
    mock.restore()
  }

  const k0 = mock.calls[0]?.body.prompt_cache_key
  const k1 = mock.calls[1]?.body.prompt_cache_key
  const k2 = mock.calls[2]?.body.prompt_cache_key
  assert.notEqual(k0, k1, 'different system prompt → different cache key')
  assert.notEqual(k0, k2, 'adding tools → different cache key')
})

test('Tier A #4: omits prompt_cache_key when there is no system + no tools to fingerprint', async () => {
  const mock = mockOnceJsonResponse({
    id: 'resp_x',
    output_text: 'ok',
    usage: { input_tokens: 1, output_tokens: 1 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-5.4',
      maxTokens: 64,
      messages: [{ role: 'user', content: 'hi' }],
    })
  } finally {
    mock.restore()
  }

  assert.equal(mock.calls[0]?.body.prompt_cache_key, undefined)
})

test('Tier A #4: Chat Completions also emits prompt_cache_key', async () => {
  const mock = mockOnceJsonResponse({
    id: 'chatcmpl_x',
    choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })

  try {
    const provider = new OpenAIProvider({ apiKey: 'test-key', baseURL: 'https://example.test/v1' })
    await provider.createMessage({
      model: 'gpt-4o',
      maxTokens: 64,
      system: 'You are helpful.',
      messages: [{ role: 'user', content: 'hi' }],
    })
  } finally {
    mock.restore()
  }

  const body = mock.calls[0]?.body
  assert.equal(body.url ?? mock.calls[0]?.url, 'https://example.test/v1/chat/completions')
  assert.match(String(body.prompt_cache_key), /^clavue-sdk:[0-9a-f]{32}$/)
})
