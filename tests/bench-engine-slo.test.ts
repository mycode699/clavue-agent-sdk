/**
 * Bench:engine SLO gate — locks the contract that engine-footprint.ts
 * is no longer a passive printer. The pure verdict function lives in
 * `scripts/bench/engine-slo.ts` so we can pin every threshold without
 * spawning the full bench harness.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ENGINE_FOOTPRINT_SLOS,
  evaluateEngineFootprintSlos,
  renderSloVerdict,
} from '../scripts/bench/engine-slo.ts'

test('engine SLO thresholds match docs/v2_benchmark_report.md §7', () => {
  // The docs table is the public contract; this catches accidental drift.
  assert.equal(ENGINE_FOOTPRINT_SLOS.engineLocCeiling, 500)
  assert.equal(ENGINE_FOOTPRINT_SLOS.testCountFloor, 720)
  assert.equal(ENGINE_FOOTPRINT_SLOS.testWallMsCeiling, 60_000)
  assert.equal(ENGINE_FOOTPRINT_SLOS.retroOverallFloor, 70)
})

test('all-green metrics produce ok verdict', () => {
  const verdict = evaluateEngineFootprintSlos({
    engineLoc: 350,
    testCount: 779,
    testWallMs: 35_000,
    retroOverall: 80,
  })
  assert.equal(verdict.ok, true)
  assert.equal(verdict.checks.length, 4)
  for (const c of verdict.checks) assert.equal(c.ok, true, `${c.name} should pass`)
})

test('engine.ts LoC at or above 500 breaches the ceiling', () => {
  const at = evaluateEngineFootprintSlos({ engineLoc: 500, testCount: 779, testWallMs: 35_000, retroOverall: 80 })
  assert.equal(at.ok, false)
  const locCheck = at.checks.find((c) => c.name === 'engine.ts LoC')
  assert.equal(locCheck?.ok, false)
  assert.match(locCheck!.message, /500/)

  const above = evaluateEngineFootprintSlos({ engineLoc: 800, testCount: 779, testWallMs: 35_000, retroOverall: 80 })
  assert.equal(above.ok, false)
})

test('test count below 720 breaches the floor', () => {
  const v = evaluateEngineFootprintSlos({ engineLoc: 350, testCount: 719, testWallMs: 35_000, retroOverall: 80 })
  assert.equal(v.ok, false)
  const c = v.checks.find((c) => c.name === 'test count')
  assert.equal(c?.ok, false)
  assert.match(c!.message, /719 < 720/)
})

test('test wall-time at or above 60s breaches the ceiling', () => {
  const v = evaluateEngineFootprintSlos({ engineLoc: 350, testCount: 779, testWallMs: 60_000, retroOverall: 80 })
  assert.equal(v.ok, false)
  const c = v.checks.find((c) => c.name === 'test wall-time')
  assert.equal(c?.ok, false)
  assert.match(c!.message, /60\.0s/)
})

test('retro overall below 70 breaches the floor', () => {
  const v = evaluateEngineFootprintSlos({ engineLoc: 350, testCount: 779, testWallMs: 35_000, retroOverall: 69 })
  assert.equal(v.ok, false)
  const c = v.checks.find((c) => c.name === 'retro overall')
  assert.equal(c?.ok, false)
  assert.match(c!.message, /69 < 70/)
})

test('null retro (skipped or failed) is treated as a soft skip when undefined', () => {
  // undefined → SLO not enforced (offline-safe). null → enforced and breached.
  const skipped = evaluateEngineFootprintSlos({ engineLoc: 350, testCount: 779, testWallMs: 35_000 })
  assert.equal(skipped.ok, true)
  assert.equal(skipped.checks.length, 3, 'undefined retro → no retro check')

  const broken = evaluateEngineFootprintSlos({ engineLoc: 350, testCount: 779, testWallMs: 35_000, retroOverall: null })
  assert.equal(broken.ok, false)
  const c = broken.checks.find((c) => c.name === 'retro overall')
  assert.equal(c?.ok, false)
  assert.match(c!.message, /retro run failed/)
})

test('null metrics (test run failure) breach the verdict', () => {
  const v = evaluateEngineFootprintSlos({ engineLoc: 350, testCount: null, testWallMs: null })
  assert.equal(v.ok, false)
  const count = v.checks.find((c) => c.name === 'test count')
  const wall = v.checks.find((c) => c.name === 'test wall-time')
  assert.equal(count?.ok, false)
  assert.equal(wall?.ok, false)
  assert.match(count!.message, /test run failed/)
  assert.match(wall!.message, /test run failed/)
})

test('renderSloVerdict marks breach with bold message', () => {
  const ok = renderSloVerdict({
    ok: true,
    checks: [{ name: 'x', value: 1, threshold: 2, op: '<', ok: true, message: '1 < 2' }],
  })
  assert.match(ok, /✅ pass/)
  assert.match(ok, /All SLOs within budget/)

  const breach = renderSloVerdict({
    ok: false,
    checks: [{ name: 'x', value: 3, threshold: 2, op: '<', ok: false, message: '3 ≥ 2' }],
  })
  assert.match(breach, /❌ breach/)
  assert.match(breach, /\*\*SLO breach\*\*/)
})
