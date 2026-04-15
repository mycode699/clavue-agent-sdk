import type { RetroEvaluator } from './types.js'

function createDimensionEvaluator(): RetroEvaluator {
  return async () => ({ findings: [] })
}

export function createDefaultRetroEvaluators(): RetroEvaluator[] {
  return [
    createDimensionEvaluator(),
    createDimensionEvaluator(),
    createDimensionEvaluator(),
    createDimensionEvaluator(),
  ]
}
