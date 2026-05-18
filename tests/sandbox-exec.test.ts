/**
 * exec-sandbox unit tests — pure (command, args, settings) → wrap mapping.
 * No actual spawning; we only verify the produced argv shape per
 * platform driver.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildMacSandboxProfile,
  wrapSpawnForSandbox,
} from '../src/sandbox/exec-sandbox.ts'

const NEVER_EXISTS = (_p: string) => false
const ALWAYS_EXISTS = (_p: string) => true

test('disabled settings → pass-through with driver=disabled', () => {
  const w = wrapSpawnForSandbox({
    command: 'bash',
    args: ['-c', 'echo hi'],
    cwd: '/tmp/work',
  })
  assert.equal(w.driver, 'disabled')
  assert.equal(w.command, 'bash')
  assert.deepEqual(w.args, ['-c', 'echo hi'])
})

test('enabled but unsupported platform → returns unsupported with notice', () => {
  const w = wrapSpawnForSandbox({
    command: 'bash',
    args: ['-c', 'echo hi'],
    cwd: '/tmp/work',
    settings: { enabled: true },
    platformOverride: 'win32',
    binaryExists: NEVER_EXISTS,
  })
  assert.equal(w.driver, 'unsupported')
  assert.equal(w.command, 'bash')
  assert.match(w.notice ?? '', /win32/)
})

test('darwin + sandbox-exec available → wraps with -p profile', () => {
  const w = wrapSpawnForSandbox({
    command: 'bash',
    args: ['-c', 'ls'],
    cwd: '/repo',
    settings: { enabled: true, network: { allowManagedDomainsOnly: true } },
    platformOverride: 'darwin',
    binaryExists: ALWAYS_EXISTS,
  })
  assert.equal(w.driver, 'sandbox-exec')
  assert.equal(w.command, '/usr/bin/sandbox-exec')
  assert.equal(w.args[0], '-p')
  // Profile should include the SBPL header and a deny-network rule.
  assert.match(w.args[1]!, /\(version 1\)/)
  assert.match(w.args[1]!, /\(deny default\)/)
  assert.match(w.args[1]!, /\(deny network\*/)
  // Original command tails the argv.
  assert.equal(w.args[2], 'bash')
  assert.equal(w.args[3], '-c')
  assert.equal(w.args[4], 'ls')
})

test('darwin without sandbox-exec → unsupported (no false-positive wrap)', () => {
  const w = wrapSpawnForSandbox({
    command: 'bash',
    args: ['-c', 'ls'],
    cwd: '/repo',
    settings: { enabled: true },
    platformOverride: 'darwin',
    binaryExists: NEVER_EXISTS,
  })
  assert.equal(w.driver, 'unsupported')
})

test('linux + bwrap → wraps with --bind cwd and --unshare-net when network restricted', () => {
  const w = wrapSpawnForSandbox({
    command: 'bash',
    args: ['-c', 'pwd'],
    cwd: '/repo',
    settings: {
      enabled: true,
      network: { allowedDomains: ['example.com'] },
      filesystem: { allowWrite: ['/tmp/cache'] },
    },
    platformOverride: 'linux',
    binaryExists: ALWAYS_EXISTS,
  })
  assert.equal(w.driver, 'bwrap')
  assert.equal(w.command, '/usr/bin/bwrap')
  assert.ok(w.args.includes('--unshare-net'), 'restricted network → --unshare-net')
  // --bind cwd /repo /repo
  const bindIdx = w.args.indexOf('--bind')
  assert.ok(bindIdx >= 0)
  assert.equal(w.args[bindIdx + 1], '/repo')
  assert.equal(w.args[bindIdx + 2], '/repo')
  // allowWrite path also bound rw.
  assert.ok(w.args.lastIndexOf('--bind') > bindIdx, 'allowWrite path → second --bind')
  // Original command must end the argv.
  const cmdIdx = w.args.indexOf('bash')
  assert.ok(cmdIdx > 0)
  assert.equal(w.args[cmdIdx + 1], '-c')
  assert.equal(w.args[cmdIdx + 2], 'pwd')
})

test('linux + bwrap with fully open network → no --unshare-net', () => {
  const w = wrapSpawnForSandbox({
    command: 'sh',
    args: ['-c', 'true'],
    cwd: '/repo',
    settings: { enabled: true },
    platformOverride: 'linux',
    binaryExists: ALWAYS_EXISTS,
  })
  assert.equal(w.driver, 'bwrap')
  assert.ok(!w.args.includes('--unshare-net'), 'open network → keep host net')
})

test('buildMacSandboxProfile: allowWrite paths produce subpath rules; quotes escaped', () => {
  const profile = buildMacSandboxProfile({
    cwd: '/repo',
    settings: {
      enabled: true,
      filesystem: {
        allowWrite: ['/tmp/with"quote'],
        denyWrite: ['/etc'],
        denyRead: ['/Users/secret'],
      },
    },
  })
  assert.match(profile, /\(allow file-write\* \(subpath "\/repo"\)\)/)
  assert.match(profile, /\(allow file-write\* \(subpath "\/tmp\/with\\"quote"\)\)/)
  assert.match(profile, /\(deny file-write\* \(subpath "\/etc"\)\)/)
  assert.match(profile, /\(deny file-read\* \(subpath "\/Users\/secret"\)\)/)
})
