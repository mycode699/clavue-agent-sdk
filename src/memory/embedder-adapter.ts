/**
 * Embedder adapter — structural-typing interface for memory vector retrieval.
 *
 * Hosts inject any embedding provider (OpenAI, Cohere, local model) by
 * supplying an object that matches `EmbedderLike`. Zero new runtime deps
 * inside this SDK; the embedder is resolved lazily and only when the host
 * opts into `MemoryConfig.retrieval = 'vector' | 'hybrid'`.
 */

export interface EmbedderLike {
  /**
   * Embed a piece of text into a fixed-length vector.
   *
   * Implementations should normalize on a stable model + dimension across
   * the lifetime of a memory store; rotating models invalidates cached
   * vectors. Returned vectors do NOT need to be unit-length — `cosine()`
   * normalises both operands.
   */
  embed(text: string): Promise<number[]>
}

/**
 * Cosine similarity between two equal-length vectors.
 *
 * Returns 0 if either vector is zero-length / mismatched dimensions / has
 * zero norm. Defensive against NaN to keep ranking deterministic.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a || !b) return 0
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  if (na === 0 || nb === 0) return 0
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  if (denom === 0 || !Number.isFinite(denom)) return 0
  const sim = dot / denom
  if (!Number.isFinite(sim)) return 0
  // Clamp to [-1, 1] to absorb floating-point drift.
  return Math.max(-1, Math.min(1, sim))
}
