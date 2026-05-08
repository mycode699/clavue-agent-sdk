/**
 * Unit tests for the pure quality-gate helpers extracted from
 * `QueryEngine`. These tests exercise resolution + terminal-failure
 * detection without spinning up the full engine.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  findTerminalQualityGateFailure,
  resolveActiveQualityGatePolicy,
} from '../src/engine/quality-gate-helpers.js'

test('resolveActiveQualityGatePolicy returns config policy when no skill gates', () => {
  const policy = { required: ['lint', 'test'] }
  assert.equal(
    resolveActiveQualityGatePolicy(policy, []),
    policy,
  )
})

test('resolveActiveQualityGatePolicy returns undefined when neither side has data', () => {
  assert.equal(resolveActiveQualityGatePolicy(undefined, []), undefined)
})

test('resolveActiveQualityGatePolicy merges skill gates into config required list', () => {
  const policy = { required: ['lint'] }
  const merged = resolveActiveQualityGatePolicy(policy, ['typecheck', 'test'])
  assert.deepEqual(merged?.required?.sort(), ['lint', 'test', 'typecheck'])
})

test('resolveActiveQualityGatePolicy creates a policy from skill gates alone', () => {
  const merged = resolveActiveQualityGatePolicy(undefined, ['build'])
  assert.deepEqual(merged?.required, ['build'])
})

test('findTerminalQualityGateFailure returns undefined when no policy', () => {
  assert.equal(findTerminalQualityGateFailure(undefined, []), undefined)
})

test('findTerminalQualityGateFailure flags missing required gate as pending', () => {
  const failure = findTerminalQualityGateFailure(
    { required: ['lint'] },
    [],
  )
  assert.deepEqual(failure, {
    name: 'lint',
    status: 'pending',
    summary: 'Required quality gate did not report a result',
  })
})

test('findTerminalQualityGateFailure flags failed required gate', () => {
  const failure = findTerminalQualityGateFailure(
    { required: ['lint'] },
    [{ name: 'lint', status: 'failed', summary: 'eslint reported errors' }],
  )
  assert.equal(failure?.status, 'failed')
  assert.equal(failure?.name, 'lint')
})

test('findTerminalQualityGateFailure ignores passing required gate', () => {
  const failure = findTerminalQualityGateFailure(
    { required: ['lint'] },
    [{ name: 'lint', status: 'passed', summary: 'ok' }],
  )
  assert.equal(failure, undefined)
})

test('findTerminalQualityGateFailure scans all gates when no required list', () => {
  const failure = findTerminalQualityGateFailure(
    {},
    [
      { name: 'lint', status: 'passed', summary: 'ok' },
      { name: 'test', status: 'failed', summary: 'flaky' },
    ],
  )
  assert.equal(failure?.name, 'test')
})

test('findTerminalQualityGateFailure honors custom failStatuses', () => {
  const failure = findTerminalQualityGateFailure(
    { required: ['lint'], failStatuses: ['blocked'] },
    [{ name: 'lint', status: 'blocked', summary: 'sandbox refused' }],
  )
  assert.equal(failure?.status, 'blocked')
})
