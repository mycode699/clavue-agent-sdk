/**
 * SLO check for engine-footprint bench. Pure function so tests can pin
 * the verdict logic without spawning `npm run test`.
 *
 * Thresholds mirror `docs/v2_benchmark_report.md §7` exactly. Bumping a
 * threshold here means bumping it in that table — keep them in sync.
 */

export interface EngineFootprintMetrics {
  /** `src/engine.ts` line count. */
  engineLoc: number
  /** Number of passing tests reported by `node:test`. `null` if the run failed. */
  testCount: number | null
  /** Wall-time of `npm run test` in milliseconds. `null` if the run failed. */
  testWallMs: number | null
}

export interface SloCheck {
  name: string
  value: number | null
  threshold: number
  /** Comparison operator that must hold for `ok: true`. */
  op: '<' | '<=' | '>=' | '>'
  ok: boolean
  message: string
}

export interface SloVerdict {
  ok: boolean
  checks: SloCheck[]
}

/**
 * SLO thresholds — single source of truth alongside docs.
 */
export const ENGINE_FOOTPRINT_SLOS = {
  engineLocCeiling: 1100,
  testCountFloor: 625,
  testWallMsCeiling: 60_000,
} as const

function compare(value: number, op: SloCheck['op'], threshold: number): boolean {
  switch (op) {
    case '<': return value < threshold
    case '<=': return value <= threshold
    case '>=': return value >= threshold
    case '>': return value > threshold
  }
}

/**
 * Evaluate the three engine-footprint SLOs against observed metrics.
 *
 * A `null` metric is treated as a failed check (test run blew up,
 * couldn't measure). The verdict is `ok: false` if any check fails.
 */
export function evaluateEngineFootprintSlos(metrics: EngineFootprintMetrics): SloVerdict {
  const checks: SloCheck[] = []

  // Engine LoC ceiling.
  {
    const value = metrics.engineLoc
    const threshold = ENGINE_FOOTPRINT_SLOS.engineLocCeiling
    const ok = compare(value, '<', threshold)
    checks.push({
      name: 'engine.ts LoC',
      value,
      threshold,
      op: '<',
      ok,
      message: ok
        ? `${value} < ${threshold}`
        : `${value} ≥ ${threshold} — engine.ts hot-path regressed past the SLO ceiling`,
    })
  }

  // Test count floor.
  {
    const value = metrics.testCount
    const threshold = ENGINE_FOOTPRINT_SLOS.testCountFloor
    const ok = value !== null && compare(value, '>=', threshold)
    checks.push({
      name: 'test count',
      value,
      threshold,
      op: '>=',
      ok,
      message: value === null
        ? 'test run failed — count unavailable'
        : ok
          ? `${value} ≥ ${threshold}`
          : `${value} < ${threshold} — test surface shrank below the SLO floor`,
    })
  }

  // Test wall-time ceiling.
  {
    const value = metrics.testWallMs
    const threshold = ENGINE_FOOTPRINT_SLOS.testWallMsCeiling
    const ok = value !== null && compare(value, '<', threshold)
    checks.push({
      name: 'test wall-time',
      value,
      threshold,
      op: '<',
      ok,
      message: value === null
        ? 'test run failed — wall-time unavailable'
        : ok
          ? `${(value / 1000).toFixed(1)}s < ${(threshold / 1000).toFixed(0)}s`
          : `${(value / 1000).toFixed(1)}s ≥ ${(threshold / 1000).toFixed(0)}s — suite slowed past the SLO ceiling`,
    })
  }

  return { ok: checks.every((c) => c.ok), checks }
}

/** Render a markdown verdict block for human-readable bench output. */
export function renderSloVerdict(verdict: SloVerdict): string {
  const lines: string[] = []
  lines.push('## SLO verdict\n')
  lines.push('| Check | Verdict | Detail |')
  lines.push('|---|---|---|')
  for (const c of verdict.checks) {
    const badge = c.ok ? '✅ pass' : '❌ breach'
    lines.push(`| ${c.name} | ${badge} | ${c.message} |`)
  }
  lines.push('')
  lines.push(verdict.ok
    ? 'All SLOs within budget.'
    : '**SLO breach** — at least one check failed; bench:engine exits non-zero.')
  return lines.join('\n')
}
