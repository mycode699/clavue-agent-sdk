import test from 'node:test'
import assert from 'node:assert/strict'

import type { ToolDefinition } from '../src/index.ts'

function fakeTool(name: string, description: string, safety?: any, isReadOnly?: boolean): ToolDefinition {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties: {} },
    call: async () => ({ type: 'tool_result', tool_use_id: '', content: '' }),
    safety,
    isReadOnly: isReadOnly === undefined ? undefined : () => isReadOnly,
  }
}

test('ToolSearch keyword search labels each match with its synthesis risk tier', async () => {
  const ns = `tool-search-tier-${Date.now()}-1`
  const { ToolSearchTool, setDeferredTools } = await import('../src/index.ts')
  setDeferredTools(
    [
      fakeTool('ReadFile', 'read a file', { read: true, idempotent: true }),
      fakeTool('EditFile', 'edit a file', { read: true, write: true, destructive: true, approvalRequired: true }),
      fakeTool('RunShell', 'run a shell command', { shell: true, destructive: true, approvalRequired: true }),
    ],
    { runtimeNamespace: ns },
  )

  const result = await ToolSearchTool.call({ query: 'file shell' }, { cwd: '/tmp', runtimeNamespace: ns })
  const content = String(result.content)

  // Each match line should include a tier tag.
  assert.match(content, /ReadFile.*\[tier: system_initiated\]/)
  assert.match(content, /EditFile.*\[tier: llm_requested\]/)
  assert.match(content, /RunShell.*\[tier: approval_required\]/)
})

test('ToolSearch select: matches also include tier label', async () => {
  const ns = `tool-search-tier-${Date.now()}-2`
  const { ToolSearchTool, setDeferredTools } = await import('../src/index.ts')
  setDeferredTools(
    [
      fakeTool('WebFetcher', 'fetch a URL', { read: true, network: true, externalState: true, approvalRequired: true }),
    ],
    { runtimeNamespace: ns },
  )

  const result = await ToolSearchTool.call({ query: 'select:WebFetcher' }, { cwd: '/tmp', runtimeNamespace: ns })
  assert.match(String(result.content), /WebFetcher.*\[tier: llm_requested\]/)
})

test('ToolSearch with no deferred tools returns the original message unchanged', async () => {
  const ns = `tool-search-tier-${Date.now()}-3`
  const { ToolSearchTool, setDeferredTools } = await import('../src/index.ts')
  setDeferredTools([], { runtimeNamespace: ns })
  const result = await ToolSearchTool.call({ query: 'anything' }, { cwd: '/tmp', runtimeNamespace: ns })
  assert.equal(String(result.content), 'No deferred tools available.')
})

test('ToolSearch with no matches preserves the original "not found" message', async () => {
  const ns = `tool-search-tier-${Date.now()}-4`
  const { ToolSearchTool, setDeferredTools } = await import('../src/index.ts')
  setDeferredTools(
    [fakeTool('ReadFile', 'read a file', { read: true, idempotent: true })],
    { runtimeNamespace: ns },
  )
  const result = await ToolSearchTool.call({ query: 'zzz_no_match' }, { cwd: '/tmp', runtimeNamespace: ns })
  assert.match(String(result.content), /No tools found/)
})
