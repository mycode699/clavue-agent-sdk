import test from 'node:test'
import assert from 'node:assert/strict'

import {
  estimateTokens,
  estimateMessagesTokens,
  estimateSystemPromptTokens,
  getTokenCountFromUsage,
  getContextWindowSize,
  getAutoCompactThreshold,
  estimateCost,
  MODEL_PRICING,
  AUTOCOMPACT_BUFFER_TOKENS,
  AUTOCOMPACT_BUFFER_FRACTION,
} from '../src/utils/tokens.ts'

test('estimateTokens returns 0 for empty string and at least 1 for non-empty', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('a'), 1)
  assert.ok(estimateTokens('hello world') >= 1)
})

test('estimateTokens uses smaller divisor (more tokens) for CJK than for English', () => {
  // Same character count, different content classes.
  const english = 'abcdefghijabcdefghijabcdefghijabcdefghijabcdefghij' // 50 chars
  const cjk = '你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世界你好世' // 35 CJK chars
  const englishTokens = estimateTokens(english)
  const cjkTokens = estimateTokens(cjk)
  // CJK uses ~1.6 chars/token, English ~4.0; CJK should yield more tokens per char.
  assert.ok(cjkTokens / cjk.length > englishTokens / english.length, `cjk density should exceed english (cjk=${cjkTokens}/${cjk.length}, en=${englishTokens}/${english.length})`)
})

test('estimateTokens classifies code-like content with denser tokens than prose', () => {
  const prose = 'the quick brown fox jumped over the lazy dog repeatedly today and yesterday morning lightly'
  // Code-like: lots of brackets, semicolons, equals.
  const code = 'function f(a,b){const x={y:1};return (x.y===a)?b:b+1;} function g(){return f(1,2);}'
  // Equalize lengths roughly.
  const ratioProse = estimateTokens(prose) / prose.length
  const ratioCode = estimateTokens(code) / code.length
  assert.ok(ratioCode >= ratioProse, `code ratio should be at least prose ratio (code=${ratioCode}, prose=${ratioProse})`)
})

test('estimateTokens treats JSON-shaped strings as denser tokens', () => {
  const json = '{"name":"clavue","tools":["bash","read"],"params":{"k":1,"v":2}}'
  const same_length_text = 'a'.repeat(json.length)
  assert.ok(estimateTokens(json) > estimateTokens(same_length_text), 'json should produce more tokens than equal-length plain english chars')
})

test('estimateMessagesTokens accumulates per-message overhead and per-block overhead', () => {
  const empty: Array<{ role: string; content: any }> = []
  assert.equal(estimateMessagesTokens(empty), 0)

  const oneEmpty = [{ role: 'user', content: '' }]
  // Per-message overhead is 3.
  assert.equal(estimateMessagesTokens(oneEmpty), 3)

  const oneText = [{ role: 'user', content: 'hello world' }]
  assert.ok(estimateMessagesTokens(oneText) > 3)

  const blocks = [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_result', content: '{"ok":true}' },
        { type: 'tool_use', name: 'bash', input: { cmd: 'ls' } },
      ],
    },
  ]
  const total = estimateMessagesTokens(blocks)
  // 3 (per-message) + 3 * (1 per-block overhead) + content estimates >= 6.
  assert.ok(total >= 6, `expected accumulated total to be >= 6, got ${total}`)
})

test('estimateSystemPromptTokens delegates to estimateTokens', () => {
  const prompt = 'You are a helpful agent.'
  assert.equal(estimateSystemPromptTokens(prompt), estimateTokens(prompt))
  assert.equal(estimateSystemPromptTokens(''), 0)
})

test('getTokenCountFromUsage sums all token fields including optional cache fields', () => {
  assert.equal(
    getTokenCountFromUsage({ input_tokens: 10, output_tokens: 5 }),
    15,
  )
  assert.equal(
    getTokenCountFromUsage({
      input_tokens: 10,
      output_tokens: 5,
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
    }),
    20,
  )
})

test('getContextWindowSize returns model-specific windows with sane default', () => {
  assert.equal(getContextWindowSize('claude-opus-4-1m'), 1_000_000)
  assert.equal(getContextWindowSize('claude-opus-4-5'), 200_000)
  assert.equal(getContextWindowSize('claude-sonnet-4-5'), 200_000)
  assert.equal(getContextWindowSize('gpt-4o'), 128_000)
  assert.equal(getContextWindowSize('gpt-4-1'), 1_000_000)
  assert.equal(getContextWindowSize('gpt-3.5-turbo'), 16_385)
  assert.equal(getContextWindowSize('o3-mini'), 200_000)
  assert.equal(getContextWindowSize('deepseek-chat'), 128_000)
  // Default fallback for unknown model.
  assert.equal(getContextWindowSize('totally-unknown-model'), 200_000)
})

test('getAutoCompactThreshold reserves at least the minimum buffer and proportional headroom', () => {
  // Small window: minimum buffer dominates.
  const small = 16_385
  const smallThreshold = getAutoCompactThreshold('gpt-3.5-turbo')
  assert.equal(smallThreshold, small - AUTOCOMPACT_BUFFER_TOKENS)

  // Large window: proportional fraction dominates.
  const largeWindow = getContextWindowSize('claude-opus-4-1m')
  const expectedLarge = largeWindow - Math.ceil(largeWindow * AUTOCOMPACT_BUFFER_FRACTION)
  assert.equal(getAutoCompactThreshold('claude-opus-4-1m'), expectedLarge)

  // Threshold is always strictly less than window for non-trivial windows.
  assert.ok(getAutoCompactThreshold('claude-sonnet-4-5') < getContextWindowSize('claude-sonnet-4-5'))
})

test('estimateCost matches MODEL_PRICING for known model and falls back for unknown', () => {
  const usage = { input_tokens: 1000, output_tokens: 500 }

  const knownModel = 'claude-sonnet-4-5'
  const pricing = MODEL_PRICING[knownModel]
  assert.ok(pricing, 'expected pricing entry to exist for sanity check')
  const expected = usage.input_tokens * pricing.input + usage.output_tokens * pricing.output
  assert.ok(Math.abs(estimateCost(knownModel, usage) - expected) < 1e-12)

  // Unknown model uses default pricing (3/1M input, 15/1M output).
  const fallback = estimateCost('totally-unknown-model', usage)
  const expectedFallback = usage.input_tokens * (3 / 1_000_000) + usage.output_tokens * (15 / 1_000_000)
  assert.ok(Math.abs(fallback - expectedFallback) < 1e-12)
})

test('estimateCost returns 0 when usage is zero', () => {
  assert.equal(estimateCost('gpt-4o', { input_tokens: 0, output_tokens: 0 }), 0)
})

test('AUTOCOMPACT buffer constants have plausible values', () => {
  assert.ok(AUTOCOMPACT_BUFFER_TOKENS > 0)
  assert.ok(AUTOCOMPACT_BUFFER_FRACTION > 0 && AUTOCOMPACT_BUFFER_FRACTION < 1)
})
