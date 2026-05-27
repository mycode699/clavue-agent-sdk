/**
 * Desktop module — unit tests (no network, no real OS UI).
 *
 * These tests verify wiring (tool registration, MCP naming, tier filtering,
 * cross-platform safe fallbacks). Live OS-interactive paths (screencapture,
 * mailto:) are covered by manual smoke via `examples/34-desktop-tools.ts`.
 */
import { describe, test } from 'node:test'
import { strict as assert } from 'node:assert'

import {
  buildDesktopServer,
  captureScreenTool,
  composeEmailTool,
  currentPlatform,
  findFilesTool,
  launchAppTool,
  notifyTool,
  openInBrowserTool,
  openPathTool,
  readClipboardTool,
  revealInFinderTool,
  runAppleScriptTool,
  runPowerShellTool,
  writeClipboardTool,
} from '../src/desktop/index.js'

describe('desktop/index — buildDesktopServer', () => {
  test('default tier is "safe" and exposes 6 tools', () => {
    const server = buildDesktopServer()
    assert.equal(server.type, 'sdk')
    assert.equal(server.name, 'desktop')
    assert.equal(server.tools.length, 6)
    const names = server.tools.map((t) => t.name).sort()
    assert.deepEqual(names, [
      'mcp__desktop__capture_screen',
      'mcp__desktop__find_files',
      'mcp__desktop__open_path',
      'mcp__desktop__read_clipboard',
      'mcp__desktop__reveal_in_finder',
      'mcp__desktop__write_clipboard',
    ])
  })

  test('tier "automation" exposes only automation tools', () => {
    const server = buildDesktopServer({ tier: 'automation' })
    const base = server.tools.map((t) => t.name.replace('mcp__desktop__', '')).sort()
    assert.deepEqual(base, [
      'compose_email',
      'launch_app',
      'notify',
      'open_in_browser',
      'run_applescript',
      'run_powershell',
    ])
  })

  test('tier "all" merges both tiers and respects exclude', () => {
    const server = buildDesktopServer({ tier: 'all', exclude: ['run_powershell', 'run_applescript'] })
    assert.equal(server.tools.length, 10)
    assert.ok(!server.tools.some((t) => t.name.endsWith('run_powershell')))
    assert.ok(!server.tools.some((t) => t.name.endsWith('run_applescript')))
  })

  test('serverName + version overrides reflect in the MCP namespace', () => {
    const server = buildDesktopServer({ serverName: 'my_desktop', version: '9.9.9' })
    assert.equal(server.name, 'my_desktop')
    assert.equal(server.version, '9.9.9')
    assert.ok(server.tools.every((t) => t.name.startsWith('mcp__my_desktop__')))
  })

  test('every tool has a description and zod input schema', () => {
    const tools = [
      readClipboardTool, writeClipboardTool, captureScreenTool, findFilesTool,
      openPathTool, revealInFinderTool, launchAppTool, composeEmailTool,
      openInBrowserTool, notifyTool, runAppleScriptTool, runPowerShellTool,
    ]
    for (const t of tools) {
      assert.ok(t.name && t.name.length > 0, `tool missing name: ${JSON.stringify(t)}`)
      assert.ok(t.description && t.description.length >= 20, `tool ${t.name} has thin description`)
      assert.ok(t.inputSchema, `tool ${t.name} missing inputSchema`)
    }
  })
})

describe('desktop — platform-guarded tools degrade safely on the wrong OS', () => {
  test('run_applescript reports macOS-only on non-darwin', async () => {
    if (currentPlatform() === 'darwin') return
    const r = await runAppleScriptTool.handler({ script: 'tell app "Finder" to activate' } as any, undefined)
    assert.equal(r.isError, true)
    const text = (r.content[0] as any).text as string
    assert.match(text, /macOS only/i)
  })

  test('run_powershell reports Windows-only on non-win32', async () => {
    if (currentPlatform() === 'win32') return
    const r = await runPowerShellTool.handler({ script: 'Get-Date' } as any, undefined)
    assert.equal(r.isError, true)
    const text = (r.content[0] as any).text as string
    assert.match(text, /Windows only/i)
  })
})

describe('desktop — compose_email never sends, just opens a mailto draft', () => {
  test('compose_email accepts to/cc/bcc/subject/body and returns ok or surfaces a safe error', async () => {
    // We do not assert success here — CI runners often lack a default mail
    // handler. We assert that calling the tool with valid input does NOT
    // throw across the boundary.
    const r = await composeEmailTool.handler(
      { to: ['nobody@example.com'], cc: [], bcc: [], subject: 't', body: 'b' } as any,
      undefined,
    )
    assert.ok(Array.isArray(r.content) && r.content.length > 0)
  })
})
