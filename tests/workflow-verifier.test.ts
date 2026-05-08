import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile, chmod, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CommandVerifier, StaticVerifier } from '../src/workflow/verifier.ts'

async function makeTempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-verifier-'))
}

test('CommandVerifier rejects empty checks list', () => {
  assert.throws(() => new CommandVerifier([]), /at least one check/)
})

test('CommandVerifier reports passed for exit-code 0', async () => {
  const cwd = await makeTempDir()
  try {
    const verifier = new CommandVerifier([
      { name: 'echo', cmd: 'echo hello' },
    ])
    const results = await verifier.verify({ cwd })
    assert.equal(results.length, 1)
    assert.equal(results[0]!.name, 'echo')
    assert.equal(results[0]!.status, 'passed')
    assert.match(results[0]!.summary ?? '', /exit=0/)
    assert.match(results[0]!.summary ?? '', /hello/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('CommandVerifier reports failed for non-zero exit and captures stderr', async () => {
  const cwd = await makeTempDir()
  try {
    const verifier = new CommandVerifier([
      { name: 'fail', cmd: 'echo "bad happened" >&2; exit 7' },
    ])
    const results = await verifier.verify({ cwd })
    assert.equal(results[0]!.status, 'failed')
    assert.match(results[0]!.summary ?? '', /exit=7/)
    assert.match(results[0]!.summary ?? '', /bad happened/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('CommandVerifier runs checks sequentially and preserves order', async () => {
  const cwd = await makeTempDir()
  try {
    const verifier = new CommandVerifier([
      { name: 'first', cmd: 'echo 1' },
      { name: 'second', cmd: 'echo 2' },
      { name: 'third', cmd: 'exit 3' },
    ])
    const results = await verifier.verify({ cwd })
    assert.deepEqual(results.map((r) => r.name), ['first', 'second', 'third'])
    assert.deepEqual(results.map((r) => r.status), ['passed', 'passed', 'failed'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('CommandVerifier honors timeoutMs and reports timeout in summary', async () => {
  const cwd = await makeTempDir()
  try {
    const verifier = new CommandVerifier([
      { name: 'slow', cmd: 'sleep 5', timeoutMs: 100 },
    ])
    const results = await verifier.verify({ cwd })
    assert.equal(results[0]!.status, 'failed')
    assert.match(results[0]!.summary ?? '', /timed out after 100ms/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('CommandVerifier passes through env overlay', async () => {
  const cwd = await makeTempDir()
  try {
    const verifier = new CommandVerifier(
      [{ name: 'env', cmd: 'echo "$MY_TEST_VAR"' }],
      { env: { MY_TEST_VAR: 'hello-from-env' } },
    )
    const results = await verifier.verify({ cwd })
    assert.equal(results[0]!.status, 'passed')
    assert.match(results[0]!.summary ?? '', /hello-from-env/)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('CommandVerifier truncates long output', async () => {
  const cwd = await makeTempDir()
  try {
    const verifier = new CommandVerifier(
      [{ name: 'big', cmd: 'yes | head -c 50000' }],
      { maxOutputBytes: 200 },
    )
    const results = await verifier.verify({ cwd })
    assert.equal(results[0]!.status, 'passed')
    assert.match(results[0]!.summary ?? '', /truncated/)
    // The summary contains the [big] header + "exit=0\n" + clipped tail; sanity bound.
    assert.ok((results[0]!.summary ?? '').length < 800)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('StaticVerifier returns array results unchanged (clones)', async () => {
  const verifier = new StaticVerifier([
    { name: 'tests', status: 'passed' },
    { name: 'lint', status: 'failed', summary: 'one warning' },
  ])
  const a = await verifier.verify({ cwd: '/tmp' })
  const b = await verifier.verify({ cwd: '/tmp' })
  assert.deepEqual(a, b)
  // mutating one return value must not affect the next call
  a[0]!.status = 'failed' as any
  const c = await verifier.verify({ cwd: '/tmp' })
  assert.equal(c[0]!.status, 'passed')
})

test('StaticVerifier supports thunk providers', async () => {
  let calls = 0
  const verifier = new StaticVerifier(() => {
    calls += 1
    return [{ name: 'tests', status: calls === 1 ? 'failed' : 'passed' }]
  })
  const first = await verifier.verify({ cwd: '/tmp' })
  const second = await verifier.verify({ cwd: '/tmp' })
  assert.equal(first[0]!.status, 'failed')
  assert.equal(second[0]!.status, 'passed')
})
