import test from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  BashTool,
  FileEditTool,
  FileReadTool,
  FileWriteTool,
  GlobTool,
  GrepTool,
  LSPTool,
  ListMcpResourcesTool,
  WebFetchTool,
  WebSearchTool,
  TodoWriteTool,
  clearTodos,
  getTodos,
  TeamCreateTool,
  clearTeams,
  getAllTeams,
  saveSession,
  loadSession,
  listSessions,
  createFileStateCache,
} from '../src/index.ts'
import { setMcpConnections } from '../src/tools/mcp-resource-tools.ts'

test('GrepTool reports invalid regex errors instead of falling through to no matches', async () => {
  const result = await GrepTool.call({ pattern: '[' }, { cwd: process.cwd() })

  assert.equal(result.is_error, true)
  assert.match(String(result.content), /regex|pattern|grep/i)
})

test('BashTool blocks destructive commands before execution', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bash-safety-'))
  const result = await BashTool.call({ command: 'rm -rf .', timeout: 1000 }, { cwd: dir })

  assert.equal(result.is_error, true)
  assert.match(String(result.content), /destructive command/i)
  assert.match(String(result.content), /rm -rf/i)
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

test('file tools reject paths outside the workspace root', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'workspace-root-'))
  const outside = await mkdtemp(join(tmpdir(), 'workspace-outside-'))
  const outsideFile = join(outside, 'secret.txt')
  await writeFile(outsideFile, 'secret')

  const readResult = await FileReadTool.call(
    { file_path: outsideFile },
    { cwd: workspace, workspaceRoot: workspace },
  )
  const writeResult = await FileWriteTool.call(
    { file_path: outsideFile, content: 'changed' },
    { cwd: workspace, workspaceRoot: workspace },
  )
  const editResult = await FileEditTool.call(
    { file_path: outsideFile, old_string: 'secret', new_string: 'changed' },
    { cwd: workspace, workspaceRoot: workspace },
  )
  const globResult = await GlobTool.call(
    { pattern: '*.txt', path: outside },
    { cwd: workspace, workspaceRoot: workspace },
  )
  const grepResult = await GrepTool.call(
    { pattern: 'secret', path: outsideFile },
    { cwd: workspace, workspaceRoot: workspace },
  )

  assert.equal(readResult.is_error, true)
  assert.match(String(readResult.content), /outside.*workspace/i)
  assert.equal(writeResult.is_error, true)
  assert.match(String(writeResult.content), /outside.*workspace/i)
  assert.equal(editResult.is_error, true)
  assert.match(String(editResult.content), /outside.*workspace/i)
  assert.equal(globResult.is_error, true)
  assert.match(String(globResult.content), /outside.*workspace/i)
  assert.equal(grepResult.is_error, true)
  assert.match(String(grepResult.content), /outside.*workspace/i)
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
  const context = { cwd: process.cwd(), runtimeNamespace: 'mcp-resource-test' }
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
  ], context)

  try {
    const result = await ListMcpResourcesTool.call({}, context)

    assert.equal(result.is_error, undefined)
    assert.match(String(result.content), /Server: docs/)
    assert.match(String(result.content), /Guide/)
  } finally {
    setMcpConnections([], context)
  }
})

test('process-local tool stores are isolated by runtime namespace', async () => {
  const first = { cwd: process.cwd(), runtimeNamespace: 'tools-isolation-a' }
  const second = { cwd: process.cwd(), runtimeNamespace: 'tools-isolation-b' }

  clearTodos(first)
  clearTodos(second)
  clearTeams(first)
  clearTeams(second)

  try {
    await TodoWriteTool.call({ action: 'add', text: 'first todo' }, first)
    await TodoWriteTool.call({ action: 'add', text: 'second todo' }, second)
    await TeamCreateTool.call({ name: 'first team' }, first)
    await TeamCreateTool.call({ name: 'second team' }, second)

    assert.deepEqual(getTodos(first).map(todo => todo.text), ['first todo'])
    assert.deepEqual(getTodos(second).map(todo => todo.text), ['second todo'])
    assert.deepEqual(getTodos(first).map(todo => todo.id), [1])
    assert.deepEqual(getTodos(second).map(todo => todo.id), [1])

    assert.deepEqual(getAllTeams(first).map(team => team.name), ['first team'])
    assert.deepEqual(getAllTeams(second).map(team => team.name), ['second team'])
    assert.deepEqual(getAllTeams(first).map(team => team.id), ['team_1'])
    assert.deepEqual(getAllTeams(second).map(team => team.id), ['team_1'])
  } finally {
    clearTodos(first)
    clearTodos(second)
    clearTeams(first)
    clearTeams(second)
  }
})

test('session store options isolate persisted transcripts by directory', async () => {
  const firstDir = await mkdtemp(join(tmpdir(), 'sessions-a-'))
  const secondDir = await mkdtemp(join(tmpdir(), 'sessions-b-'))
  const messages = [{ role: 'user' as const, content: 'hello' }]

  await saveSession('same-id', messages, { cwd: firstDir, model: 'model-a' }, { dir: firstDir })
  await saveSession('same-id', messages, { cwd: secondDir, model: 'model-b' }, { dir: secondDir })

  const first = await loadSession('same-id', { dir: firstDir })
  const second = await loadSession('same-id', { dir: secondDir })
  const firstSessions = await listSessions({ dir: firstDir })
  const secondSessions = await listSessions({ dir: secondDir })

  assert.equal(first?.metadata.model, 'model-a')
  assert.equal(second?.metadata.model, 'model-b')
  assert.deepEqual(firstSessions.map(session => session.model), ['model-a'])
  assert.deepEqual(secondSessions.map(session => session.model), ['model-b'])
})

test('session ids cannot escape the configured session store', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'sessions-safe-'))
  const outside = join(dir, '..', 'escaped-session')
  const messages = [{ role: 'user' as const, content: 'hello' }]

  await assert.rejects(
    saveSession('../escaped-session', messages, { cwd: dir, model: 'model-a' }, { dir }),
    /invalid session id/i,
  )
  await assert.rejects(
    saveSession('/tmp/escaped-session', messages, { cwd: dir, model: 'model-a' }, { dir }),
    /invalid session id/i,
  )

  assert.equal(await loadSession('../escaped-session', { dir }), null)
  await assert.rejects(access(outside))
})

// ---------------------------------------------------------------------------
// Slice I — File State Cache ↔ Read/Edit interaction
// ---------------------------------------------------------------------------

test('Slice I: FileReadTool populates the shared file state cache', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slicei-read-'))
  const file = join(dir, 'a.txt')
  await writeFile(file, 'first\nsecond\nthird\n')

  const cache = createFileStateCache()
  const result = await FileReadTool.call(
    { file_path: file },
    { cwd: dir, fileStateCache: cache },
  )

  assert.equal(result.is_error ?? false, false)
  const cached = cache.get(file)
  assert.ok(cached, 'expected cache to be populated by Read')
  assert.equal(cached!.content, 'first\nsecond\nthird\n')
  assert.ok(cached!.timestamp > 0)
})

test('Slice I: FileEditTool refreshes the cache after a successful edit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slicei-refresh-'))
  const file = join(dir, 'b.txt')
  await writeFile(file, 'hello world')

  const cache = createFileStateCache()
  const ctx = { cwd: dir, fileStateCache: cache }

  await FileReadTool.call({ file_path: file }, ctx)
  const beforeEdit = cache.get(file)!.timestamp

  // Wait one tick so mtime can advance on filesystems with millisecond precision.
  await new Promise((resolve) => setTimeout(resolve, 10))

  const editResult = await FileEditTool.call(
    { file_path: file, old_string: 'hello', new_string: 'hi' },
    ctx,
  )
  assert.equal(editResult.is_error ?? false, false)

  const afterEdit = cache.get(file)
  assert.ok(afterEdit, 'cache should remain populated post-edit')
  assert.equal(afterEdit!.content, 'hi world')
  assert.ok(afterEdit!.timestamp >= beforeEdit, 'timestamp should not regress')
})

test('Slice I: FileEditTool rejects when the file changed out-of-band since last Read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slicei-stale-'))
  const file = join(dir, 'c.txt')
  await writeFile(file, 'original')

  const cache = createFileStateCache()
  const ctx = { cwd: dir, fileStateCache: cache }

  await FileReadTool.call({ file_path: file }, ctx)

  // Simulate an out-of-band modification by another process.
  await new Promise((resolve) => setTimeout(resolve, 10))
  await writeFile(file, 'externally modified')

  const editResult = await FileEditTool.call(
    { file_path: file, old_string: 'externally', new_string: 'never' },
    ctx,
  )

  assert.equal(editResult.is_error, true)
  assert.match(String(editResult.content), /modified since it was last read|re-read/i)
  // The on-disk file should remain whatever the external writer left.
  // (Edit must not have written.)
})

test('Slice I: FileEditTool works without a cache (back-compat)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slicei-nocache-'))
  const file = join(dir, 'd.txt')
  await writeFile(file, 'a b c')

  const result = await FileEditTool.call(
    { file_path: file, old_string: 'b', new_string: 'B' },
    { cwd: dir },
  )

  assert.equal(result.is_error ?? false, false)
})
