/**
 * v3.7 Voice — runtime helpers (prototype).
 *
 * Reference providers (`StubAsrProvider`, `StubTtsProvider`) demonstrate
 * the interface and let tests/examples run offline. Real providers (OpenAI
 * Realtime, Deepgram, Whisper-local, Azure, ElevenLabs) implement the same
 * `AsrProvider` / `TtsProvider` interfaces, swapped in by the host.
 *
 * Helper utilities:
 *   - `collectTranscript()`: drain an `AsrChunk` stream into one final string.
 *   - `collectAudio()`: drain a `TtsChunk` stream into a single Uint8Array.
 *   - `bufferToChunks()`: split a Uint8Array into N async-yielded chunks for
 *     feeding ASR pipelines.
 *
 * @module
 */

import type {
  AsrChunk,
  AsrOptions,
  AsrProvider,
  TtsChunk,
  TtsOptions,
  TtsProvider,
} from './types.js'

export interface StubAsrProviderOptions {
  /**
   * Synthetic transcript the stub should return. If omitted, the stub
   * returns "<bytes:N>" where N is the total received audio byte count.
   */
  transcript?: string
  /** Number of partial chunks to emit before the final. Default 0. */
  partials?: number
}

export class StubAsrProvider implements AsrProvider {
  readonly name = 'stub'
  private transcript: string | undefined
  private partials: number

  constructor(options: StubAsrProviderOptions = {}) {
    this.transcript = options.transcript
    this.partials = options.partials ?? 0
  }

  async *transcribe(
    audio: AsyncIterable<Uint8Array>,
    _options: AsrOptions = {},
  ): AsyncIterable<AsrChunk> {
    let total = 0
    for await (const chunk of audio) {
      total += chunk.byteLength
    }
    const finalText = this.transcript ?? `<bytes:${total}>`

    if (this.partials > 0) {
      for (let i = 1; i <= this.partials; i += 1) {
        const cut = Math.max(1, Math.floor((finalText.length * i) / (this.partials + 1)))
        yield {
          text: finalText.slice(0, cut),
          final: false,
          confidence: 0.5 + i * 0.1,
        }
      }
    }
    yield { text: finalText, final: true, confidence: 0.95 }
  }
}

export interface StubTtsProviderOptions {
  /** Bytes per chunk emitted (default 16). */
  chunkSize?: number
  /** Encoding strategy; only 'utf8' supported in stub. */
  encoding?: 'utf8'
}

export class StubTtsProvider implements TtsProvider {
  readonly name = 'stub'
  private chunkSize: number

  constructor(options: StubTtsProviderOptions = {}) {
    this.chunkSize = options.chunkSize ?? 16
    if (this.chunkSize <= 0) throw new Error('StubTtsProvider: chunkSize must be > 0')
  }

  async *synthesize(
    text: string | AsyncIterable<string>,
    _options: TtsOptions = {},
  ): AsyncIterable<TtsChunk> {
    const enc = new TextEncoder()
    const buffers: Uint8Array[] = []
    if (typeof text === 'string') {
      buffers.push(enc.encode(text))
    } else {
      for await (const chunk of text) {
        buffers.push(enc.encode(chunk))
      }
    }
    const total = buffers.reduce((acc, b) => acc + b.byteLength, 0)
    const flat = new Uint8Array(total)
    let off = 0
    for (const b of buffers) {
      flat.set(b, off)
      off += b.byteLength
    }

    if (flat.byteLength === 0) {
      yield { audio: new Uint8Array(0), final: true, durationMs: 0 }
      return
    }
    let pos = 0
    while (pos < flat.byteLength) {
      const end = Math.min(pos + this.chunkSize, flat.byteLength)
      const slice = flat.slice(pos, end)
      const isFinal = end === flat.byteLength
      yield { audio: slice, final: isFinal, durationMs: slice.byteLength }
      pos = end
    }
  }
}

/**
 * Drain an ASR stream into a single transcript string.
 *
 * Semantics:
 *   - `delta=true`  → `text` is the new portion; append to the running buffer.
 *   - `delta=false` → `text` is the full cumulative transcript; replace.
 *   - `final` is informational; the loop exits naturally when the stream ends.
 */
export async function collectTranscript(stream: AsyncIterable<AsrChunk>): Promise<string> {
  let buf = ''
  for await (const c of stream) {
    if (c.delta) buf += c.text
    else buf = c.text
  }
  return buf
}

/** Drain a TTS stream and concatenate all audio chunks. */
export async function collectAudio(stream: AsyncIterable<TtsChunk>): Promise<Uint8Array> {
  const buffers: Uint8Array[] = []
  let total = 0
  for await (const c of stream) {
    buffers.push(c.audio)
    total += c.audio.byteLength
  }
  const out = new Uint8Array(total)
  let off = 0
  for (const b of buffers) {
    out.set(b, off)
    off += b.byteLength
  }
  return out
}

/** Split a Uint8Array into chunks of `chunkSize` bytes, yielded asynchronously. */
export async function* bufferToChunks(
  buffer: Uint8Array,
  chunkSize: number,
): AsyncIterable<Uint8Array> {
  if (chunkSize <= 0) throw new Error('bufferToChunks: chunkSize must be > 0')
  if (buffer.byteLength === 0) return
  let pos = 0
  while (pos < buffer.byteLength) {
    const end = Math.min(pos + chunkSize, buffer.byteLength)
    yield buffer.slice(pos, end)
    pos = end
  }
}
