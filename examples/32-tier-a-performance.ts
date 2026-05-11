/**
 * Example 32: Tier A Performance Features (offline)
 *
 * Demonstrates the four offline-testable Tier A performance features
 * landed during the 1.0.x cycle. None of these examples need an LLM
 * provider — they exercise the SDK's local primitives directly so you
 * can run them without an API key.
 *
 *   1. Tool result cache       (turn-scoped memoization)
 *   2. Adaptive concurrency    (AIMD controller for parallel tool fanout)
 *   3. Multi-provider fallback (ordered chain of fallback models)
 *   4. Memory consolidation    (merge near-duplicate memories)
 *
 * Run: npx tsx examples/32-tier-a-performance.ts
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  consolidateMemories,
  findDuplicateMemories,
  saveMemory,
} from '../src/index.js'
import { ToolResultCache } from '../src/engine/tool-result-cache.js'
import { runResilientCall } from '../src/engine/resilient-call.js'
import {
  buildConcurrencyController,
  createAdaptiveConcurrencyController,
} from '../src/engine/concurrency-controller.js'
import type { CreateMessageResponse, ProviderError } from '../src/providers/types.js'

// ---------------------------------------------------------------------------
// 1. Tool result cache — duplicate read-only tool calls share one execution
// ---------------------------------------------------------------------------
async function demoToolCache() {
  console.log('--- 1. Tool result cache ---')
  const cache = new ToolResultCache()
  let invocations = 0

  const callRead = async (path: string) => {
    const outcome = await cache.getOrCompute(
      'Read',
      { path },
      async () => {
        invocations++
        await new Promise((r) => setTimeout(r, 5))
        return {
          type: 'tool_result' as const,
          tool_use_id: `read-${path}-${invocations}`,
          content: `<contents of ${path}>`,
          is_error: false,
        }
      },
    )
    return outcome.result
  }

  const results = await Promise.all([
    callRead('package.json'),
    callRead('package.json'),
    callRead('README.md'),
    callRead('package.json'),
  ])

  const stats = cache.stats()
  console.log(`  results=${results.length} invocations=${invocations} hits=${stats.hits} misses=${stats.misses}\n`)
}

// ---------------------------------------------------------------------------
// 2. Adaptive concurrency — limit halves on errors, +1 on clean batches
// ---------------------------------------------------------------------------
async function demoAdaptiveConcurrency() {
  console.log('--- 2. Adaptive concurrency (AIMD) ---')

  const controller = createAdaptiveConcurrencyController({ initial: 4, min: 1, max: 8 })

  // Simulate three concurrent batches: clean → error → clean.
  for (const phase of [
    { errors: 0, label: 'clean batch' },
    { errors: 1, label: 'errored batch' },
    { errors: 0, label: 'clean batch' },
  ]) {
    const before = controller.current()
    controller.onBatchComplete({ size: before, errors: phase.errors })
    console.log(`  ${phase.label.padEnd(15)} → limit ${before} → ${controller.current()}`)
  }

  const snap = controller.snapshot()!
  console.log(`  final=${snap.final} adjustments=${snap.adjustments.length}`)

  // Static fallback: omitting adaptiveToolConcurrency is the legacy path.
  const staticController = buildConcurrencyController(undefined, 10)
  console.log(`  static controller snapshot=${staticController.snapshot()} (undefined = no trace)\n`)
}

// ---------------------------------------------------------------------------
// 3. Multi-provider fallback chain — try primary → fb1 → fb2 in order
// ---------------------------------------------------------------------------
async function demoFallbackChain() {
  console.log('--- 3. Multi-provider fallback chain ---')

  function fakeResponse(text: string): CreateMessageResponse {
    return {
      content: [{ type: 'text', text }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
  function transientError(): ProviderError {
    const err = new Error('upstream 503') as ProviderError
    err.provider = 'openai'
    err.category = 'provider_error'
    err.status = 503
    return err
  }

  const attempts: string[] = []
  const result = await runResilientCall({
    primaryModel: 'gpt-primary',
    fallbackModel: ['claude-fallback-1', 'glm-fallback-2'],
    retryConfig: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, retryableStatusCodes: [] },
    call: async (model) => {
      attempts.push(model)
      if (model === 'gpt-primary') throw transientError()
      if (model === 'claude-fallback-1') throw transientError()
      return fakeResponse('finally answered by glm')
    },
  })

  console.log(`  attempted: ${attempts.join(' → ')}`)
  console.log(`  winning model: ${result.model}\n`)
}

// ---------------------------------------------------------------------------
// 4. Memory consolidation — merge near-duplicate entries
// ---------------------------------------------------------------------------
async function demoMemoryConsolidation() {
  console.log('--- 4. Memory consolidation ---')
  const dir = await mkdtemp(join(tmpdir(), 'tier-a-demo-'))
  try {
    await saveMemory({
      id: 'fb-1',
      type: 'feedback',
      scope: 'repo',
      title: 'Minimize confirmation prompts',
      content: 'Run continuously; pause only for destructive actions.',
      tags: ['autonomy'],
      confidence: 'medium',
      repoPath: '/tmp/demo',
    }, { dir })
    await new Promise((r) => setTimeout(r, 5))
    await saveMemory({
      id: 'fb-2',
      type: 'feedback',
      scope: 'repo',
      title: 'minimize confirmation prompts ',
      content: 'Newer phrasing.\nWhy: came up after running multiple sessions.',
      tags: ['workflow', 'autonomy'],
      confidence: 'high',
      repoPath: '/tmp/demo',
      lastValidatedAt: '2026-05-01',
    }, { dir })

    const preview = await findDuplicateMemories({ dir })
    console.log(`  preview: ${preview.duplicate_groups} group(s), ${preview.removed} would-be-removed (dry_run=${preview.dry_run})`)

    const applied = await consolidateMemories({ dir })
    console.log(`  applied: kept ${applied.groups[0]!.kept_id}, removed [${applied.groups[0]!.removed_ids.join(', ')}]`)
    console.log(`  scanned=${applied.scanned} groups=${applied.duplicate_groups} removed=${applied.removed}\n`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Example 32: Tier A Performance Features ===\n')
  await demoToolCache()
  await demoAdaptiveConcurrency()
  await demoFallbackChain()
  await demoMemoryConsolidation()
  console.log('Done. None of these required an API key.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
