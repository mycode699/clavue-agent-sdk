import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { FileReadTool, GrepTool, LSPTool, ListMcpResourcesTool, WebFetchTool, WebSearchTool } from '../src/index.ts'
import { setMcpConnections } from '../src/tools/mcp-resource-tools.ts'

test('GrepTool reports invalid regex errors instead of falling through to no matches', async () => {
  const result = await GrepTool.call({ pattern: '[' }, { cwd: process.cwd() })

  assert.equal(result.is_error, true)
  assert.match(String(result.content), /regex|pattern|grep/i)
})

test('FileReadTool validates offset and limit boundaries', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'read-tool-'))
  const file = join(dir, 'sample.txt')
  await writeFile(file, 'one\ntwo\nthree')

  const negativeOffset = await FileReadTool.call({ file_path: file, offset: -1 }, { cwd: dir })
  const zeroLimit = await FileReadTool.call({ file_path: file, limit: 0 }, { cwd: dir })

  assert.equal(negativeOffset.is_error, true)
  assert.match(String(negativeOffset.content), /offset/i)
  assert.equal(zeroLimit.is_error, true)
  assert.match(String(zeroLimit.content), /limit/i)
})

test('LSPTool searches symbols without shell interpolation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lsp-tool-'))
  await writeFile(join(dir, 'source.ts'), 'export function safeSymbol() { return 1 }\nconsole.log(safeSymbol())\n')

  const result = await LSPTool.call(
    { operation: 'workspaceSymbol', query: 'safeSymbol' },
    { cwd: dir },
  )

  assert.equal(result.is_error, undefined)
  assert.match(String(result.content), /safeSymbol/)
})

test('web tools compose timeout and context abort signals', async () => {
  const calls: Array<{ url: string; signal?: AbortSignal | null }> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), signal: init?.signal ?? null })
    return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }) as typeof fetch

  const controller = new AbortController()

  try {
    await WebFetchTool.call({ url: 'https://example.test/page' }, { cwd: process.cwd(), abortSignal: controller.signal })
    await WebSearchTool.call({ query: 'clavue sdk' }, { cwd: process.cwd(), abortSignal: controller.signal })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(calls.length, 2)
  assert.ok(calls[0]?.signal)
  assert.ok(calls[1]?.signal)
  assert.notEqual(calls[0]?.signal, controller.signal)
  assert.notEqual(calls[1]?.signal, controller.signal)

  controller.abort()
  assert.equal(calls[0]?.signal?.aborted, true)
  assert.equal(calls[1]?.signal?.aborted, true)
})

test('ListMcpResources awaits async MCP resource listings', async () => {
  setMcpConnections([
    {
      name: 'docs',
      status: 'connected',
      tools: [],
      _client: {
        listResources: async () => ({
          resources: [
            { name: 'Guide', uri: 'docs://guide', description: 'Usage guide' },
          ],
        }),
      },
    } as any,
  ])

  try {
    const result = await ListMcpResourcesTool.call({}, { cwd: process.cwd() })

    assert.equal(result.is_error, undefined)
    assert.match(String(result.content), /Server: docs/)
    assert.match(String(result.content), /Guide/)
  } finally {
    setMcpConnections([])
  }
})
