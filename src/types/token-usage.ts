/**
 * Token accounting types shared by message envelopes and run results.
 */

export interface TokenUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}
