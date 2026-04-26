import test from 'node:test'
import assert from 'node:assert/strict'

import { Agent, sdkToolToToolDefinition, tool } from '../src/index.ts'
import { AgentTool, clearAgents, extractTextFromContent } from '../src/index.ts'
import { compactConversation, createAutoCompactState } from '../src/utils/compact.ts'
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from '../src/index.ts'

class StubProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  calls: CreateMessageParams[] = []

  constructor(private readonly responses: CreateMessageResponse[]) {}

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.calls.push(params)
    return this.responses.shift() ?? {
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

test('extractTextFromContent includes image placeholders', () => {
  const text = extractTextFromContent([
    { type: 'text', text: 'Generated:' },
    {
      type: 'image',
      source: { type: 'url', url: 'https://example.test/generated.png' },
    },
  ])

  assert.equal(text, 'Generated:[Image: https://example.test/generated.png]')
})

test('Agent.run preserves image blocks in text artifact', async () => {
  const agent = new Agent({ model: 'gpt-5.4', tools: [] })
  ;(agent as any).provider = new StubProvider([
    {
      content: [
        { type: 'text', text: 'Generated image' },
        {
          type: 'image',
          source: { type: 'url', url: 'https://example.test/generated.png' },
        },
      ],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ])

  try {
    const result = await agent.run('generate')
    assert.equal(result.text, 'Generated image[Image: https://example.test/generated.png]')
    assert.deepEqual(result.events.find((event) => event.type === 'assistant')?.message.content, [
      { type: 'text', text: 'Generated image' },
      {
        type: 'image',
        source: { type: 'url', url: 'https://example.test/generated.png' },
      },
    ])
  } finally {
    await agent.close()
  }
})

test('sdk tool conversion labels image content without embedding data', async () => {
  const sdkTool = tool(
    'image_tool',
    'returns an image',
    {},
    async () => ({
      content: [
        { type: 'text', text: 'created' },
        { type: 'image', data: 'base64png', mimeType: 'image/png' },
      ],
    }),
  )
  const converted = sdkToolToToolDefinition(sdkTool)
  const result = await converted.call({}, { cwd: process.cwd() })

  assert.equal(result.content, 'created\n[Image: image/png]')
})

test('AgentTool returns subagent image placeholders', async () => {
  const provider = new StubProvider([
    {
      content: [
        { type: 'text', text: 'Subagent generated' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
      ],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ])

  try {
    const result = await AgentTool.call(
      { prompt: 'generate', description: 'generate image' },
      {
        cwd: process.cwd(),
        provider,
        model: 'gpt-5.4',
        apiType: 'openai-completions',
      },
    )

    assert.equal(result.content, 'Subagent generated\n[Image: image/png base64]')
  } finally {
    clearAgents()
  }
})

test('compaction replaces image blocks with textual placeholders', async () => {
  const provider = new StubProvider([
    {
      content: [{ type: 'text', text: 'summary mentions image placeholder' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  ])

  const result = await compactConversation(
    provider,
    'gpt-5.4',
    [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Generated image' },
          { type: 'image', source: { type: 'url', url: 'https://example.test/generated.png' } },
        ],
      },
    ],
    createAutoCompactState(),
  )

  assert.match(String(provider.calls[0]?.messages[0]?.content), /\[Image: https:\/\/example\.test\/generated\.png\]/)
  assert.equal(result.summary, 'summary mentions image placeholder')
})
