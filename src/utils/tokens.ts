/**
 * Token Estimation & Counting
 *
 * Provides content-aware token estimation (character-based with type-specific
 * coefficients) and API-based exact counting when available.
 *
 * Background (audit P0-3): a flat ~4 chars/token underestimates code (~3
 * chars/token), JSON tool results (~2.5), and CJK text (~1.5). This module
 * detects content type and uses calibrated divisors to keep the estimate
 * within roughly +/- 5-10% on typical agent payloads, which keeps autocompact
 * triggering before the provider returns prompt_too_long.
 */

/**
 * Approximate chars-per-token coefficients per content class.
 * Numbers come from empirical measurements (Anthropic + OpenAI tokenizers).
 */
const CHARS_PER_TOKEN = {
  english: 4.0,
  code: 3.0,
  json: 2.6,
  cjk: 1.6,
} as const

/**
 * Heuristically classify a string so we can pick a more accurate divisor.
 * Order matters: JSON-looking content first (it can contain CJK / code-like
 * symbols), then CJK, then code, otherwise english.
 */
function classifyContent(text: string): keyof typeof CHARS_PER_TOKEN {
  if (text.length === 0) return 'english'

  const trimmed = text.trimStart()
  const head = trimmed.charAt(0)
  if (head === '{' || head === '[') {
    // Cheap structural sniff. We don't need a full parser.
    const tail = trimmed.charAt(trimmed.length - 1)
    if (tail === '}' || tail === ']') return 'json'
  }

  // CJK detection. Sample up to 4096 chars to keep this O(1)-ish on huge inputs.
  const sample = text.length > 4096 ? text.slice(0, 4096) : text
  let cjk = 0
  for (let i = 0; i < sample.length; i++) {
    const code = sample.charCodeAt(i)
    // CJK Unified Ideographs, Hiragana, Katakana, Hangul ranges.
    if (
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0xac00 && code <= 0xd7af) ||
      (code >= 0xf900 && code <= 0xfaff)
    ) {
      cjk++
    }
  }
  if (cjk / sample.length > 0.2) return 'cjk'

  // Code detection: punctuation / brackets / operators relative to word
  // chars. The symbol set covers common source-code punctuation across
  // most languages, not just C-style. The 0.08 threshold is calibrated
  // against scripts/bench/token-estimator.ts so real TypeScript/JS snippets
  // classify as code instead of degenerating to english (which underestimated
  // tokens by ~15% on typical agent payloads).
  let symbols = 0
  let words = 0
  for (let i = 0; i < sample.length; i++) {
    const ch = sample.charCodeAt(i)
    if (
      ch === 0x7b /*{*/ ||
      ch === 0x7d /*}*/ ||
      ch === 0x28 /*(*/ ||
      ch === 0x29 /*)*/ ||
      ch === 0x5b /*[*/ ||
      ch === 0x5d /*]*/ ||
      ch === 0x3b /*;*/ ||
      ch === 0x3a /*:*/ ||
      ch === 0x3d /*=*/ ||
      ch === 0x3c /*<*/ ||
      ch === 0x3e /*>*/ ||
      ch === 0x2f /*/*/ ||
      ch === 0x5c /*\*/ ||
      ch === 0x7c /*|*/ ||
      ch === 0x26 /*&*/ ||
      ch === 0x2a /***/ ||
      ch === 0x2b /*+*/ ||
      ch === 0x2d /*-*/ ||
      ch === 0x21 /*!*/ ||
      ch === 0x3f /*?*/
    ) {
      symbols++
    } else if ((ch >= 0x41 && ch <= 0x5a) || (ch >= 0x61 && ch <= 0x7a)) {
      words++
    }
  }
  if (words > 0 && symbols / Math.max(words, 1) > 0.08) return 'code'

  return 'english'
}

/**
 * Content-aware token estimation. The divisor is chosen by classifying the
 * input. Always returns at least 1 for non-empty strings so a tiny tool
 * result never registers as zero tokens.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  const divisor = CHARS_PER_TOKEN[classifyContent(text)]
  return Math.max(1, Math.ceil(text.length / divisor))
}

/**
 * Estimate tokens for a message array.
 *
 * Per-block overhead (~3 tokens) approximates message framing tokens that
 * tokenizers add for role/turn boundaries. Tool blocks are treated as JSON
 * for divisor selection regardless of inner shape.
 */
export function estimateMessagesTokens(
  messages: Array<{ role: string; content: any }>,
): number {
  const PER_MESSAGE_OVERHEAD = 3
  const PER_BLOCK_OVERHEAD = 1
  let total = 0
  for (const msg of messages) {
    total += PER_MESSAGE_OVERHEAD
    if (typeof msg.content === 'string') {
      total += estimateTokens(msg.content)
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        total += PER_BLOCK_OVERHEAD
        if ('text' in block && typeof block.text === 'string') {
          total += estimateTokens(block.text)
        } else if ('content' in block && typeof block.content === 'string') {
          // tool_result content is typically JSON / structured text.
          total += estimateTokens(block.content)
        } else {
          // tool_use input, image refs, thinking blocks — fall back to JSON.
          total += estimateTokens(JSON.stringify(block))
        }
      }
    }
  }
  return total
}

/**
 * Estimate tokens for a system prompt.
 */
export function estimateSystemPromptTokens(systemPrompt: string): number {
  return estimateTokens(systemPrompt)
}

/**
 * Count tokens from API usage response.
 */
export function getTokenCountFromUsage(usage: {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}): number {
  return (
    usage.input_tokens +
    usage.output_tokens +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0)
  )
}

/**
 * Get the context window size for a model.
 */
export function getContextWindowSize(model: string): number {
  // Anthropic model context windows
  if (model.includes('opus-4') && model.includes('1m')) return 1_000_000
  if (model.includes('opus-4')) return 200_000
  if (model.includes('sonnet-4')) return 200_000
  if (model.includes('haiku-4')) return 200_000
  if (model.includes('claude-3')) return 200_000

  // OpenAI model context windows
  if (model.includes('gpt-4o')) return 128_000
  if (model.includes('gpt-4-turbo')) return 128_000
  if (model.includes('gpt-4-1')) return 1_000_000
  if (model.includes('gpt-4')) return 128_000
  if (model.includes('gpt-3.5')) return 16_385
  if (model.includes('o1')) return 200_000
  if (model.includes('o3')) return 200_000
  if (model.includes('o4')) return 200_000

  // DeepSeek models
  if (model.includes('deepseek')) return 128_000

  // Default
  return 200_000
}

/**
 * Auto-compact buffer (minimum): never keep the threshold closer to the
 * window ceiling than this many tokens. Exported for backward compatibility
 * with hosts that import the constant directly.
 */
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

/**
 * Fraction of the context window reserved as compact headroom. A 1M window
 * model keeps ~80k tokens of safety margin; a 128k model keeps ~10k.
 */
export const AUTOCOMPACT_BUFFER_FRACTION = 0.08

/**
 * Get the auto-compact threshold for a model. Derived as
 * `window - max(window * AUTOCOMPACT_BUFFER_FRACTION, AUTOCOMPACT_BUFFER_TOKENS)`
 * so both small and large windows get proportionally sane headroom.
 *
 * Previously this was `window - 13_000`, which under-reserved big windows
 * (opus-4 1M -> 1.3% headroom) and over-reserved small ones.
 */
export function getAutoCompactThreshold(model: string): number {
  const window = getContextWindowSize(model)
  const proportional = Math.ceil(window * AUTOCOMPACT_BUFFER_FRACTION)
  const buffer = Math.max(proportional, AUTOCOMPACT_BUFFER_TOKENS)
  return Math.max(0, window - buffer)
}

/**
 * Model pricing (USD per token).
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  // Anthropic models
  'claude-opus-4-6': { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  'claude-opus-4-5': { input: 15 / 1_000_000, output: 75 / 1_000_000 },
  'claude-sonnet-4-6': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-sonnet-4-5': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-haiku-4-5': { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  'claude-3-5-sonnet': { input: 3 / 1_000_000, output: 15 / 1_000_000 },
  'claude-3-5-haiku': { input: 0.8 / 1_000_000, output: 4 / 1_000_000 },
  'claude-3-opus': { input: 15 / 1_000_000, output: 75 / 1_000_000 },

  // OpenAI models
  'gpt-4o': { input: 2.5 / 1_000_000, output: 10 / 1_000_000 },
  'gpt-4o-mini': { input: 0.15 / 1_000_000, output: 0.6 / 1_000_000 },
  'gpt-4-turbo': { input: 10 / 1_000_000, output: 30 / 1_000_000 },
  'gpt-4-1': { input: 2 / 1_000_000, output: 8 / 1_000_000 },
  'o1': { input: 15 / 1_000_000, output: 60 / 1_000_000 },
  'o3': { input: 10 / 1_000_000, output: 40 / 1_000_000 },
  'o4-mini': { input: 1.1 / 1_000_000, output: 4.4 / 1_000_000 },

  // DeepSeek models
  'deepseek-chat': { input: 0.27 / 1_000_000, output: 1.1 / 1_000_000 },
  'deepseek-reasoner': { input: 0.55 / 1_000_000, output: 2.19 / 1_000_000 },
}

/**
 * Estimate cost from usage and model.
 */
export function estimateCost(
  model: string,
  usage: { input_tokens: number; output_tokens: number },
): number {
  const pricing = Object.entries(MODEL_PRICING).find(([key]) =>
    model.includes(key),
  )?.[1] ?? { input: 3 / 1_000_000, output: 15 / 1_000_000 }

  return usage.input_tokens * pricing.input + usage.output_tokens * pricing.output
}
