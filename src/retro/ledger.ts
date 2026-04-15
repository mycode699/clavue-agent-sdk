import { mkdir, readFile, writeFile } from 'fs/promises'
import { join, resolve, sep } from 'path'
import type { RetroRunResult } from './types.js'

export interface RetroLedgerOptions {
  dir?: string
}

function getDefaultLedgerDir(): string {
  const home = process.env.HOME || process.env.USERPROFILE || '/tmp'
  return join(home, '.open-agent-sdk', 'retro-runs')
}

function getLedgerDir(options?: RetroLedgerOptions): string {
  return options?.dir ?? getDefaultLedgerDir()
}

function getRunPath(runId: string, options?: RetroLedgerOptions): string {
  const ledgerDir = resolve(getLedgerDir(options))
  const runPath = resolve(ledgerDir, `${runId}.json`)

  if (runPath !== ledgerDir && !runPath.startsWith(`${ledgerDir}${sep}`)) {
    throw new Error('Invalid runId: path must stay within the ledger directory.')
  }

  return runPath
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
