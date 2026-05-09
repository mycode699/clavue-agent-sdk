import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildToolResultEvents,
  buildToolResultsUserMessage,
} from '../src/engine/tool-results.ts'
import type { ToolResult } from '../src/types.ts'

function makeResult(opts: {
  id: string
  name: string
  content?: string | object
  is_error?: boolean
  pending_input?: ToolResult['pending_input']
}): ToolResult & { tool_name?: string } {
  return {
    type: 'tool_result',
    tool_use_id: opts.id,
    content: opts.content ?? 'ok',
    is_error: opts.is_error,
    tool_name: opts.name,
    pending_input: opts.pending_input,
  }
}

test('buildToolResultEvents emits one tool_result event per result', () => {
  const events = buildToolResultEvents('sess-1', 'run-1', [
    makeResult({ id: 't1', name: 'Read', content: 'file content' }),
    makeResult({ id: 't2', name: 'Glob', content: 'a.ts\nb.ts' }),
  ])
  assert.equal(events.length, 2)
  assert.equal(events[0]!.type, 'tool_result')
  assert.equal(events[1]!.type, 'tool_result')
})

test('buildToolResultEvents preserves tool_use_id and tool_name', () => {
  const events = buildToolResultEvents('sess-1', 'run-1', [
    makeResult({ id: 'abc', name: 'Bash', content: 'pwd output' }),
  ])
  if (events[0]!.type !== 'tool_result') return assert.fail()
  assert.equal(events[0]!.result.tool_use_id, 'abc')
  assert.equal(events[0]!.result.tool_name, 'Bash')
  assert.equal(events[0]!.result.output, 'pwd output')
})

test('buildToolResultEvents JSON-stringifies non-string content', () => {
  const events = buildToolResultEvents('sess-1', 'run-1', [
    makeResult({ id: 't1', name: 'Custom', content: { foo: 'bar', n: 42 } }),
  ])
  if (events[0]!.type !== 'tool_result') return assert.fail()
  assert.equal(events[0]!.result.output, '{"foo":"bar","n":42}')
})

test('buildToolResultEvents emits pending_input event before its tool_result', () => {
  const events = buildToolResultEvents('sess-1', 'run-1', [
    makeResult({
      id: 't1',
      name: 'AskUser',
      content: 'waiting',
      pending_input: { type: 'select', options: [{ label: 'a' }] } as any,
    }),
  ])
  assert.equal(events.length, 2)
  assert.equal(events[0]!.type, 'system')
  if (events[0]!.type === 'system') {
    assert.equal((events[0] as any).subtype, 'pending_input')
  }
  assert.equal(events[1]!.type, 'tool_result')
})

test('buildToolResultEvents uses empty string for missing tool_name (legacy contract)', () => {
  const events = buildToolResultEvents('sess-1', 'run-1', [
    makeResult({ id: 't1', name: '' }),
  ])
  if (events[0]!.type !== 'tool_result') return assert.fail()
  assert.equal(events[0]!.result.tool_name, '')
})

test('buildToolResultsUserMessage produces a single user message with N tool_result blocks', () => {
  const msg = buildToolResultsUserMessage([
    makeResult({ id: 't1', name: 'Read', content: 'a' }),
    makeResult({ id: 't2', name: 'Glob', content: 'b' }),
    makeResult({ id: 't3', name: 'Bash', content: 'c', is_error: true }),
  ])
  assert.equal(msg.role, 'user')
  assert.ok(Array.isArray(msg.content))
  const blocks = msg.content as any[]
  assert.equal(blocks.length, 3)
  assert.equal(blocks[0].type, 'tool_result')
  assert.equal(blocks[0].tool_use_id, 't1')
  assert.equal(blocks[0].content, 'a')
  assert.equal(blocks[2].is_error, true)
})

test('buildToolResultsUserMessage JSON-stringifies object content for history append', () => {
  const msg = buildToolResultsUserMessage([
    makeResult({ id: 't1', name: 'Custom', content: { x: 1 } }),
  ])
  const blocks = msg.content as any[]
  assert.equal(blocks[0].content, '{"x":1}')
})
