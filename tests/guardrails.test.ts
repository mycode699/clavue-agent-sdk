import test from 'node:test'
import assert from 'node:assert/strict'

import { GuardrailRegistry } from '../src/guardrails/index.ts'
import type { Guardrail } from '../src/guardrails/index.ts'

function noSecrets(): Guardrail {
  return {
    name: 'no_secrets',
    scope: 'input',
    check: (payload) => {
      const text = String(payload ?? '')
      const found = /sk-[a-z0-9]{6,}/i.test(text)
      return found
        ? { pass: false, blocking: true, message: 'API key detected' }
        : { pass: true }
    },
  }
}

test('GuardrailRegistry rejects empty name and missing check', () => {
  const reg = new GuardrailRegistry()
  assert.throws(
    () => reg.add({ name: '', scope: 'input', check: () => ({ pass: true }) } as Guardrail),
    /non-empty string/,
  )
  assert.throws(
    () => reg.add({ name: 'x', scope: 'input' } as unknown as Guardrail),
    /must define a check/,
  )
})

test('add/remove/list/size — duplicate name replaces existing rail', () => {
  const reg = new GuardrailRegistry()
  reg.add(noSecrets())
  assert.equal(reg.size(), 1)
  reg.add({ ...noSecrets(), check: () => ({ pass: true }) }) // replace
  assert.equal(reg.size(), 1)
  reg.add({ name: 'rate', scope: 'output', check: () => ({ pass: true }) })
  assert.equal(reg.size(), 2)
  assert.deepEqual(reg.list().map((r) => r.name), ['no_secrets', 'rate'])
  reg.remove('no_secrets')
  assert.equal(reg.size(), 1)
  reg.remove('does-not-exist') // no-op
  assert.equal(reg.size(), 1)
})

test('input scope — blocking violation flips passed=false', async () => {
  const reg = new GuardrailRegistry().add(noSecrets())
  const ev = await reg.evaluate('input', 'please use sk-abcdef123 to call the api')
  assert.equal(ev.passed, false)
  assert.equal(ev.violations.length, 1)
  assert.equal(ev.violations[0]!.guardrail, 'no_secrets')
  assert.equal(ev.violations[0]!.blocking, true)
  assert.match(ev.violations[0]!.message ?? '', /API key/)
})

test('non-blocking warning still records violation but passed=true', async () => {
  const reg = new GuardrailRegistry().add({
    name: 'soft_pii',
    scope: 'output',
    check: () => ({ pass: false, blocking: false, message: 'soft warn' }),
  })
  const ev = await reg.evaluate('output', 'whatever')
  assert.equal(ev.passed, true) // non-blocking → still passed
  assert.equal(ev.violations.length, 1)
  assert.equal(ev.violations[0]!.blocking, false)
})

test('output scope passes when payload is clean', async () => {
  const reg = new GuardrailRegistry().add(noSecrets())
  const ev = await reg.evaluate('input', 'just plain text, no secrets')
  assert.equal(ev.passed, true)
  assert.deepEqual(ev.violations, [])
})

test('tool_input scope requires ctx.toolName', async () => {
  const reg = new GuardrailRegistry().add({
    name: 'block_destructive',
    scope: 'tool_input',
    check: (input) => {
      const cmd = String((input as { command?: string }).command ?? '')
      return /rm\s+-rf/.test(cmd)
        ? { pass: false, message: 'destructive command' }
        : { pass: true }
    },
  })
  await assert.rejects(
    () => reg.evaluate('tool_input', { command: 'ls' }),
    /requires ctx\.toolName/,
  )
  const ev = await reg.evaluate(
    'tool_input',
    { command: 'rm -rf /' },
    { toolName: 'Bash' },
  )
  assert.equal(ev.passed, false)
  assert.equal(ev.violations[0]!.toolName, 'Bash')
  assert.equal(ev.violations[0]!.scope, 'tool_input')
})

test('tool_output scope captures toolName + agentId in violation', async () => {
  const reg = new GuardrailRegistry().add({
    name: 'no_creds_in_output',
    scope: 'tool_output',
    check: (out) => {
      const text = String(out ?? '')
      return /AKIA[0-9A-Z]{16}/.test(text)
        ? { pass: false, message: 'AWS access key in tool output' }
        : { pass: true }
    },
  })
  const ev = await reg.evaluate(
    'tool_output',
    'value=AKIAIOSFODNN7EXAMPLE',
    { toolName: 'Read', agentId: 'reviewer' },
  )
  assert.equal(ev.passed, false)
  assert.equal(ev.violations[0]!.toolName, 'Read')
  assert.equal(ev.violations[0]!.agentId, 'reviewer')
})

test('a thrown check is reported as a blocking violation, never crashes the run', async () => {
  const reg = new GuardrailRegistry().add({
    name: 'buggy',
    scope: 'input',
    check: () => {
      throw new Error('regex blew up')
    },
  })
  const ev = await reg.evaluate('input', 'anything')
  assert.equal(ev.passed, false)
  assert.equal(ev.violations.length, 1)
  assert.equal(ev.violations[0]!.blocking, true)
  assert.match(ev.violations[0]!.message ?? '', /regex blew up/)
})

test('only rails matching scope are evaluated; other scopes are no-op', async () => {
  const reg = new GuardrailRegistry()
    .add(noSecrets())
    .add({
      name: 'output_block',
      scope: 'output',
      check: () => ({ pass: false, message: 'output rejected' }),
    })
  const inputEv = await reg.evaluate('input', 'sk-supersecretkey')
  assert.deepEqual(inputEv.violations.map((v) => v.guardrail), ['no_secrets'])
  const outputEv = await reg.evaluate('output', 'plain text')
  assert.deepEqual(outputEv.violations.map((v) => v.guardrail), ['output_block'])
})

test('empty registry → passed=true, violations=[] for any scope', async () => {
  const reg = new GuardrailRegistry()
  for (const scope of ['input', 'output'] as const) {
    const ev = await reg.evaluate(scope, 'anything')
    assert.equal(ev.passed, true)
    assert.deepEqual(ev.violations, [])
  }
})

test('all 4 scopes are independently addressable (代差 vs openai 2 scopes)', async () => {
  const reg = new GuardrailRegistry()
    .add({ name: 'i', scope: 'input', check: () => ({ pass: true }) })
    .add({ name: 'o', scope: 'output', check: () => ({ pass: true }) })
    .add({ name: 'ti', scope: 'tool_input', check: () => ({ pass: true }) })
    .add({ name: 'to', scope: 'tool_output', check: () => ({ pass: true }) })
  assert.equal(reg.size(), 4)
  // Sanity: each scope evaluates without crashing.
  await reg.evaluate('input', '')
  await reg.evaluate('output', '')
  await reg.evaluate('tool_input', '', { toolName: 'X' })
  await reg.evaluate('tool_output', '', { toolName: 'X' })
})
