/**
 * Docs contract — USAGE.md §20.1 covers the two optional trace fields
 * shipped in 1.0.3 (Tier A #1 + #2). Locks the docs so a future field
 * rename in `src/types/trace.ts` immediately surfaces here.
 *
 * Pure file-read test, no runtime spawn.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

const USAGE_PATH = join(process.cwd(), 'docs', 'USAGE.md')

async function readUsage(): Promise<string> {
  return readFile(USAGE_PATH, 'utf-8')
}

test('USAGE.md has a §20.1 section covering optional trace perf fields', async () => {
  const text = await readUsage()
  assert.match(text, /## 20\.1 Trace 上的可选 perf 字段/, '§20.1 heading missing')
  // Both fields must be named verbatim — they are the public surface.
  assert.match(text, /`tool_cache`/, 'tool_cache field not documented')
  assert.match(text, /`tool_concurrency_adaptive`/, 'tool_concurrency_adaptive field not documented')
})

test('USAGE.md §20.1 documents tool_cache contract semantics', async () => {
  const text = await readUsage()
  // The four invariants the engine-tool-cache tests pin must be reflected.
  assert.match(text, /isReadOnly\(\)/, 'eligibility predicate not mentioned')
  assert.match(text, /isConcurrencySafe\(\)/, 'eligibility predicate not mentioned')
  assert.match(text, /bypass/i, 'bypass-not-counted invariant missing')
  assert.match(text, /PostToolUse/, 'hook fire semantics missing')
  assert.match(text, /turn/i, 'turn scope missing')
})

test('USAGE.md §20.1 documents adaptive concurrency contract semantics', async () => {
  const text = await readUsage()
  assert.match(text, /AIMD/, 'AIMD name missing')
  assert.match(text, /halve|\/ 2|halved/i, 'error -> halve rule missing')
  assert.match(text, /\+1|add 1/i, 'success -> +1 rule missing')
  assert.match(text, /adjustments\[\]/, 'adjustments array shape missing')
  assert.match(text, /enabled: true/, 'enabled discriminator missing')
  assert.match(text, /byte-identical|字节级保持原样/, 'fallback byte-identical guarantee missing')
})

test('USAGE.md ToC entry links to §20.1 anchor', async () => {
  const text = await readUsage()
  assert.match(
    text,
    /\[20\.1 Trace 上的可选 perf 字段\]\(#201-trace-上的可选-perf-字段\)/,
    'ToC anchor entry missing or mis-keyed',
  )
})

test('USAGE.md §20.1 references the two canonical test files', async () => {
  const text = await readUsage()
  // These two paths anchor the contract — a rename would invalidate them.
  assert.match(text, /tests\/engine-tool-cache\.test\.ts/, 'tool-cache contract test ref missing')
  assert.match(text, /tests\/dispatch-executor\.test\.ts/, 'adaptive concurrency contract test ref missing')
})

test('USAGE.md §20.1 documents the per-call tool_cache TraceEvent + OTel mapping', async () => {
  const text = await readUsage()
  assert.match(text, /kind: 'tool_cache'/, 'TraceEvent discriminator missing')
  assert.match(text, /tool\.cache\.hit/, 'OTel hit span name missing')
  assert.match(text, /tool\.cache\.miss/, 'OTel miss span name missing')
  assert.match(text, /tool\.cache\.outcome/, 'OTel attribute missing')
  assert.match(text, /tests\/tracing-tool-cache-event\.test\.ts/, 'event contract test ref missing')
})

test('USAGE.md §11 lists tool_cache among the built-in TraceEvent kinds', async () => {
  const text = await readUsage()
  // Section 11 (Live Tracing + OTel) must mention the new built-in kind so
  // OTel consumers discover it without spelunking into §20.1.
  const sec11 = text.split('## 11.')[1]?.split('## 12.')[0] ?? ''
  assert.match(sec11, /tool_cache/, '§11 should list tool_cache as a built-in kind')
  assert.match(sec11, /tool_concurrency_adjust/, '§11 should list tool_concurrency_adjust as a built-in kind')
})

test('USAGE.md §20.1 documents the per-call tool_concurrency_adjust TraceEvent + OTel mapping', async () => {
  const text = await readUsage()
  assert.match(text, /kind: 'tool_concurrency_adjust'/, 'TraceEvent discriminator missing')
  assert.match(text, /tool\.concurrency\.adjust\.error/, 'OTel error span name missing')
  assert.match(text, /tool\.concurrency\.adjust\.success/, 'OTel success span name missing')
  assert.match(text, /tool\.concurrency\.reason/, 'OTel reason attribute missing')
  assert.match(text, /tool\.concurrency\.previous/, 'OTel previous attribute missing')
  assert.match(text, /tool\.concurrency\.current/, 'OTel current attribute missing')
  assert.match(text, /tool:concurrency/, 'spanId convention missing')
  assert.match(text, /tests\/tracing-tool-concurrency-event\.test\.ts/, 'event contract test ref missing')
})
