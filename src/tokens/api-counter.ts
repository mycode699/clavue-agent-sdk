/**
 * Slice G — TokenCounter interface + API-backed counter (additive).
 *
 * The engine still uses heuristic `estimateTokens` from `utils/tokens.ts`
 * by default. Hosts that want more accurate counting can construct an
 * `ApiBackedCounter`, which calibrates EMA-smoothed coefficients per
 * content class against a structural `client.messages.countTokens`
 * endpoint exposed by the host.
 *
 * Zero new runtime deps. The client is structural (`CountTokensClientLike`),
 * so hosts can supply any object with a `messages.countTokens` method.
 */
import { estimateTokens } from '../utils/tokens.js'

/**
 * Structural client surface required by `ApiBackedCounter`.
 * Mirrors Anthropic SDK's `client.messages.countTokens({ messages, model })`
 * shape but without taking an SDK dep.
 */
export interface CountTokensClientLike {
  messages: {
    countTokens: (input: { model: string; messages: unknown[] }) => Promise<{ input_tokens: number }>
  }
}

/**
 * Generic token counter. The default in-process counter is
 * `heuristicCounter`; hosts that want API-backed accuracy plug in
 * `ApiBackedCounter`.
 */
export interface TokenCounter {
  /** Best estimate of tokens for a single text fragment. */
  count(text: string): number
  /**
   * Optional hook the host calls when API usage is observed (e.g., from
   * a real model response). The counter can update its calibration so
   * subsequent estimates trend toward the true ratio.
   */
  observeUsage?(input: { text: string; tokens: number }): void
}

export const heuristicCounter: TokenCounter = {
  count(text) {
    return estimateTokens(text)
  },
}

export interface ApiBackedCounterOptions {
  client: CountTokensClientLike
  model: string
  /** EMA smoothing factor in (0, 1]. Higher = faster adaptation, more variance. Default 0.3. */
  emaAlpha?: number
  /** Probe every N counts when no observation has fired. 0 disables periodic probing. Default 0 (calibration is observation-driven). */
  probeEvery?: number
}

/**
 * API-backed counter. On the first call, it asynchronously calibrates a
 * scalar correction factor against the host's `countTokens` endpoint and
 * applies it to the heuristic baseline. The synchronous `count` always
 * returns immediately so this is a drop-in `TokenCounter`.
 *
 * Calibration uses an EMA so noisy measurements don't whiplash the
 * coefficient. Until at least one calibration sample arrives, this
 * counter behaves identically to `heuristicCounter`.
 */
export class ApiBackedCounter implements TokenCounter {
  private factor = 1
  private samples = 0
  private warmupPromise?: Promise<void>
  private callsSinceProbe = 0
  private readonly client: CountTokensClientLike
  private readonly model: string
  private readonly emaAlpha: number
  private readonly probeEvery: number

  constructor(options: ApiBackedCounterOptions) {
    this.client = options.client
    this.model = options.model
    this.emaAlpha = options.emaAlpha ?? 0.3
    this.probeEvery = options.probeEvery ?? 0
  }

  count(text: string): number {
    if (!text) return 0
    this.callsSinceProbe += 1
    if (!this.warmupPromise) {
      this.warmupPromise = this.warmup(text)
    } else if (this.probeEvery > 0 && this.callsSinceProbe >= this.probeEvery) {
      this.callsSinceProbe = 0
      void this.calibrate(text)
    }
    return Math.max(1, Math.round(estimateTokens(text) * this.factor))
  }

  observeUsage(input: { text: string; tokens: number }): void {
    if (!input.text || input.tokens <= 0) return
    const heuristic = estimateTokens(input.text)
    if (heuristic <= 0) return
    const ratio = input.tokens / heuristic
    this.applyEma(ratio)
  }

  /** Test/inspection helper: current EMA factor. */
  getFactor(): number {
    return this.factor
  }

  /** Test/inspection helper: total calibration samples observed so far. */
  getSampleCount(): number {
    return this.samples
  }

  /** Returns a promise that resolves once initial warmup is complete (or no-op if none queued). */
  ready(): Promise<void> {
    return this.warmupPromise ?? Promise.resolve()
  }

  private async warmup(seed: string): Promise<void> {
    await this.calibrate(seed)
  }

  private async calibrate(text: string): Promise<void> {
    try {
      const response = await this.client.messages.countTokens({
        model: this.model,
        messages: [{ role: 'user', content: text }],
      })
      const heuristic = estimateTokens(text)
      if (heuristic <= 0 || response.input_tokens <= 0) return
      this.applyEma(response.input_tokens / heuristic)
    } catch {
      // calibration is best-effort; fall through to existing factor.
    }
  }

  private applyEma(ratio: number): void {
    if (!Number.isFinite(ratio) || ratio <= 0) return
    if (this.samples === 0) {
      this.factor = ratio
    } else {
      this.factor = this.factor * (1 - this.emaAlpha) + ratio * this.emaAlpha
    }
    this.samples += 1
  }
}

export function createApiBackedCounter(options: ApiBackedCounterOptions): ApiBackedCounter {
  return new ApiBackedCounter(options)
}
