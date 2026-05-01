import test from 'node:test'
import assert from 'node:assert/strict'

import { Agent, AskUserQuestionTool, clearQuestionHandler, setPendingInputHandler, setQuestionHandler } from '../src/index.ts'

class PendingQuestionProvider {
  readonly apiType = 'openai-completions' as const
  private calls = 0

  constructor(private readonly toolUseId = 'question-tool-1') {}

  async createMessage() {
    this.calls += 1
    if (this.calls === 1) {
      return {
        content: [{
          type: 'tool_use' as const,
          id: this.toolUseId,
          name: 'AskUserQuestion',
          input: {
            question: 'Which environment should be deployed?',
            options: ['staging', 'production'],
            allow_multiselect: false,
            timeout_ms: 2500,
          },
        }],
        stopReason: 'tool_use' as const,
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    }

    return {
      content: [{ type: 'text' as const, text: 'continued safely' }],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

test('AskUserQuestion emits typed pending input metadata in non-interactive runs', async () => {
  clearQuestionHandler({ runtimeNamespace: 'pending-input-test' })
  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [AskUserQuestionTool],
    runtimeNamespace: 'pending-input-test',
  })
  ;(agent as any).provider = new PendingQuestionProvider()

  try {
    const events = []
    for await (const event of agent.query('Ask before deploying')) {
      events.push(event)
    }

    const pending = events.find((event) => event.type === 'system' && event.subtype === 'pending_input')
    assert.ok(pending, 'expected a typed pending_input event')
    assert.equal(pending.tool_use_id, 'question-tool-1')
    assert.equal(pending.question.prompt, 'Which environment should be deployed?')
    assert.deepEqual(pending.question.options, ['staging', 'production'])
    assert.equal(pending.question.allow_multiselect, false)
    assert.equal(pending.question.timeout_ms, 2500)
    assert.equal(pending.question.default_behavior, 'continue_without_answer')
    assert.match(pending.question.id, /^pending_input_/)

    const toolResult = events.find((event) => event.type === 'tool_result' && event.result.tool_use_id === 'question-tool-1')
    assert.ok(toolResult)
    assert.match(toolResult.result.output, /No user available to answer/)
  } finally {
    await agent.close()
  }
})

test('AskUserQuestion host handler receives structured pending input metadata', async () => {
  const namespace = 'pending-input-handler-test'
  const received = []
  setPendingInputHandler(async (question) => {
    received.push(question)
    return 'staging'
  }, { runtimeNamespace: namespace })

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [AskUserQuestionTool],
    runtimeNamespace: namespace,
  })
  ;(agent as any).provider = new PendingQuestionProvider('question-tool-2')

  try {
    const events = []
    for await (const event of agent.query('Ask before deploying')) {
      events.push(event)
    }

    assert.equal(received.length, 1)
    assert.equal(received[0].prompt, 'Which environment should be deployed?')
    assert.deepEqual(received[0].options, ['staging', 'production'])
    assert.equal(received[0].allow_multiselect, false)
    assert.equal(received[0].timeout_ms, 2500)
    assert.equal(received[0].default_behavior, 'continue_without_answer')
    assert.match(received[0].id, /^pending_input_/)

    assert.equal(events.some((event) => event.type === 'system' && event.subtype === 'pending_input'), false)
    const toolResult = events.find((event) => event.type === 'tool_result' && event.result.tool_use_id === 'question-tool-2')
    assert.equal(toolResult.result.output, 'staging')
  } finally {
    clearQuestionHandler({ runtimeNamespace: namespace })
    await agent.close()
  }
})

test('AskUserQuestion remains compatible with legacy string handlers', async () => {
  const namespace = 'pending-input-legacy-handler-test'
  const received = []
  setQuestionHandler(async (question, options) => {
    received.push({ question, options })
    return 'production'
  }, { runtimeNamespace: namespace })

  const agent = new Agent({
    model: 'gpt-5.4',
    tools: [AskUserQuestionTool],
    runtimeNamespace: namespace,
  })
  ;(agent as any).provider = new PendingQuestionProvider('question-tool-3')

  try {
    const events = []
    for await (const event of agent.query('Ask before deploying')) {
      events.push(event)
    }

    assert.deepEqual(received, [{
      question: 'Which environment should be deployed?',
      options: ['staging', 'production'],
    }])
    const toolResult = events.find((event) => event.type === 'tool_result' && event.result.tool_use_id === 'question-tool-3')
    assert.equal(toolResult.result.output, 'production')
  } finally {
    clearQuestionHandler({ runtimeNamespace: namespace })
    await agent.close()
  }
})
