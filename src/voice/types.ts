/**
 * v3.7 Voice — provider-agnostic ASR / TTS types (prototype).
 *
 * Peer (openai-agents) ships a realtime stack tied to OpenAI's Realtime
 * API. We define interfaces any provider (OpenAI, Deepgram, Whisper local,
 * Azure, ElevenLabs, Coqui…) can implement so apps are not locked in.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.7 section).
 *
 * @module
 */

/** Streaming ASR (speech → text) chunk. */
export interface AsrChunk {
  /** Cumulative text up to this point, or the chunk delta if `delta`=true. */
  text: string
  /** True when this chunk is a delta and `text` is only the new portion. */
  delta?: boolean
  /** True only on the final chunk of an utterance. */
  final: boolean
  /** Optional confidence in [0,1]; provider-dependent. */
  confidence?: number
  /** Optional start/end ms relative to utterance start. */
  startMs?: number
  endMs?: number
}

/** Streaming TTS (text → audio) chunk. */
export interface TtsChunk {
  /** Raw audio bytes for this chunk. Format declared by the provider. */
  audio: Uint8Array
  /** True only on the final chunk of an utterance. */
  final: boolean
  /** Optional duration of this chunk, in ms. */
  durationMs?: number
}

export interface AsrOptions {
  /** Language hint, e.g. 'en', 'zh', 'auto'. */
  language?: string
  /** If true, the provider may emit interim partial results before final. */
  interim?: boolean
  /** Free-form provider-specific options. Stored as-is. */
  extra?: Record<string, unknown>
}

export interface TtsOptions {
  /** Voice id; provider-specific. */
  voice?: string
  /** Output format hint, e.g. 'pcm16', 'mp3', 'opus'. */
  format?: string
  /** Sample rate in Hz when `format` requests PCM. */
  sampleRate?: number
  /** Free-form provider-specific options. */
  extra?: Record<string, unknown>
}

/**
 * The interface every ASR provider implements. `transcribe` consumes a
 * stream of audio chunks (Uint8Array) and yields `AsrChunk`s.
 */
export interface AsrProvider {
  readonly name: string
  transcribe(
    audio: AsyncIterable<Uint8Array>,
    options?: AsrOptions,
  ): AsyncIterable<AsrChunk>
}

/**
 * The interface every TTS provider implements. `synthesize` consumes text
 * (or text chunks for streaming TTS) and yields `TtsChunk`s.
 */
export interface TtsProvider {
  readonly name: string
  synthesize(
    text: string | AsyncIterable<string>,
    options?: TtsOptions,
  ): AsyncIterable<TtsChunk>
}
