/**
 * Bench — engine.ts hot-path LoC over time + helper extraction count.
 *
 * Reports:
 *   1. Current engine.ts size and the number of src/engine/*.ts helpers.
 *   2. The K-slice progression (1162 → 964) versus baselines.
 *   3. Test count and run wall-time (one full run; not iterated to keep
 *      this fast — pair with `npm run test` for stable averages).
 *
 * No external commands beyond `wc` and `npm run test`. Output is markdown
 * for direct paste into the v2 benchmark report.
 */
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'

import { evaluateEngineFootprintSlos, renderSloVerdict } from './engine-slo.js'
import {
  createDefaultRetroEvaluators,
  runRetroEvaluation,
} from '../../src/retro/index.js'

const REPO_ROOT = join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..', '..')

async function lineCount(path: string): Promise<number> {
  const fs = await import('node:fs/promises')
  const content = await fs.readFile(path, 'utf8')
  return content.split('\n').length
}

async function listHelperFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => e.name)
    .sort()
}

interface ProcessOutcome {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

function runProcess(cmd: string, args: string[]): Promise<ProcessOutcome> {
  return new Promise((resolve) => {
    const t0 = Date.now()
    const child = spawn(cmd, args, { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf8') })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf8') })
    child.on('close', (code) => {
      resolve({
        exitCode: typeof code === 'number' ? code : -1,
        stdout,
        stderr,
        durationMs: Date.now() - t0,
      })
    })
  })
}

async function main(): Promise<void> {
  const enginePath = join(REPO_ROOT, 'src', 'engine.ts')
  const helpersDir = join(REPO_ROOT, 'src', 'engine')

  const engineLoc = await lineCount(enginePath)
  const helperFiles = await listHelperFiles(helpersDir)
  let helperLoc = 0
  for (const file of helperFiles) {
    helperLoc += await lineCount(join(helpersDir, file))
  }

  console.log('# Engine refactor footprint\n')
  console.log('## Current state\n')
  console.log(`- \`src/engine.ts\`: **${engineLoc} lines**`)
  console.log(`- \`src/engine/*.ts\` helpers: **${helperFiles.length} files, ${helperLoc} lines**`)
  console.log('')
  console.log('Helper modules:')
  for (const f of helperFiles) {
    const loc = await lineCount(join(helpersDir, f))
    console.log(`  - \`${f}\` (${loc} lines)`)
  }

  console.log('\n## Slice K progression (audit P1-1 god-class)\n')
  console.log('| Stage | engine.ts LoC | Δ vs baseline | Helpers |')
  console.log('|---|---:|---:|---:|')
  console.log('| Audit baseline (commit 2567223) | 1537 | — | 0 |')
  console.log('| After Slice A-J (pre-K) | 1162 | -375 | 7 |')
  console.log('| After Slice K1-K5 (M1 pipeline) | 983 | -554 | 19 |')
  console.log('| After M2 (executeTools + runSubmitMessage) | ' + engineLoc + ' | ' + (engineLoc - 1537) + ' | ' + helperFiles.length + ' |')
  console.log('')
  console.log(`Net reduction: **${(((1537 - engineLoc) / 1537) * 100).toFixed(1)}%** vs audit baseline.`)
  if (engineLoc < 500) {
    console.log(`v2 architecture goal (<500 hot-path lines) met; current is ${engineLoc}.`)
  } else {
    console.log(`v2 architecture goal was <500 hot-path lines; current is ${engineLoc} (${engineLoc - 500} over).`)
  }

  console.log('\n## Test suite size and wall-time\n')
  const testRun = await runProcess('npm', ['run', '--silent', 'test'])
  let testCount: number | null = null
  let testWallMs: number | null = null
  if (testRun.exitCode !== 0) {
    console.log(`Test run failed with exit ${testRun.exitCode}:`)
    console.log(testRun.stderr.slice(0, 500))
  } else {
    const passMatch = testRun.stdout.match(/^# pass (\d+)$/m)
    const failMatch = testRun.stdout.match(/^# fail (\d+)$/m)
    testCount = passMatch ? Number(passMatch[1]) : null
    testWallMs = testRun.durationMs
    console.log(`- Tests passing: **${passMatch?.[1] ?? '?'}**`)
    console.log(`- Tests failing: **${failMatch?.[1] ?? '?'}**`)
    console.log(`- Wall-time (single run): **${(testRun.durationMs / 1000).toFixed(1)}s**`)
  }

  // Retro overall score — eval harness wired in M3.3. Offline-safe: any
  // throw or NaN downgrades to `null`, which the SLO gate treats as
  // breach. Opt out by setting `BENCH_ENGINE_SKIP_RETRO=1`.
  console.log('\n## Retro overall score\n')
  let retroOverall: number | null | undefined
  if (process.env.BENCH_ENGINE_SKIP_RETRO) {
    retroOverall = undefined
    console.log('- Skipped (BENCH_ENGINE_SKIP_RETRO set).')
  } else {
    try {
      const retro = await runRetroEvaluation({
        target: { name: 'clavue-agent-sdk', cwd: REPO_ROOT },
        evaluators: createDefaultRetroEvaluators(),
        runAt: new Date().toISOString(),
      })
      const overall = retro.scores.overall.score
      retroOverall = Number.isFinite(overall) ? overall : null
      console.log(`- Overall: **${retroOverall ?? '?'}**`)
      console.log(`- Findings: ${retro.findings.length}`)
      for (const dim of Object.keys(retro.scores.byDimension)) {
        const s = retro.scores.byDimension[dim as keyof typeof retro.scores.byDimension]
        console.log(`  - ${dim}: ${s.score}`)
      }
    } catch (err) {
      retroOverall = null
      console.log(`- Retro run failed: ${(err as Error).message}`)
    }
  }

  // Enforced SLO gate — exits non-zero on breach so PRs see the regression.
  const verdict = evaluateEngineFootprintSlos({ engineLoc, testCount, testWallMs, retroOverall })
  console.log('\n' + renderSloVerdict(verdict))
  if (!verdict.ok) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('bench failed:', err)
  process.exit(1)
})
