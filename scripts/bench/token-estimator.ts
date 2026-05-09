/**
 * Bench — token estimator accuracy.
 *
 * Two questions worth answering, in priority order:
 *
 *   Q1 (offline, always runs): how does the v2 content-aware estimator
 *       compare to the legacy 4-chars/token rule on representative content?
 *       We can't claim absolute accuracy without a real tokenizer, but we
 *       CAN show the v2 estimator separates English / code / JSON / CJK
 *       in a way the legacy rule did not.
 *
 *   Q2 (online, opt-in): how close is the v2 estimator to a real
 *       tokenizer? Run with ANTHROPIC_API_KEY (or CLAVUE_AGENT_API_KEY)
 *       set to use Anthropic's `client.messages.countTokens` as ground
 *       truth. Otherwise this section is skipped.
 *
 * Output is markdown so it pastes directly into the v2 benchmark report.
 * No iteration timing — token estimation is O(n) over input chars and
 * not a hot path; what matters is *accuracy*, not speed.
 */
import { estimateTokens } from '../../src/utils/tokens.js'

interface Sample {
  kind: 'english' | 'code' | 'json' | 'cjk'
  label: string
  text: string
}

const ENGLISH_PARAGRAPH = `The quick brown fox jumps over the lazy dog. This pangram is commonly used to test fonts and keyboards because it contains every letter of the English alphabet at least once.`

const TS_CODE_SNIPPET = `export function sum(arr: number[]): number {
  let total = 0
  for (const value of arr) {
    total += value
  }
  return total
}`

const JSON_TOOL_RESULT = `{"type":"tool_result","tool_use_id":"toolu_01Ab3cD","is_error":false,"content":[{"type":"text","text":"ok"}],"evidence":[{"source":"tool","summary":"read 1 file"}],"quality_gates":[{"name":"lint","status":"passed"}]}`

const CHINESE_TEXT = `这是一个用来验证中文 token 计数准确度的样本段落。它包含常见的标点符号、数字 42、以及混合的英文单词如 agent 和 token。中文字符通常被分词器切成 1.5 到 2 个 token。`

const samples: Sample[] = [
  { kind: 'english', label: 'English pangram (200 chars)', text: ENGLISH_PARAGRAPH },
  { kind: 'code', label: 'TypeScript snippet (~110 chars)', text: TS_CODE_SNIPPET },
  { kind: 'json', label: 'JSON tool_result (~220 chars)', text: JSON_TOOL_RESULT },
  { kind: 'cjk', label: 'Simplified Chinese mixed (~105 chars)', text: CHINESE_TEXT },
]

interface OfflineRow {
  kind: Sample['kind']
  label: string
  chars: number
  legacy: number
  v2: number
  /** Tokens per char — v2 should differ across kinds; legacy is constant 0.25. */
  v2Density: number
  legacyDensity: number
}

function offlineRow(sample: Sample): OfflineRow {
  const chars = sample.text.length
  const legacy = Math.ceil(chars / 4)
  const v2 = estimateTokens(sample.text)
  return {
    kind: sample.kind,
    label: sample.label,
    chars,
    legacy,
    v2,
    legacyDensity: legacy / chars,
    v2Density: v2 / chars,
  }
}

function offlineSection(): OfflineRow[] {
  console.log('\n## Token estimator — offline comparison (legacy 4:1 vs v2 content-aware)\n')
  console.log('| Content | chars | legacy tokens | legacy density | v2 tokens | v2 density |')
  console.log('|---|---:|---:|---:|---:|---:|')
  const rows = samples.map(offlineRow)
  for (const r of rows) {
    console.log(
      `| ${r.kind} | ${r.chars} | ${r.legacy} | ${r.legacyDensity.toFixed(3)} | ${r.v2} | ${r.v2Density.toFixed(3)} |`,
    )
  }
  console.log('')
  const densities = rows.map((r) => r.v2Density)
  const range = Math.max(...densities) - Math.min(...densities)
  console.log(
    `Legacy estimator density: constant 0.250 tokens/char regardless of content.\n` +
    `v2 estimator density spread: ${range.toFixed(3)} (higher = better content separation).\n` +
    `If v2 spread is 0, the content classifier is broken.`,
  )
  return rows
}

interface OnlineRow extends OfflineRow {
  reference: number
  legacyError: number
  v2Error: number
}

async function onlineSection(offline: OfflineRow[]): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY
    ?? process.env.CLAVUE_AGENT_API_KEY
    ?? process.env.CLAVUE_AGENT_AUTH_TOKEN
    ?? process.env.ANTHROPIC_AUTH_TOKEN
  if (!apiKey) {
    console.log(
      '\n## Token estimator — online comparison\n\n' +
      'Skipped (no ANTHROPIC_API_KEY / CLAVUE_AGENT_API_KEY in env). Re-run with one\n' +
      'of those set to compare against `client.messages.countTokens`.',
    )
    return
  }

  let Anthropic: any
  try {
    Anthropic = (await import('@anthropic-ai/sdk')).default
  } catch {
    console.log('\n(Online comparison: @anthropic-ai/sdk not installed; skipping.)')
    return
  }

  const baseURL = process.env.ANTHROPIC_BASE_URL ?? process.env.CLAVUE_AGENT_BASE_URL
  const client = new Anthropic({ apiKey, baseURL })
  const model = process.env.CLAVUE_AGENT_MODEL ?? 'claude-sonnet-4-6'

  console.log('\n## Token estimator — online comparison (vs Anthropic countTokens)\n')
  console.log(`Model: \`${model}\``)
  console.log('')
  console.log('| Content | chars | legacy | legacy err | v2 | v2 err | reference |')
  console.log('|---|---:|---:|---:|---:|---:|---:|')

  const onlineRows: OnlineRow[] = []
  for (const sample of samples) {
    let reference: number
    try {
      const r = await client.messages.countTokens({
        model,
        messages: [{ role: 'user', content: sample.text }],
      })
      reference = r.input_tokens
    } catch (err) {
      console.log(`| ${sample.kind} | — | — | — | — | — | (countTokens failed: ${(err as Error).message.slice(0, 40)}) |`)
      continue
    }
    const off = offline.find((o) => o.kind === sample.kind)!
    const legacyErr = Math.abs(off.legacy - reference) / reference
    const v2Err = Math.abs(off.v2 - reference) / reference
    onlineRows.push({ ...off, reference, legacyError: legacyErr, v2Error: v2Err })
    console.log(
      `| ${sample.kind} | ${off.chars} | ${off.legacy} | ${(legacyErr * 100).toFixed(1)}% | ${off.v2} | ${(v2Err * 100).toFixed(1)}% | ${reference} |`,
    )
  }
  if (onlineRows.length > 0) {
    const meanLegacy = onlineRows.reduce((s, r) => s + r.legacyError, 0) / onlineRows.length
    const meanV2 = onlineRows.reduce((s, r) => s + r.v2Error, 0) / onlineRows.length
    console.log('')
    console.log(`Mean error: legacy ${(meanLegacy * 100).toFixed(1)}% vs v2 ${(meanV2 * 100).toFixed(1)}% — `
      + `${((1 - meanV2 / meanLegacy) * 100).toFixed(0)}% reduction.`)
  }
}

async function main(): Promise<void> {
  const offline = offlineSection()
  await onlineSection(offline)
}

main().catch((err) => {
  console.error('bench failed:', err)
  process.exit(1)
})
