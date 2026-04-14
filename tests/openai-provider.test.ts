import test from 'node:test'
import assert from 'node:assert/strict'

import { OpenAIProvider } from '../src/providers/openai.ts'

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
  const calls: Array<{ url: string; body: any }> = []

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ url, body })

    if (url.endsWith('/responses')) {
      return new Response(JSON.stringify({ error: { message: 'not found' } }), {
        status: 404,
        statusText: 'Not Found',
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
    })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.url, 'https://example.test/v1/chat/completions')
  assert.equal(calls[0]?.body?.max_tokens, 256)
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
