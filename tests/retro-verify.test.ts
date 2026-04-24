import test from 'node:test'
import assert from 'node:assert/strict'

import { runRetroVerification } from '../src/index.ts'

test('runRetroVerification passes all successful gates', async () => {
  const result = await runRetroVerification({
    target: { name: 'clavue-agent-sdk' },
    gates: [
      {
        name: 'node-ok',
        command: 'node',
        args: ['-e', 'process.stdout.write("gate-ok")'],
      },
      {
        name: 'node-ok-2',
        command: 'node',
        args: ['-e', 'process.stdout.write("gate-ok-2")'],
      },
    ],
  })

  assert.equal(result.passed, true)
  assert.equal(result.gates.length, 2)
  assert.equal(result.gates[0]?.passed, true)
  assert.equal(result.gates[0]?.stdout, 'gate-ok')
  assert.equal(result.gates[1]?.passed, true)
  assert.equal(result.summary, 'All 2 quality gate(s) passed.')
  assert.ok(result.durationMs >= 0)
})

test('runRetroVerification stops on the first failed gate', async () => {
  const result = await runRetroVerification({
    target: { name: 'clavue-agent-sdk' },
    gates: [
      {
        name: 'node-fail',
        command: 'node',
        args: ['-e', 'process.stderr.write("boom"); process.exit(2)'],
      },
      {
        name: 'should-not-run',
        command: 'node',
        args: ['-e', 'process.stdout.write("skip")'],
      },
    ],
  })

  assert.equal(result.passed, false)
  assert.equal(result.gates.length, 1)
  assert.equal(result.gates[0]?.name, 'node-fail')
  assert.equal(result.gates[0]?.passed, false)
  assert.equal(result.gates[0]?.exitCode, 2)
  assert.equal(result.gates[0]?.stderr, 'boom')
  assert.equal(result.summary, 'Quality gate failed: node-fail.')
})

test('runRetroVerification reports spawn errors as failed gates', async () => {
  const result = await runRetroVerification({
    target: { name: 'clavue-agent-sdk' },
    gates: [
      {
        name: 'missing-command',
        command: 'definitely-not-a-real-command',
      },
    ],
  })

  assert.equal(result.passed, false)
  assert.equal(result.gates.length, 1)
  assert.equal(result.gates[0]?.name, 'missing-command')
  assert.equal(result.gates[0]?.passed, false)
  assert.equal(result.gates[0]?.exitCode, null)
  assert.ok(result.gates[0]?.error)
})

test('runRetroVerification can continue after a failed gate when requested', async () => {
  const result = await runRetroVerification({
    target: { name: 'clavue-agent-sdk' },
    gates: [
      {
        name: 'node-fail',
        command: 'node',
        args: ['-e', 'process.stderr.write("boom"); process.exit(2)'],
        continueOnFailure: true,
      },
      {
        name: 'node-ok',
        command: 'node',
        args: ['-e', 'process.stdout.write("gate-ok")'],
      },
    ],
  })

  assert.equal(result.passed, false)
  assert.equal(result.gates.length, 2)
  assert.equal(result.gates[0]?.name, 'node-fail')
  assert.equal(result.gates[1]?.name, 'node-ok')
  assert.equal(result.gates[1]?.passed, true)
  assert.equal(result.gates[1]?.stdout, 'gate-ok')
})
