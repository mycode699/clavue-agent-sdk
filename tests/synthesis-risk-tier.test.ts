import test from 'node:test'
import assert from 'node:assert/strict'

import type { ToolDefinition, ToolSafetyAnnotations } from '../src/index.ts'

function fakeTool(name: string, safety?: ToolSafetyAnnotations, isReadOnly?: boolean): ToolDefinition {
  return {
    name,
    description: name,
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: '' }),
    safety,
    isReadOnly: isReadOnly === undefined ? undefined : () => isReadOnly,
  }
}

test('inferSynthesisRiskTier: read-only tool routes to system_initiated', async () => {
  const { inferSynthesisRiskTier } = await import('../src/index.ts')
  // Read tool: safety.read=true, idempotent=true
  const tool = fakeTool('Read', { read: true, idempotent: true })
  assert.equal(inferSynthesisRiskTier(tool), 'system_initiated')
})

test('inferSynthesisRiskTier: isReadOnly()=true alone routes to system_initiated', async () => {
  const { inferSynthesisRiskTier } = await import('../src/index.ts')
  const tool = fakeTool('Glob', undefined, true)
  assert.equal(inferSynthesisRiskTier(tool), 'system_initiated')
})

test('inferSynthesisRiskTier: local file write routes to llm_requested', async () => {
  const { inferSynthesisRiskTier } = await import('../src/index.ts')
  // Edit tool: write + destructive + approvalRequired but no shell/network/externalState
  const tool = fakeTool('Edit', { read: true, write: true, destructive: true, approvalRequired: true })
  assert.equal(inferSynthesisRiskTier(tool), 'llm_requested')
})

test('inferSynthesisRiskTier: network tool routes to llm_requested', async () => {
  const { inferSynthesisRiskTier } = await import('../src/index.ts')
  // WebFetch: network + externalState + approvalRequired, NOT shell/destructive
  const tool = fakeTool('WebFetch', { read: true, network: true, externalState: true, approvalRequired: true })
  assert.equal(inferSynthesisRiskTier(tool), 'llm_requested')
})

test('inferSynthesisRiskTier: shell tool routes to approval_required', async () => {
  const { inferSynthesisRiskTier } = await import('../src/index.ts')
  // Bash: shell + destructive + everything
  const tool = fakeTool('Bash', {
    read: true,
    write: true,
    shell: true,
    network: true,
    externalState: true,
    destructive: true,
    approvalRequired: true,
  })
  assert.equal(inferSynthesisRiskTier(tool), 'approval_required')
})

test('inferSynthesisRiskTier: destructive external-state tool routes to approval_required', async () => {
  const { inferSynthesisRiskTier } = await import('../src/index.ts')
  // A hypothetical "delete-remote-issue" tool
  const tool = fakeTool('DeleteRemoteIssue', {
    write: true,
    externalState: true,
    destructive: true,
    approvalRequired: true,
  })
  assert.equal(inferSynthesisRiskTier(tool), 'approval_required')
})

test('inferSynthesisRiskTier: external-state non-destructive routes to llm_requested', async () => {
  const { inferSynthesisRiskTier } = await import('../src/index.ts')
  // SendMessage: write + externalState + approvalRequired, no shell/destructive
  const tool = fakeTool('SendMessage', { write: true, externalState: true, approvalRequired: true })
  assert.equal(inferSynthesisRiskTier(tool), 'llm_requested')
})

test('inferSynthesisRiskTier: tool with no safety annotations defaults to llm_requested', async () => {
  const { inferSynthesisRiskTier } = await import('../src/index.ts')
  // Unknown tool, no safety, no isReadOnly → write inferred (!read), no other flags → mid tier
  const tool = fakeTool('Unknown')
  assert.equal(inferSynthesisRiskTier(tool), 'llm_requested')
})

test('routeSynthesisCandidates: groups a mixed tool list into three buckets', async () => {
  const { routeSynthesisCandidates } = await import('../src/index.ts')
  const tools: ToolDefinition[] = [
    fakeTool('Read', { read: true, idempotent: true }),
    fakeTool('Glob', undefined, true),
    fakeTool('Edit', { read: true, write: true, destructive: true, approvalRequired: true }),
    fakeTool('WebFetch', { read: true, network: true, externalState: true, approvalRequired: true }),
    fakeTool('Bash', { shell: true, destructive: true, approvalRequired: true }),
  ]
  const grouped = routeSynthesisCandidates(tools)
  assert.deepEqual(
    grouped.system_initiated.map((t) => t.name).sort(),
    ['Glob', 'Read'],
  )
  assert.deepEqual(
    grouped.llm_requested.map((t) => t.name).sort(),
    ['Edit', 'WebFetch'],
  )
  assert.deepEqual(
    grouped.approval_required.map((t) => t.name),
    ['Bash'],
  )
})
