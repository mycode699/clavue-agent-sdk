import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runRetroEvaluation, type RetroEvaluator } from '../src/index.ts'

async function createLedgerDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'open-agent-sdk-retro-'))
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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

  const evaluators = createDefaultRetroEvaluators()
  const result = await runRetroEvaluation({
    target: {
      name: 'open-agent-sdk-typescript',
      cwd: '/Users/lu/openagent/open-agent-sdk-typescript',
    },
    evaluators,
    runAt: '2026-04-14T00:00:00.000Z',
  })

  assert.equal(evaluators.length, 4)
  assert.equal(result.findings.length, 0)
  assert.equal(result.scores.overall.score, 100)
  assert.equal(result.proposed_workstreams.length, 0)
})

test('saveRetroRun and loadRetroRun persist a retro result by run id', async () => {
  const { loadRetroRun, saveRetroRun } = await import('../src/index.ts')

  const result = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
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
    await saveRetroRun(runId, result, { dir: ledgerDir })
    const loaded = await loadRetroRun(runId, { dir: ledgerDir })

    assert.equal(loaded?.summary, result.summary)
    assert.equal(loaded?.run_metadata.runAt, '2026-04-14T00:00:00.000Z')
    assert.equal(loaded?.findings[0]?.title, 'Retry gap')
  } finally {
    await rm(ledgerDir, { recursive: true, force: true })
  }
})

test('compareRetroRuns reports score deltas and finding drift', async () => {
  const { compareRetroRuns } = await import('../src/index.ts')

  const previous = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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

test('decideRetroAction returns stop when there are no findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [async () => ({ findings: [] })],
    runAt: '2026-04-15T00:00:00.000Z',
  })

  const action = decideRetroAction({ run })

  assert.equal(action.kind, 'stop')
})

test('decideRetroAction returns attempt_fix for high severity fix findings', async () => {
  const { decideRetroAction } = await import('../src/index.ts')

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
    evaluators: [async () => ({ findings: [] })],
    runAt: '2026-04-14T00:00:00.000Z',
  })

  const run = await runRetroEvaluation({
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
    target: { name: 'open-agent-sdk-typescript' },
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
