export function abortError(): Error {
  const err = new Error('Aborted')
  err.name = 'AbortError'
  return err
}

export function combineAbortSignals(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const activeSignals = signals.filter((signal): signal is AbortSignal => Boolean(signal))
  if (activeSignals.length === 0) return undefined
  if (activeSignals.length === 1) return activeSignals[0]

  const controller = new AbortController()
  const abort = () => {
    if (!controller.signal.aborted) controller.abort()
  }

  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort()
      break
    }
    signal.addEventListener('abort', abort, { once: true })
  }

  return controller.signal
}

export function timeoutSignal(ms: number, parentSignal?: AbortSignal): AbortSignal {
  return combineAbortSignals(AbortSignal.timeout(ms), parentSignal) || AbortSignal.timeout(ms)
}
