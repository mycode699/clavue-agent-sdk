import { mkdir, readFile, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import type { RetroCycleResult, RetroLedgerOptions, RetroRunResult } from './types.js'

function getDefaultLedgerDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  return join(home, '.clavue-agent-sdk', 'retro-runs')
}

function getLedgerDir(options?: RetroLedgerOptions): string {
  return options?.dir ?? getDefaultLedgerDir()
}

function getLedgerPath(
  id: string,
  suffix: string,
  idLabel: 'runId' | 'cycleId',
  options?: RetroLedgerOptions,
): string {
  const ledgerDir = resolve(getLedgerDir(options))
  const ledgerPath = resolve(ledgerDir, `${id}${suffix}`)

  if (ledgerPath !== ledgerDir && !ledgerPath.startsWith(`${ledgerDir}${sep}`)) {
    throw new Error(`Invalid ${idLabel}: path must stay within the ledger directory.`)
  }

  return ledgerPath
}

function getRunPath(runId: string, options?: RetroLedgerOptions): string {
  return getLedgerPath(runId, '.json', 'runId', options)
}

function getCyclePath(cycleId: string, options?: RetroLedgerOptions): string {
  return getLedgerPath(cycleId, '.cycle.json', 'cycleId', options)
}

export async function saveRetroRun(
  runId: string,
  result: RetroRunResult,
  options?: RetroLedgerOptions,
): Promise<void> {
  await mkdir(getLedgerDir(options), { recursive: true })
  await writeFile(getRunPath(runId, options), JSON.stringify(result, null, 2), 'utf-8')
}

export async function loadRetroRun(
  runId: string,
  options?: RetroLedgerOptions,
): Promise<RetroRunResult | null> {
  const runPath = getRunPath(runId, options)

  try {
    const content = await readFile(runPath, 'utf-8')
    return JSON.parse(content) as RetroRunResult
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}

export async function saveRetroCycle(
  cycleId: string,
  result: RetroCycleResult,
  options?: RetroLedgerOptions,
): Promise<void> {
  await mkdir(getLedgerDir(options), { recursive: true })
  await writeFile(getCyclePath(cycleId, options), JSON.stringify(result, null, 2), 'utf-8')
}

export async function loadRetroCycle(
  cycleId: string,
  options?: RetroLedgerOptions,
): Promise<RetroCycleResult | null> {
  const cyclePath = getCyclePath(cycleId, options)

  try {
    const content = await readFile(cyclePath, 'utf-8')
    return JSON.parse(content) as RetroCycleResult
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return null
    }

    throw error
  }
}
