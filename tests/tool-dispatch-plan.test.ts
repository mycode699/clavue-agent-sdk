import test from 'node:test'
import assert from 'node:assert/strict'

import { planToolDispatch } from '../src/engine/tool-helpers.js'
import type { ToolDefinition } from '../src/types.js'

function makeTool(name: string, opts: { readOnly: boolean; concurrencySafe: boolean }): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    isReadOnly: () => opts.readOnly,
    isConcurrencySafe: () => opts.concurrencySafe,
    isEnabled: () => true,
    async prompt() { return name },
    async call() {
      return { type: 'tool_result', tool_use_id: '', content: '' }
    },
  }
}

const READ_ONLY = makeTool('Read', { readOnly: true, concurrencySafe: true })
const GREP = makeTool('Grep', { readOnly: true, concurrencySafe: true })
const WRITE = makeTool('Write', { readOnly: false, concurrencySafe: false })
const BASH = makeTool('Bash', { readOnly: false, concurrencySafe: false })

test('Slice H planner: empty input returns empty plan', () => {
  const plan = planToolDispatch([], () => undefined)
  assert.deepEqual(plan, [])
})

test('Slice H planner: all concurrent tools collapse into one concurrent batch', () => {
  const blocks = [
    { name: 'Read', input: {} },
    { name: 'Grep', input: {} },
    { name: 'Read', input: {} },
  ]
  const lookup = (n: string) => ({ Read: READ_ONLY, Grep: GREP }[n])
  const plan = planToolDispatch(blocks, lookup)
  assert.equal(plan.length, 1)
  assert.equal(plan[0]!.kind, 'concurrent')
  assert.equal(plan[0]!.entries.length, 3)
})

test('Slice H planner: non-concurrent tool breaks the concurrent run', () => {
  const blocks = [
    { name: 'Read', input: {} },
    { name: 'Read', input: {} },
    { name: 'Bash', input: {} },
    { name: 'Grep', input: {} },
  ]
  const lookup = (n: string) => ({ Read: READ_ONLY, Grep: GREP, Bash: BASH }[n])
  const plan = planToolDispatch(blocks, lookup)
  assert.equal(plan.length, 3)
  assert.equal(plan[0]!.kind, 'concurrent')
  assert.equal(plan[0]!.entries.length, 2)
  assert.equal(plan[1]!.kind, 'serial')
  assert.equal(plan[1]!.entries[0]!.block.name, 'Bash')
  assert.equal(plan[2]!.kind, 'concurrent')
  assert.equal(plan[2]!.entries.length, 1)
})

test('Slice H planner: order preservation across mixed sequence', () => {
  const blocks = [
    { name: 'Bash', input: {} },
    { name: 'Read', input: {} },
    { name: 'Write', input: {} },
    { name: 'Grep', input: {} },
    { name: 'Read', input: {} },
  ]
  const lookup = (n: string) => ({ Read: READ_ONLY, Grep: GREP, Bash: BASH, Write: WRITE }[n])
  const plan = planToolDispatch(blocks, lookup)
  // Expected: [serial Bash], [concurrent Read], [serial Write], [concurrent Grep, Read]
  assert.equal(plan.length, 4)
  assert.equal(plan[0]!.entries[0]!.block.name, 'Bash')
  assert.equal(plan[1]!.kind, 'concurrent')
  assert.equal(plan[1]!.entries[0]!.block.name, 'Read')
  assert.equal(plan[2]!.entries[0]!.block.name, 'Write')
  assert.equal(plan[3]!.kind, 'concurrent')
  assert.deepEqual(plan[3]!.entries.map((e) => e.block.name), ['Grep', 'Read'])
})

test('Slice H planner: unknown tool falls into serial bucket (defensive)', () => {
  const blocks = [
    { name: 'Read', input: {} },
    { name: 'Mystery', input: {} },
    { name: 'Read', input: {} },
  ]
  const lookup = (n: string) => ({ Read: READ_ONLY }[n]) // Mystery → undefined
  const plan = planToolDispatch(blocks, lookup)
  assert.equal(plan.length, 3)
  assert.equal(plan[0]!.kind, 'concurrent')
  assert.equal(plan[1]!.kind, 'serial')
  assert.equal(plan[1]!.entries[0]!.block.name, 'Mystery')
  assert.equal(plan[1]!.entries[0]!.tool, undefined)
  assert.equal(plan[2]!.kind, 'concurrent')
})

test('Slice H planner: tool flagged read-only but not concurrencySafe is serial', () => {
  const SEMI = makeTool('Semi', { readOnly: true, concurrencySafe: false })
  const blocks = [
    { name: 'Read', input: {} },
    { name: 'Semi', input: {} },
  ]
  const lookup = (n: string) => ({ Read: READ_ONLY, Semi: SEMI }[n])
  const plan = planToolDispatch(blocks, lookup)
  assert.equal(plan.length, 2)
  assert.equal(plan[0]!.kind, 'concurrent')
  assert.equal(plan[1]!.kind, 'serial')
})
