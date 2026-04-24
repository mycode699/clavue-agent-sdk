import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runRetroEvaluation, type AgentRunResult, type RetroEvaluator } from '../src/index.ts'

async function createLedgerDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'clavue-agent-sdk-retro-'))
}

async function createRetroFixture(files: Record<string, string>): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'clavue-agent-sdk-retro-fixture-'))

  await Promise.all(
    Object.entries(files).map(async ([relativePath, content]) => {
      const fullPath = join(cwd, relativePath)
      await mkdir(join(fullPath, '..'), { recursive: true })
      await writeFile(fullPath, content)
    }),
  )

  return cwd
}

test('runRetroEvaluation returns structured findings scores and workstreams', async () => {
  const evaluators: RetroEvaluator[] = [
    async () => ({
      findings: [
        {
          dimension: 'reliability',
          title: 'Missing retry guard',
          rationale: 'Transient provider failures are not isolated well enough.',
          severity: 'high',
          confidence: 'high',
          evidence: [
            {
              kind: 'file',
              location: 'src/providers/openai.ts:1',
              detail: 'Retry behavior is inconsistent.',
            },
          ],
        },
        {
          dimension: 'interaction_logic',
          title: 'Strong command UX',
          rationale: 'The command surface is coherent and already product-shaped.',
          severity: 'low',
          confidence: 'medium',
          disposition: 'preserve',
          evidence: [
            {
              kind: 'doc',
              location: 'README.md:91',
              detail: 'Command set is documented and discoverable.',
            },
          ],
        },
      ],
    }),
  ]

  const result = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators,
    runAt: '2026-04-14T00:00:00.000Z',
  })

  assert.equal(typeof result.summary, 'string')
  assert.ok(result.summary.length > 0)
  assert.equal(result.findings.length, 2)
  assert.equal(result.scores.byDimension.compatibility.dimension, 'compatibility')
  assert.equal(result.scores.byDimension.stability.dimension, 'stability')
  assert.equal(result.scores.byDimension.interaction_logic.dimension, 'interaction_logic')
  assert.equal(result.scores.byDimension.reliability.dimension, 'reliability')
  assert.ok(result.scores.overall.score >= 0)
  assert.ok(result.proposed_workstreams.length > 0)
  assert.equal(result.proposed_workstreams[0]?.bucket, 'fix_now')
  assert.ok(result.recommendations.some((item) => item.dimension === 'reliability'))
  assert.equal(result.run_metadata.runAt, '2026-04-14T00:00:00.000Z')
})

test('runRetroEvaluation orders severe work ahead of preserve items', async () => {
  const evaluators: RetroEvaluator[] = [
    async () => ({
      findings: [
        {
          dimension: 'compatibility',
          title: 'Gateway dialect mismatch',
          rationale: 'Some gateways reject the current request shape.',
          severity: 'critical',
          confidence: 'high',
        },
        {
          dimension: 'stability',
          title: 'Flaky boot path',
          rationale: 'Cold-start behavior is inconsistent.',
          severity: 'medium',
          confidence: 'high',
        },
        {
          dimension: 'interaction_logic',
          title: 'Great onboarding copy',
          rationale: 'The onboarding flow is already clear.',
          severity: 'low',
          confidence: 'medium',
          disposition: 'preserve',
        },
      ],
    }),
  ]

  const result = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators,
    runAt: '2026-04-14T00:00:00.000Z',
  })

  assert.equal(result.proposed_workstreams[0]?.title, 'Gateway dialect mismatch')
  assert.equal(result.proposed_workstreams[0]?.bucket, 'fix_now')
  assert.equal(result.proposed_workstreams.at(-1)?.bucket, 'preserve_strengths')
  assert.ok(
    result.scores.byDimension.compatibility.score < result.scores.byDimension.interaction_logic.score,
  )
})

test('createDefaultRetroEvaluators returns one evaluator per core dimension', async () => {
  const { createDefaultRetroEvaluators } = await import('../src/index.ts')

  const cwd = await createRetroFixture({
    'package.json': JSON.stringify(
      {
        name: 'clavue-agent-sdk',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
        files: ['dist'],
        scripts: {
          build: 'tsc',
          test: 'npx tsx --test tests/*.test.ts',
          prepack: 'npm run build',
        },
      },
      null,
      2,
    ),
    'README.md': '# Clavue Agent SDK\n\n```ts\nimport { query } from "clavue-agent-sdk"\n```\n\nnpm install clavue-agent-sdk\n',
    'dist/index.js': 'export const ok = true\n',
    'dist/index.d.ts': 'export declare const ok: boolean\n',
    'tests/smoke.test.ts': 'export {}\n',
  })

  try {
    const evaluators = createDefaultRetroEvaluators()
    const result = await runRetroEvaluation({
      target: {
        name: 'clavue-agent-sdk',
        cwd,
      },
      evaluators,
      runAt: '2026-04-14T00:00:00.000Z',
    })

    assert.equal(evaluators.length, 4)
    assert.equal(result.findings.length, 0)
    assert.equal(result.scores.overall.score, 100)
    assert.equal(result.proposed_workstreams.length, 0)
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('createDefaultRetroEvaluators surfaces package, onboarding, and release gaps', async () => {
  const { createDefaultRetroEvaluators } = await import('../src/index.ts')

  const cwd = await createRetroFixture({
    'package.json': JSON.stringify(
      {
        name: 'broken-sdk',
        main: './dist/index.js',
        scripts: {
          build: 'tsc',
        },
      },
      null,
      2,
    ),
    'README.md': '# Broken SDK\n',
  })

  try {
    const result = await runRetroEvaluation({
      target: {
        name: 'broken-sdk',
        cwd,
      },
      evaluators: createDefaultRetroEvaluators(),
      runAt: '2026-04-14T00:00:00.000Z',
    })

    assert.equal(result.findings.length, 4)
    assert.ok(result.findings.some((finding) => finding.dimension === 'compatibility'))
    assert.ok(result.findings.some((finding) => finding.dimension === 'stability'))
    assert.ok(result.findings.some((finding) => finding.dimension === 'interaction_logic'))
    assert.ok(result.findings.some((finding) => finding.dimension === 'reliability'))
    assert.ok(result.findings.some((finding) => finding.title === 'Declared entrypoints are missing on disk'))
    assert.ok(result.findings.some((finding) => finding.title === 'Core verification scripts are incomplete'))
    assert.ok(result.findings.some((finding) => finding.title === 'README onboarding is incomplete'))
    assert.ok(result.findings.some((finding) => finding.title === 'Release safeguards are incomplete'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runRetroEvaluation isolates evaluator failures and records metadata', async () => {
  const result = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'compatibility',
            title: 'Provider contract drift',
            rationale: 'Provider output no longer matches the SDK event contract.',
            severity: 'high',
            confidence: 'high',
          },
        ],
      }),
      async () => {
        throw new Error('fixture evaluator failed')
      },
    ],
    runAt: '2026-04-14T00:00:00.000Z',
  })

  assert.equal(result.run_metadata.evaluatorCount, 2)
  assert.equal(result.run_metadata.evaluatorSuccessCount, 1)
  assert.equal(result.run_metadata.evaluatorFailureCount, 1)
  assert.equal(result.run_metadata.evaluators?.[0]?.status, 'fulfilled')
  assert.equal(result.run_metadata.evaluators?.[0]?.findingCount, 1)
  assert.equal(result.run_metadata.evaluators?.[1]?.status, 'rejected')
  assert.equal(result.run_metadata.evaluators?.[1]?.error, 'fixture evaluator failed')
  assert.ok(typeof result.run_metadata.durationMs === 'number')
  assert.ok(result.findings.some((finding) => finding.title === 'Provider contract drift'))
  assert.ok(result.findings.some((finding) => finding.title === 'Evaluator 2 failed'))
  assert.ok(result.evidence.some((item) => item.location === 'retro:evaluator:2'))
  assert.ok(result.scores.byDimension.reliability.score < 100)
})

test('runRetroCycle uses default evaluators and default verification gates', async () => {
  const { runRetroCycle } = await import('../src/index.ts')

  const cwd = await createRetroFixture({
    'package.json': JSON.stringify(
      {
        name: 'clavue-agent-sdk',
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: {
          '.': {
            import: './dist/index.js',
            types: './dist/index.d.ts',
          },
        },
        files: ['dist'],
        scripts: {
          build: 'node -e "process.stdout.write(\'build-ok\')"',
          test: 'node -e "process.stdout.write(\'test-ok\')"',
          prepack: 'npm run build',
        },
      },
      null,
      2,
    ),
    'README.md': '# Clavue Agent SDK\n\n```ts\nimport { query } from "clavue-agent-sdk"\n```\n\nnpm install clavue-agent-sdk\n',
    'dist/index.js': 'export const ok = true\n',
    'dist/index.d.ts': 'export declare const ok: boolean\n',
    'tests/smoke.test.ts': 'export {}\n',
  })

  try {
    const result = await runRetroCycle({
      target: { name: 'clavue-agent-sdk', cwd },
    })

    assert.equal(result.run.findings.length, 0)
    assert.equal(result.verification?.passed, true)
    assert.equal(result.verification?.gates.length, 2)
    assert.equal(result.verification?.gates[0]?.name, 'build')
    assert.equal(result.action.kind, 'stop')
    assert.equal(result.decision.disposition, 'accepted')
    assert.equal(result.decision.accepted, true)
    assert.equal(result.decision.shouldRetry, false)
    assert.equal(result.summary.disposition, 'accepted')
    assert.equal(result.summary.verificationPassed, true)
    assert.equal(result.summary.actionKind, 'stop')
    assert.equal(result.trace.attemptCount, 0)
    assert.equal(result.trace.attemptNumber, 1)
    assert.equal(result.trace.maxAttempts, 3)
    assert.ok(result.trace.startedAt)
    assert.ok(result.trace.completedAt)
    assert.ok(result.trace.durationMs >= 0)
    assert.ok(result.summary.statusLine.includes('ACCEPTED'))
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})

test('runRetroCycle composes evaluation verification action and persistence', async () => {
  const { loadRetroCycle, loadRetroRun, runRetroCycle } = await import('../src/index.ts')

  const ledgerDir = await createLedgerDir()

  try {
    const result = await runRetroCycle({
      target: { name: 'clavue-agent-sdk', cwd: ledgerDir },
      evaluators: [
        async () => ({
          findings: [
            {
              dimension: 'reliability',
              title: 'Retry gap',
              rationale: 'Transient failures need stronger recovery.',
              severity: 'high',
              confidence: 'high',
              disposition: 'fix',
            },
          ],
        }),
      ],
      gates: [
        {
          name: 'verify-ok',
          command: 'node',
          args: ['-e', 'process.stdout.write("ok")'],
        },
      ],
      runId: 'cycle-run-1',
      cycleId: 'cycle-record-1',
      ledger: { dir: ledgerDir },
      policy: { maxAttempts: 2 },
    })

    const persisted = await loadRetroRun('cycle-run-1', { dir: ledgerDir })
    const persistedCycle = await loadRetroCycle('cycle-record-1', { dir: ledgerDir })

    assert.equal(result.verification?.passed, true)
    assert.equal(result.run.verification?.passed, true)
    assert.equal(result.action.kind, 'attempt_fix')
    assert.equal(result.decision.disposition, 'retry')
    assert.equal(result.decision.shouldRetry, true)
    assert.equal(result.summary.disposition, 'retry')
    assert.equal(result.summary.actionKind, 'attempt_fix')
    assert.equal(result.summary.verificationPassed, true)
    assert.ok(result.summary.text.includes('Verification: passed'))
    assert.equal(result.trace.runId, 'cycle-run-1')
    assert.equal(result.trace.cycleId, 'cycle-record-1')
    assert.equal(result.trace.attemptCount, 0)
    assert.equal(result.trace.attemptNumber, 1)
    assert.equal(result.trace.maxAttempts, 2)
    assert.equal(result.savedRunId, 'cycle-run-1')
    assert.equal(result.savedCycleId, 'cycle-record-1')
    assert.equal(persisted?.verification?.gates[0]?.name, 'verify-ok')
    assert.equal(persistedCycle?.decision.disposition, 'retry')
    assert.equal(persistedCycle?.summary.actionKind, 'attempt_fix')
    assert.equal(persistedCycle?.trace.runId, 'cycle-run-1')
    assert.equal(persistedCycle?.trace.cycleId, 'cycle-record-1')
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('runRetroCycle loads previous runs and retests on failed verification', async () => {
  const { runRetroCycle, saveRetroRun } = await import('../src/index.ts')

  const ledgerDir = await createLedgerDir()

  try {
    const previous = await runRetroEvaluation({
      target: { name: 'clavue-agent-sdk', cwd: ledgerDir },
      evaluators: [async () => ({ findings: [] })],
      runAt: '2026-04-13T00:00:00.000Z',
    })

    await saveRetroRun('previous-run', previous, { dir: ledgerDir })

    const result = await runRetroCycle({
      target: { name: 'clavue-agent-sdk', cwd: ledgerDir },
      evaluators: [
        async () => ({
          findings: [
            {
              dimension: 'stability',
              title: 'Boot race',
              rationale: 'Startup ordering is unstable.',
              severity: 'medium',
              confidence: 'high',
              disposition: 'investigate',
            },
          ],
        }),
      ],
      gates: [
        {
          name: 'verify-fail',
          command: 'node',
          args: ['-e', 'process.stderr.write("boom"); process.exit(1)'],
        },
      ],
      previousRunId: 'previous-run',
      ledger: { dir: ledgerDir },
      attemptCount: 2,
      policy: { maxAttempts: 4 },
    })

    assert.equal(result.previousRun?.run_metadata.runAt, '2026-04-13T00:00:00.000Z')
    assert.equal(result.trace.previousRunId, 'previous-run')
    assert.equal(result.trace.attemptCount, 2)
    assert.equal(result.trace.attemptNumber, 3)
    assert.equal(result.trace.maxAttempts, 4)
    assert.equal(result.comparison?.newFindings[0]?.title, 'Boot race')
    assert.equal(result.verification?.passed, false)
    assert.equal(result.action.kind, 'retest')
    assert.equal(result.decision.disposition, 'retry')
    assert.equal(result.decision.shouldRetry, true)
    assert.equal(result.summary.disposition, 'retry')
    assert.equal(result.summary.actionKind, 'retest')
    assert.equal(result.summary.verificationPassed, false)
    assert.ok(result.summary.text.includes('Verification: failed'))
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('runRetroCycle records source run lineage from a live agent run artifact', async () => {
  const { loadRetroCycle, runRetroCycle } = await import('../src/index.ts')

  const ledgerDir = await createLedgerDir()

  try {
    const result = await runRetroCycle({
      target: { name: 'clavue-agent-sdk', cwd: ledgerDir },
      evaluators: [async () => ({ findings: [] })],
      gates: [
        {
          name: 'verify-ok',
          command: 'node',
          args: ['-e', 'process.stdout.write("ok")'],
        },
      ],
      cycleId: 'cycle-with-source-run',
      ledger: { dir: ledgerDir },
      sourceRun: {
        id: 'agent-run-1',
        session_id: 'session-123',
        status: 'completed',
        subtype: 'success',
        started_at: '2026-04-22T00:00:00.000Z',
        completed_at: '2026-04-22T00:00:02.000Z',
        duration_ms: 2000,
        duration_api_ms: 1500,
        total_cost_usd: 0.0123,
        num_turns: 3,
        stop_reason: 'end_turn',
        usage: { input_tokens: 120, output_tokens: 80 },
      },
    })

    const persistedCycle = await loadRetroCycle('cycle-with-source-run', { dir: ledgerDir })

    assert.equal(result.run.run_metadata.sourceRun?.id, 'agent-run-1')
    assert.equal(result.run.run_metadata.sourceRun?.session_id, 'session-123')
    assert.equal(result.trace.sourceRunId, 'agent-run-1')
    assert.equal(result.trace.sourceSessionId, 'session-123')
    assert.equal(persistedCycle?.run.run_metadata.sourceRun?.id, 'agent-run-1')
    assert.equal(persistedCycle?.trace.sourceRunId, 'agent-run-1')
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('runRetroLoop stops after the first accepted cycle', async () => {
  const { loadRetroCycle, loadRetroRun, runRetroLoop } = await import('../src/index.ts')

  const ledgerDir = await createLedgerDir()

  try {
    const result = await runRetroLoop({
      target: { name: 'clavue-agent-sdk', cwd: ledgerDir },
      evaluators: [async () => ({ findings: [] })],
      gates: [
        {
          name: 'verify-ok',
          command: 'node',
          args: ['-e', 'process.stdout.write("ok")'],
        },
      ],
      ledger: { dir: ledgerDir },
      idPrefix: 'retro-loop-ok',
      maxAttempts: 3,
    })

    const persistedRun = await loadRetroRun('retro-loop-ok-run-1', { dir: ledgerDir })
    const persistedCycle = await loadRetroCycle('retro-loop-ok-attempt-1', { dir: ledgerDir })

    assert.equal(result.cycles.length, 1)
    assert.equal(result.finalCycle.action.kind, 'stop')
    assert.equal(result.summary.accepted, true)
    assert.equal(result.summary.completedAttempts, 1)
    assert.equal(result.summary.attemptCount, 1)
    assert.equal(persistedRun?.verification?.passed, true)
    assert.equal(persistedCycle?.decision.disposition, 'accepted')
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('runRetroLoop chains retries with durable lineage until the limit', async () => {
  const { loadRetroCycle, loadRetroRun, runRetroLoop } = await import('../src/index.ts')

  const ledgerDir = await createLedgerDir()
  const hookCalls: Array<{
    attemptCount: number
    nextAttemptCount: number
    previousRunId: string
    cycleId?: string
    sourceRunId?: string
  }> = []

  try {
    const result = await runRetroLoop({
      target: { name: 'clavue-agent-sdk', cwd: ledgerDir },
      evaluators: [
        async () => ({
          findings: [
            {
              dimension: 'reliability',
              title: 'Retry gap',
              rationale: 'Transient failures need stronger recovery.',
              severity: 'high',
              confidence: 'high',
              disposition: 'fix',
            },
          ],
        }),
      ],
      gates: [
        {
          name: 'verify-ok',
          command: 'node',
          args: ['-e', 'process.stdout.write("ok")'],
        },
      ],
      ledger: { dir: ledgerDir },
      idPrefix: 'retro-loop-retry',
      maxAttempts: 2,
      onAttemptRetry: (context) => {
        hookCalls.push({
          attemptCount: context.attemptCount,
          nextAttemptCount: context.nextAttemptCount,
          previousRunId: context.previousRunId,
          cycleId: context.previousCycle.trace.cycleId,
          sourceRunId: context.sourceRun?.id,
        })
        return {
          summary: 'Applied a focused retry step.',
          changed: true,
          sourceRun: {
            id: 'agent-run-retry-1',
            session_id: 'session-retry-1',
            status: 'completed',
            subtype: 'success',
            started_at: '2026-04-22T00:00:00.000Z',
            completed_at: '2026-04-22T00:00:02.000Z',
            duration_ms: 2000,
            duration_api_ms: 1500,
            total_cost_usd: 0.01,
            num_turns: 2,
            stop_reason: 'end_turn',
            usage: { input_tokens: 100, output_tokens: 50 },
          },
          metadata: {
            strategy: 'focused-retry',
          },
        }
      },
    })

    const persistedRun1 = await loadRetroRun('retro-loop-retry-run-1', { dir: ledgerDir })
    const persistedRun2 = await loadRetroRun('retro-loop-retry-run-2', { dir: ledgerDir })
    const persistedCycle1 = await loadRetroCycle('retro-loop-retry-attempt-1', { dir: ledgerDir })
    const persistedCycle2 = await loadRetroCycle('retro-loop-retry-attempt-2', { dir: ledgerDir })

    assert.equal(result.cycles.length, 2)
    assert.equal(hookCalls.length, 1)
    assert.deepEqual(hookCalls[0], {
      attemptCount: 0,
      nextAttemptCount: 1,
      previousRunId: 'retro-loop-retry-run-1',
      cycleId: 'retro-loop-retry-attempt-1',
      sourceRunId: undefined,
    })
    assert.equal(result.cycles[0]?.retryStep?.summary, 'Applied a focused retry step.')
    assert.equal(result.cycles[0]?.retryStep?.changed, true)
    assert.equal(result.cycles[0]?.retryStep?.metadata?.strategy, 'focused-retry')
    assert.equal(result.finalCycle.trace.attemptNumber, 2)
    assert.equal(result.finalCycle.trace.previousRunId, 'retro-loop-retry-run-1')
    assert.equal(result.finalCycle.trace.sourceRunId, 'agent-run-retry-1')
    assert.equal(result.finalCycle.trace.sourceSessionId, 'session-retry-1')
    assert.equal(result.finalCycle.action.kind, 'escalate')
    assert.equal(result.summary.accepted, false)
    assert.equal(result.summary.completedAttempts, 2)
    assert.equal(result.summary.attemptCount, 2)
    assert.equal(persistedRun1?.verification?.passed, true)
    assert.equal(persistedRun2?.verification?.passed, true)
    assert.equal(persistedCycle1?.trace.runId, 'retro-loop-retry-run-1')
    assert.equal(persistedCycle1?.retryStep?.sourceRun?.id, 'agent-run-retry-1')
    assert.equal(persistedCycle2?.trace.previousRunId, 'retro-loop-retry-run-1')
    assert.equal(persistedCycle2?.trace.sourceRunId, 'agent-run-retry-1')
    assert.equal(persistedCycle2?.decision.disposition, 'rejected')
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('runRetroLoop normalizes raw AgentRunResult retry artifacts into durable lineage', async () => {
  const { loadRetroCycle, runRetroLoop } = await import('../src/index.ts')

  const ledgerDir = await createLedgerDir()
  const hookCalls: Array<{
    attemptCount: number
    nextAttemptCount: number
    previousRunId: string
    cycleId?: string
    sourceRunId?: string
  }> = []
  const retryArtifact: AgentRunResult = {
    id: 'agent-run-artifact-1',
    session_id: 'session-artifact-1',
    status: 'completed',
    subtype: 'success',
    text: 'Patched retry handling and reran checks.',
    messages: [],
    events: [],
    usage: { input_tokens: 120, output_tokens: 64 },
    num_turns: 2,
    duration_ms: 2100,
    duration_api_ms: 1600,
    total_cost_usd: 0.02,
    stop_reason: 'end_turn',
    started_at: '2026-04-22T00:00:00.000Z',
    completed_at: '2026-04-22T00:00:02.100Z',
  }

  try {
    const result = await runRetroLoop({
      target: { name: 'clavue-agent-sdk', cwd: ledgerDir },
      evaluators: [
        async ({ trace }) => ({
          findings:
            trace.attemptNumber === 1
              ? [
                  {
                    dimension: 'reliability',
                    title: 'Retry gap',
                    rationale: 'Transient failures need stronger recovery.',
                    severity: 'high',
                    confidence: 'high',
                    disposition: 'fix',
                  },
                ]
              : [
                  {
                    dimension: 'reliability',
                    title: 'Retry gap remains bounded',
                    rationale: 'The issue improved but still needs follow-up.',
                    severity: 'medium',
                    confidence: 'high',
                    disposition: 'fix',
                  },
                ],
        }),
      ],
      gates: [
        {
          name: 'verify-ok',
          command: 'node',
          args: ['-e', 'process.stdout.write("ok")'],
        },
      ],
      ledger: { dir: ledgerDir },
      idPrefix: 'retro-loop-raw-artifact',
      maxAttempts: 2,
      onAttemptRetry: (context) => {
        hookCalls.push({
          attemptCount: context.attemptCount,
          nextAttemptCount: context.nextAttemptCount,
          previousRunId: context.previousRunId,
          cycleId: context.previousCycle.trace.cycleId,
          sourceRunId: context.sourceRun?.id,
        })
        return retryArtifact
      },
    })

    const persistedCycle1 = await loadRetroCycle('retro-loop-raw-artifact-attempt-1', { dir: ledgerDir })
    const persistedCycle2 = await loadRetroCycle('retro-loop-raw-artifact-attempt-2', { dir: ledgerDir })

    assert.equal(result.cycles.length, 2)
    assert.equal(hookCalls.length, 1)
    assert.deepEqual(hookCalls[0], {
      attemptCount: 0,
      nextAttemptCount: 1,
      previousRunId: 'retro-loop-raw-artifact-run-1',
      cycleId: 'retro-loop-raw-artifact-attempt-1',
      sourceRunId: undefined,
    })
    assert.equal(result.cycles[0]?.retryStep?.summary, 'Captured retry agent run artifact.')
    assert.equal(result.cycles[0]?.retryStep?.sourceRun?.id, retryArtifact.id)
    assert.equal(result.cycles[0]?.retryStep?.sourceRun?.session_id, retryArtifact.session_id)
    assert.equal(result.finalCycle.trace.attemptNumber, 2)
    assert.equal(result.finalCycle.trace.previousRunId, 'retro-loop-raw-artifact-run-1')
    assert.equal(result.finalCycle.trace.sourceRunId, retryArtifact.id)
    assert.equal(result.finalCycle.trace.sourceSessionId, retryArtifact.session_id)
    assert.equal(persistedCycle1?.retryStep?.summary, 'Captured retry agent run artifact.')
    assert.equal(persistedCycle1?.retryStep?.sourceRun?.id, retryArtifact.id)
    assert.equal(persistedCycle1?.retryStep?.sourceRun?.session_id, retryArtifact.session_id)
    assert.equal(persistedCycle2?.trace.previousRunId, 'retro-loop-raw-artifact-run-1')
    assert.equal(persistedCycle2?.trace.sourceRunId, retryArtifact.id)
    assert.equal(persistedCycle2?.trace.sourceSessionId, retryArtifact.session_id)
    assert.equal(persistedCycle2?.decision.disposition, 'rejected')
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('runRetroLoop does not call retry hook after an accepted cycle', async () => {
  const { loadRetroCycle, runRetroLoop } = await import('../src/index.ts')

  const ledgerDir = await createLedgerDir()
  let hookCallCount = 0

  try {
    const result = await runRetroLoop({
      target: { name: 'clavue-agent-sdk', cwd: ledgerDir },
      evaluators: [async () => ({ findings: [] })],
      gates: [
        {
          name: 'verify-ok',
          command: 'node',
          args: ['-e', 'process.stdout.write("ok")'],
        },
      ],
      ledger: { dir: ledgerDir },
      idPrefix: 'retro-loop-accepted-no-hook',
      maxAttempts: 3,
      onAttemptRetry: () => {
        hookCallCount += 1
        return {
          summary: 'should never run',
          changed: true,
        }
      },
    })

    const persistedCycle = await loadRetroCycle('retro-loop-accepted-no-hook-attempt-1', { dir: ledgerDir })

    assert.equal(result.cycles.length, 1)
    assert.equal(result.finalCycle.decision.accepted, true)
    assert.equal(result.finalCycle.retryStep, undefined)
    assert.equal(persistedCycle?.retryStep, undefined)
    assert.equal(hookCallCount, 0)
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('saveRetroRun and loadRetroRun persist a retro result by run id', async () => {
  const { loadRetroRun, saveRetroRun } = await import('../src/index.ts')

  const result = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'reliability',
            title: 'Retry gap',
            rationale: 'Transient failures need stronger recovery.',
            severity: 'high',
            confidence: 'high',
          },
        ],
      }),
    ],
    runAt: '2026-04-14T00:00:00.000Z',
  })

  const ledgerDir = await createLedgerDir()
  const runId = 'retro-run-test-001'

  try {
    const persistedResult = {
      ...result,
      verification: {
        passed: false,
        summary: 'Quality gate failed: build.',
        startedAt: '2026-04-14T00:00:01.000Z',
        completedAt: '2026-04-14T00:00:03.000Z',
        durationMs: 2000,
        gates: [
          {
            name: 'build',
            command: 'npm',
            args: ['run', 'build'],
            cwd: ledgerDir,
            passed: false,
            exitCode: 1,
            durationMs: 2000,
            stdout: '',
            stderr: 'build failed',
          },
        ],
      },
    }

    await saveRetroRun(runId, persistedResult, { dir: ledgerDir })
    const loaded = await loadRetroRun(runId, { dir: ledgerDir })

    assert.equal(loaded?.summary, result.summary)
    assert.equal(loaded?.run_metadata.runAt, '2026-04-14T00:00:00.000Z')
    assert.equal(loaded?.findings[0]?.title, 'Retry gap')
    assert.equal(loaded?.verification?.passed, false)
    assert.equal(loaded?.verification?.gates[0]?.name, 'build')
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('compareRetroRuns reports score deltas and finding drift', async () => {
  const { compareRetroRuns } = await import('../src/index.ts')

  const previous = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'compatibility',
            title: 'Legacy gateway issue',
            rationale: 'Old gateway handling is still unstable.',
            severity: 'high',
            confidence: 'high',
          },
        ],
      }),
    ],
    runAt: '2026-04-13T00:00:00.000Z',
  })

  const current = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'stability',
            title: 'Boot race',
            rationale: 'Cold start still races on setup.',
            severity: 'medium',
            confidence: 'high',
          },
        ],
      }),
    ],
    runAt: '2026-04-14T00:00:00.000Z',
  })

  const comparison = compareRetroRuns(previous, current)

  assert.equal(comparison.summary.previousRunAt, '2026-04-13T00:00:00.000Z')
  assert.equal(comparison.summary.currentRunAt, '2026-04-14T00:00:00.000Z')
  assert.ok(comparison.scoreDeltas.compatibility.delta > 0)
  assert.ok(comparison.scoreDeltas.stability.delta < 0)
  assert.equal(comparison.newFindings[0]?.title, 'Boot race')
  assert.equal(comparison.resolvedFindings[0]?.title, 'Legacy gateway issue')
})

test('decideRetroAction returns retest when verification fails', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [async () => ({ findings: [] })],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    verification: {
      passed: false,
      summary: 'Quality gate failed: test.',
      startedAt: '2026-04-15T00:00:00.000Z',
      completedAt: '2026-04-15T00:00:01.000Z',
      durationMs: 1000,
      gates: [
        {
          name: 'test',
          command: 'npm',
          args: ['test'],
          cwd: process.cwd(),
          passed: false,
          exitCode: 1,
          durationMs: 1000,
          stdout: '',
          stderr: 'failing test',
        },
      ],
    },
  })

  assert.equal(action.kind, 'retest')
  assert.equal(action.reason, 'Verification failed at gate: test.')
  assert.equal(action.constraints.verificationPassed, false)
  assert.equal(action.constraints.failedVerificationGate, 'test')
})

test('decideRetroAction returns stop when there are no findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [async () => ({ findings: [] })],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'stop')
})

test('decideRetroAction returns attempt_fix for high severity fix findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'reliability',
            title: 'Retry guard missing',
            rationale: 'Transient failures still bubble to callers.',
            severity: 'high',
            confidence: 'high',
            disposition: 'fix',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'attempt_fix')
  assert.equal(action.findingIds.length, 1)
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('decideRetroAction escalates when attempts are exhausted', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'reliability',
            title: 'Retry guard missing',
            rationale: 'Transient failures still bubble to callers.',
            severity: 'high',
            confidence: 'high',
            disposition: 'fix',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    attemptCount: 2,
    policy: { maxAttempts: 2 },
  })

  assert.equal(action.kind, 'escalate')
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('decideRetroAction returns attempt_fix when overall score regresses', async () => {
  const { compareRetroRuns, decideRetroAction } = await import('../src/index.ts')

  const previous = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [async () => ({ findings: [] })],
    runAt: '2026-04-14T00:00:00.000Z',
  })

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'stability',
            title: 'Boot race',
            rationale: 'Startup ordering is unstable.',
            severity: 'medium',
            confidence: 'high',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const comparison = compareRetroRuns(previous, run)
  const action = decideRetroAction({ run, previousRun: previous, comparison })

  assert.equal(action.kind, 'attempt_fix')
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('decideRetroAction returns attempt_fix for medium severity fix findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'stability',
            title: 'Flaky boot path',
            rationale: 'Cold-start behavior is inconsistent.',
            severity: 'medium',
            confidence: 'high',
            disposition: 'fix',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'attempt_fix')
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('decideRetroAction returns retest when investigative findings exist without comparison context', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'stability',
            title: 'Flaky boot path',
            rationale: 'Cold-start behavior is inconsistent.',
            severity: 'medium',
            confidence: 'high',
            disposition: 'investigate',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'retest')
})

test('decideRetroAction returns defer for defer-only findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'interaction_logic',
            title: 'Nice-to-have polish',
            rationale: 'This can wait.',
            severity: 'low',
            confidence: 'medium',
            disposition: 'defer',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'defer')
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('decideRetroAction returns stop for preserve-only findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'interaction_logic',
            title: 'Strong onboarding',
            rationale: 'This should be preserved.',
            severity: 'low',
            confidence: 'medium',
            disposition: 'preserve',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'stop')
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('decideRetroAction falls back to a safe allowed action', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'reliability',
            title: 'Retry gap',
            rationale: 'Transient failures need stronger recovery.',
            severity: 'high',
            confidence: 'high',
            disposition: 'fix',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    policy: { allowedActions: ['defer', 'stop'] },
  })

  assert.equal(action.kind, 'defer')
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('decideRetroAction does not escalate exhausted preserve-only findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'interaction_logic',
            title: 'Strong onboarding',
            rationale: 'This should be preserved.',
            severity: 'low',
            confidence: 'medium',
            disposition: 'preserve',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    attemptCount: 2,
    policy: { maxAttempts: 2 },
  })

  assert.equal(action.kind, 'stop')
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('decideRetroAction prefers escalate first in allowed fallback order', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'reliability',
            title: 'Retry gap',
            rationale: 'Transient failures need stronger recovery.',
            severity: 'high',
            confidence: 'high',
            disposition: 'fix',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    policy: { allowedActions: ['escalate', 'defer', 'stop'] },
  })

  assert.equal(action.kind, 'escalate')
})

test('decideRetroAction never returns an action outside allowedActions', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'reliability',
            title: 'Retry gap',
            rationale: 'Transient failures need stronger recovery.',
            severity: 'high',
            confidence: 'high',
            disposition: 'fix',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    policy: { allowedActions: ['retry_with_more_context'] },
  })

  assert.equal(action.kind, 'retry_with_more_context')
})

test('decideRetroAction uses escalateSeverity for exhausted attempts', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'stability',
            title: 'Boot race',
            rationale: 'Startup ordering is unstable.',
            severity: 'medium',
            confidence: 'high',
            disposition: 'fix',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    attemptCount: 2,
    policy: { maxAttempts: 2, escalateSeverity: 'medium' },
  })

  assert.equal(action.kind, 'escalate')
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('decideRetroAction uses minimumOverallScore when actionable findings remain', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [
      async () => ({
        findings: [
          {
            dimension: 'stability',
            title: 'Boot race',
            rationale: 'Startup ordering is unstable.',
            severity: 'medium',
            confidence: 'high',
            disposition: 'fix',
          },
        ],
      }),
    ],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({
    run,
    policy: { minimumOverallScore: 99 },
  })

  assert.equal(action.kind, 'attempt_fix')
  assert.equal(action.findingIds[0], run.findings[0]?.id)
})

test('saveRetroRun rejects run ids that escape the ledger directory', async () => {
  const { saveRetroRun } = await import('../src/index.ts')

  const result = await runRetroEvaluation({
    target: { name: 'clavue-agent-sdk' },
    evaluators: [async () => ({ findings: [] })],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const ledgerDir = await createLedgerDir()

  try {
    await assert.rejects(
      saveRetroRun('../escape-attempt', result, {
        dir: ledgerDir,
      }),
      /runId/i,
    )
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('loadRetroRun rejects run ids that escape the ledger directory', async () => {
  const { loadRetroRun } = await import('../src/index.ts')
  const ledgerDir = await createLedgerDir()

  try {
    await assert.rejects(
      loadRetroRun('../escape-attempt', {
        dir: ledgerDir,
      }),
      /runId/i,
    )
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('saveRetroCycle rejects cycle ids that escape the ledger directory', async () => {
  const { runRetroCycle, saveRetroCycle } = await import('../src/index.ts')

  const ledgerDir = await createLedgerDir()
  const result = await runRetroCycle({
    target: { name: 'clavue-agent-sdk', cwd: ledgerDir },
    evaluators: [async () => ({ findings: [] })],
    gates: [
      {
        name: 'verify-ok',
        command: 'node',
        args: ['-e', 'process.stdout.write("ok")'],
      },
    ],
  })

  try {
    await assert.rejects(
      saveRetroCycle('../escape-attempt', result, {
        dir: ledgerDir,
      }),
      /cycleId/i,
    )
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('loadRetroCycle rejects cycle ids that escape the ledger directory', async () => {
  const { loadRetroCycle } = await import('../src/index.ts')

  const ledgerDir = await createLedgerDir()

  try {
    await assert.rejects(
      loadRetroCycle('../escape-attempt', {
        dir: ledgerDir,
      }),
      /cycleId/i,
    )
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('loadRetroRun throws when a persisted run is corrupt', async () => {
  const { loadRetroRun } = await import('../src/index.ts')
  const ledgerDir = await createLedgerDir()

  try {
    await writeFile(join(ledgerDir, 'corrupt-run.json'), '{not-json', 'utf-8')
    await assert.rejects(loadRetroRun('corrupt-run', { dir: ledgerDir }), SyntaxError)
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})
