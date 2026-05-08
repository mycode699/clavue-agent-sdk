/**
 * v3.7 Voice (prototype) — public surface.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.7 section).
 * @module
 */

export type {
  AsrChunk,
  AsrOptions,
  AsrProvider,
  TtsChunk,
  TtsOptions,
  TtsProvider,
} from './types.js'

export {
  StubAsrProvider,
  StubTtsProvider,
  bufferToChunks,
  collectAudio,
  collectTranscript,
  type StubAsrProviderOptions,
  type StubTtsProviderOptions,
} from './runtime.js'

export {
  DeepgramAsrProvider,
  ElevenLabsTtsProvider,
  WhisperOpenAiAsrProvider,
  type DeepgramAsrProviderOptions,
  type ElevenLabsTtsProviderOptions,
  type FetchLike,
  type FetchResponseLike,
  type WhisperOpenAiAsrProviderOptions,
} from './adapters.js'
