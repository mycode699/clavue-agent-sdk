/**
 * Regression — tool-policy defaults and the public expectations of each
 * `permissionMode`. These tests pin the SDK's library-first defaults so a
 * future "secure by default" overhaul is a deliberate, opt-in change with
 * a corresponding schema bump rather than a quiet behavior shift.
 *
 * Pins:
 *   - createDefaultToolPolicy() with no argument → 'trustedAutomation'.
 *   - 'default' / 'auto' / 'dontAsk' / 'plan' / 'acceptEdits' deny BashTool
 *     (shell + approvalRequired). 'trustedAutomation' / 'bypassPermissions'
 *     allow it.
 *   - sandboxed preset emits permissionMode='auto' + repo-readonly toolset.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { BashTool } from '../src/tools/bash.ts'
import { FileReadTool } from '../src/tools/read.ts'
import { createDefaultToolPolicy } from '../src/types/tools.ts'
import { expandAgentPreset } from '../src/runtime-profiles.ts'

test('createDefaultToolPolicy() defaults to trustedAutomation', () => {
  const p = createDefaultToolPolicy()
  assert.equal(p.permissionMode, 'trustedAutomation')
})

test('trustedAutomation allows shell-executing BashTool', async () => {
  const p = createDefaultToolPolicy('trustedAutomation')
  const decision = await p.canUseTool(BashTool, { command: 'echo hi' })
  assert.equal(decision.behavior, 'allow')
})

test('default mode denies BashTool (shell + approvalRequired)', async () => {
  const p = createDefaultToolPolicy('default')
  const decision = await p.canUseTool(BashTool, { command: 'echo hi' })
  assert.equal(decision.behavior, 'deny')
})

test('default mode allows read-only ReadTool', async () => {
  const p = createDefaultToolPolicy('default')
  const decision = await p.canUseTool(FileReadTool, { file_path: '/tmp/x' })
  assert.equal(decision.behavior, 'allow')
})

test('plan mode denies BashTool', async () => {
  const p = createDefaultToolPolicy('plan')
  const decision = await p.canUseTool(BashTool, { command: 'echo hi' })
  assert.equal(decision.behavior, 'deny')
})

test('acceptEdits denies BashTool (shell flag set)', async () => {
  const p = createDefaultToolPolicy('acceptEdits')
  const decision = await p.canUseTool(BashTool, { command: 'echo hi' })
  assert.equal(decision.behavior, 'deny')
})

test('auto / dontAsk modes deny destructive+approvalRequired BashTool', async () => {
  for (const mode of ['auto', 'dontAsk'] as const) {
    const p = createDefaultToolPolicy(mode)
    const decision = await p.canUseTool(BashTool, { command: 'echo hi' })
    assert.equal(decision.behavior, 'deny', `${mode} should deny BashTool`)
  }
})

test('bypassPermissions allows BashTool', async () => {
  const p = createDefaultToolPolicy('bypassPermissions')
  const decision = await p.canUseTool(BashTool, { command: 'echo hi' })
  assert.equal(decision.behavior, 'allow')
})

test('sandboxed preset emits auto + repo-readonly toolset', () => {
  const expanded = expandAgentPreset('sandboxed')
  assert.equal(expanded.permissionMode, 'auto')
  assert.deepEqual(expanded.toolsets, ['repo-readonly'])
  assert.equal(expanded.memory?.enabled, false)
})
