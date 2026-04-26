/**
 * Retry Logic with Exponential Backoff
 *
 * Handles API retries for rate limits, overloaded servers,
 * and transient failures.
 */

/**
 * Retry configuration.
 */
export interface RetryConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  retryableStatusCodes: number[]
}

export interface RetryDelayOptions {
  retryAfterMs?: number
}

/**
 * Default retry configuration.
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 2000,
  maxDelayMs: 30000,
  retryableStatusCodes: [429, 500, 502, 503, 529],
}

/**
 * Check if an error is retryable.
 */
export function isRetryableError(err: any, config: RetryConfig = DEFAULT_RETRY_CONFIG): boolean {
  if (err?.name === 'AbortError') {
    return false
  }

  if (err?.status && config.retryableStatusCodes.includes(err.status)) {
    return true
  }

  const networkCodes = new Set([
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ECONNABORTED',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
  ])
  const code = err?.code || err?.cause?.code
  if (networkCodes.has(code)) {
    return true
  }

  if (err instanceof TypeError && /fetch|network|socket/i.test(err.message)) {
    return true
  }

  // API overloaded
  if (err?.error?.type === 'overloaded_error') {
    return true
  }

  return false
}

/**
 * Calculate delay for exponential backoff.
 */
export function getRetryDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  options: RetryDelayOptions = {},
): number {
  if (options.retryAfterMs !== undefined) {
    return Math.min(Math.max(options.retryAfterMs, 0), config.maxDelayMs)
  }

  const delay = config.baseDelayMs * Math.pow(2, attempt)
  // Add jitter (±25%)
  const jitter = delay * 0.25 * (Math.random() * 2 - 1)
  return Math.min(delay + jitter, config.maxDelayMs)
}

function readRetryAfterMs(err: any): number | undefined {
  const retryAfter =
    err?.headers?.['retry-after'] ??
    err?.headers?.['Retry-After'] ??
    (typeof err?.headers?.get === 'function' ? err.headers.get('retry-after') : undefined)
  if (!retryAfter) return undefined

  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds)) {
    return seconds * 1000
  }

  const retryAt = Date.parse(String(retryAfter))
  if (Number.isFinite(retryAt)) {
    return Math.max(0, retryAt - Date.now())
  }

  return undefined
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (!abortSignal) {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  if (abortSignal.aborted) {
    return Promise.reject(new Error('Aborted'))
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      abortSignal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(new Error('Aborted'))
    }
    abortSignal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Execute a function with retries.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
  abortSignal?: AbortSignal,
): Promise<T> {
  let lastError: any

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    if (abortSignal?.aborted) {
      throw new Error('Aborted')
    }

    try {
      return await fn()
    } catch (err: any) {
      lastError = err

      if (!isRetryableError(err, config)) {
        throw err
      }

      if (attempt === config.maxRetries) {
        throw err
      }

      // Wait before retry
      const delay = getRetryDelay(attempt, config, { retryAfterMs: readRetryAfterMs(err) })
      await sleep(delay, abortSignal)
    }
  }

  throw lastError
}

/**
 * Check if an error is a "prompt too long" error.
 */
export function isPromptTooLongError(err: any): boolean {
  if (err?.status === 400) {
    const message = err?.error?.error?.message || err?.message || ''
    return message.includes('prompt is too long') ||
      message.includes('max_tokens') ||
      message.includes('context length')
  }
  return false
}

/**
 * Check if error is an auth error.
 */
export function isAuthError(err: any): boolean {
  return err?.status === 401 || err?.status === 403
}

/**
 * Check if error is a rate limit error.
 */
export function isRateLimitError(err: any): boolean {
  return err?.status === 429
}

/**
 * Format an API error for display.
 */
export function formatApiError(err: any): string {
  if (isAuthError(err)) {
    return 'Authentication failed. Check your CLAVUE_AGENT_API_KEY.'
  }
  if (isRateLimitError(err)) {
    return 'Rate limit exceeded. Please retry after a short wait.'
  }
  if (err?.status === 529) {
    return 'API overloaded. Please retry later.'
  }
  if (isPromptTooLongError(err)) {
    return 'Prompt too long. Auto-compacting conversation...'
  }
  return `API error: ${err.message || err}`
}
