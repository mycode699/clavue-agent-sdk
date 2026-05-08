import test from 'node:test'
import assert from 'node:assert/strict'

import { extractSessionMemoryCandidates } from '../src/index.ts'
import type { Message } from '../src/types.ts'

function userMessage(content: string, uuid = `u-${Math.random().toString(36).slice(2)}`): Message {
  return {
    type: 'user',
    message: { role: 'user', content },
    uuid,
    timestamp: new Date('2026-05-08T00:00:00.000Z').toISOString(),
  }
}

function assistantMessage(text: string, uuid = `a-${Math.random().toString(36).slice(2)}`): Message {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
    },
    uuid,
    timestamp: new Date('2026-05-08T00:00:01.000Z').toISOString(),
  }
}

test('extractSessionMemoryCandidates classifies feedback signals as feedback', () => {
  const messages = [
    userMessage('Please prefer concise responses and avoid extra confirmations.'),
  ]

  const candidates = extractSessionMemoryCandidates(messages, { repoPath: '/tmp/r' })

  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.type, 'feedback')
  assert.equal(candidate.scope, 'repo')
  assert.equal(candidate.repoPath, '/tmp/r')
  assert.equal(candidate.confidence, 'high')
  // tags include 'feedback' (type), 'auto', 'concise', 'confirmations'
  assert.ok(candidate.tags?.includes('feedback'))
  assert.ok(candidate.tags?.includes('auto'))
  assert.ok(candidate.tags?.includes('concise'))
  assert.ok(candidate.tags?.includes('confirmations'))
  // Title uses the canonical concise template
  assert.equal(candidate.title, 'Prefer concise responses')
})

test('extractSessionMemoryCandidates classifies decision-lead phrasing as decision', () => {
  const messages = [
    userMessage('For this repo, use OpenAI-compatible providers instead of Anthropic Claude.'),
  ]

  const candidates = extractSessionMemoryCandidates(messages, {
    repoPath: '/tmp/r',
    sessionId: 'sess-1',
  })

  assert.equal(candidates.length, 1)
  const candidate = candidates[0]
  assert.equal(candidate.type, 'decision')
  // "instead of" triggers high confidence
  assert.equal(candidate.confidence, 'high')
  assert.equal(candidate.sessionId, 'sess-1')
  // OpenAI + Anthropic mention triggers the canonical title
  assert.equal(candidate.title, 'Use OpenAI-compatible provider')
  // Tags include both provider tags
  assert.ok(candidate.tags?.includes('decision'))
  assert.ok(candidate.tags?.includes('openai'))
  assert.ok(candidate.tags?.includes('anthropic'))
  // 'provider' tag requires the singular word; 'providers' doesn't match \bprovider\b
  assert.equal(candidate.tags?.includes('provider'), false)
})

test('extractSessionMemoryCandidates ignores assistant messages', () => {
  const messages = [
    assistantMessage('Please prefer concise responses and avoid extra confirmations.'),
  ]

  const candidates = extractSessionMemoryCandidates(messages, {})
  assert.equal(candidates.length, 0)
})

test('extractSessionMemoryCandidates ignores non-string user content', () => {
  const messages: Message[] = [
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Please prefer concise responses for this repo.' }],
      },
      uuid: 'u-1',
      timestamp: new Date().toISOString(),
    },
  ]

  const candidates = extractSessionMemoryCandidates(messages, {})
  assert.equal(candidates.length, 0)
})

test('extractSessionMemoryCandidates filters lines that are too short or too long', () => {
  const tooShort = 'too short'
  const tooLong = 'prefer ' + 'x'.repeat(400)
  const justRight = 'Please prefer concise and brief responses for this project.'
  const messages = [userMessage([tooShort, tooLong, justRight].join('\n'))]

  const candidates = extractSessionMemoryCandidates(messages, {})
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].content.includes('concise'), true)
})

test('extractSessionMemoryCandidates dedupes identical candidates across messages', () => {
  const text = 'Please prefer concise responses for this project.'
  const messages = [userMessage(text, 'u-1'), userMessage(text, 'u-2')]

  const candidates = extractSessionMemoryCandidates(messages, { repoPath: '/tmp/repo' })
  assert.equal(candidates.length, 1)
})

test('extractSessionMemoryCandidates strips list bullets and "remember that" prefixes', () => {
  const messages = [
    userMessage('- remember that we are using OpenAI-compatible providers here.'),
  ]
  const candidates = extractSessionMemoryCandidates(messages, {})
  assert.equal(candidates.length, 1)
  // The "remember that" / leading bullet should have been stripped from content
  assert.equal(candidates[0].content.startsWith('-'), false)
  assert.equal(/^remember that/i.test(candidates[0].content), false)
  assert.equal(candidates[0].type, 'decision')
})

test('extractSessionMemoryCandidates returns nothing for unclassifiable text', () => {
  const messages = [
    userMessage('The weather forecast for tomorrow looks rainy across the city.'),
  ]
  const candidates = extractSessionMemoryCandidates(messages, {})
  assert.equal(candidates.length, 0)
})

test('extractSessionMemoryCandidates marks "we are using" as high confidence decision', () => {
  const messages = [
    userMessage("Going forward we are using pnpm for all package management here."),
  ]
  const candidates = extractSessionMemoryCandidates(messages, {})
  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].type, 'decision')
  assert.equal(candidates[0].confidence, 'high')
})
