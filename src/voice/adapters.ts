/**
 * v3.7 Voice — real provider adapters (Deepgram ASR, Whisper-via-OpenAI ASR,
 * ElevenLabs TTS).
 *
 * Each adapter implements the same `AsrProvider` / `TtsProvider` interface
 * the stubs use, so apps swap providers with one line. The SDK doesn't
 * depend on `axios` / `node-fetch`; adapters use a `FetchLike` shape that
 * defaults to global `fetch` (Node ≥ 18). Tests inject a stub fetch so the
 * full request/response shape is verifiable offline.
 *
 * What this is NOT:
 *   - websocket / streaming-realtime sockets (Deepgram Live, OpenAI
 *     Realtime). Those need a websocket layer; they ride on top of these
 *     interfaces, but live in a follow-up adapter.
 *   - a local Whisper binary runner. That is OS-specific (`whisper.cpp`,
 *     `faster-whisper`). Hosts that want it implement `AsrProvider` against
 *     their binary directly.
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

// ---------------------------------------------------------------------------
// Shared HTTP plumbing
// ---------------------------------------------------------------------------

/**
 * Structural subset of the Fetch API's `Response` we touch. Real `Response`
 * objects already match this shape; tests can mint a plain object.
 */
export interface FetchResponseLike {
  readonly ok: boolean
  readonly status: number
  readonly statusText?: string
  text(): Promise<string>
  json(): Promise<unknown>
  arrayBuffer?(): Promise<ArrayBuffer>
  /** Optional ReadableStream-of-bytes (web-streams). When absent we fall back to arrayBuffer(). */
  readonly body?: {
    getReader(): {
      read(): Promise<{ done: boolean; value?: Uint8Array }>
    }
  } | null
}

/** Minimal fetch shape: the parts every adapter touches. */
export type FetchLike = (
  url: string,
  init?: {
    method?: string
    headers?: Record<string, string>
    body?: unknown
  },
) => Promise<FetchResponseLike>

/** Fall back to global `fetch` if available, otherwise throw at call site. */
function defaultFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error(
      'voice adapter: global fetch is unavailable — pass options.fetch (Node < 18 or sandboxed env)',
    )
  }
  // The real global fetch already matches FetchLike structurally.
  return globalThis.fetch.bind(globalThis) as unknown as FetchLike
}

async function readAllAudio(audio: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const buffers: Uint8Array[] = []
  let total = 0
  for await (const chunk of audio) {
    buffers.push(chunk)
    total += chunk.byteLength
  }
  const flat = new Uint8Array(total)
  let off = 0
  for (const b of buffers) {
    flat.set(b, off)
    off += b.byteLength
  }
  return flat
}

// ---------------------------------------------------------------------------
// Deepgram ASR
// ---------------------------------------------------------------------------

export interface DeepgramAsrProviderOptions {
  apiKey: string
  /** Defaults to `'nova-2'`. */
  model?: string
  /** Audio MIME, e.g. `'audio/wav'`, `'audio/mpeg'`, `'audio/flac'`. */
  contentType?: string
  /** Override base URL. Defaults to public Deepgram. */
  baseUrl?: string
  /** Inject a fetch impl (tests). Falls back to global `fetch`. */
  fetch?: FetchLike
}

interface DeepgramTranscriptionResponse {
  results?: {
    channels?: Array<{
      alternatives?: Array<{ transcript?: string; confidence?: number }>
    }>
  }
}

/**
 * Deepgram batch transcription via REST. Streaming/live transcription rides
 * on Deepgram Live (websocket) — tracked separately.
 */
export class DeepgramAsrProvider implements AsrProvider {
  readonly name = 'deepgram'
  private apiKey: string
  private model: string
  private contentType: string
  private baseUrl: string
  private fetchImpl: FetchLike

  constructor(options: DeepgramAsrProviderOptions) {
    if (!options?.apiKey) throw new Error('DeepgramAsrProvider: apiKey required')
    this.apiKey = options.apiKey
    this.model = options.model ?? 'nova-2'
    this.contentType = options.contentType ?? 'audio/wav'
    this.baseUrl = options.baseUrl ?? 'https://api.deepgram.com'
    this.fetchImpl = options.fetch ?? defaultFetch()
  }

  async *transcribe(
    audio: AsyncIterable<Uint8Array>,
    options: AsrOptions = {},
  ): AsyncIterable<AsrChunk> {
    const flat = await readAllAudio(audio)
    const url = new URL('/v1/listen', this.baseUrl)
    url.searchParams.set('model', this.model)
    if (options.language) url.searchParams.set('language', options.language)
    if (options.extra) {
      for (const [k, v] of Object.entries(options.extra)) {
        if (v !== undefined && v !== null) url.searchParams.set(k, String(v))
      }
    }

    const res = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        Authorization: `Token ${this.apiKey}`,
        'Content-Type': this.contentType,
      },
      body: flat,
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Deepgram transcribe failed: ${res.status} ${detail}`.trim())
    }

    const json = (await res.json()) as DeepgramTranscriptionResponse
    const alt = json.results?.channels?.[0]?.alternatives?.[0]
    yield {
      text: alt?.transcript ?? '',
      final: true,
      ...(typeof alt?.confidence === 'number' ? { confidence: alt.confidence } : {}),
    }
  }
}

// ---------------------------------------------------------------------------
// Whisper-via-OpenAI ASR
// ---------------------------------------------------------------------------

export interface WhisperOpenAiAsrProviderOptions {
  apiKey: string
  /** Defaults to `'whisper-1'`. */
  model?: string
  /** Filename / mime hint sent to the API. Default `audio.wav` / `audio/wav`. */
  filename?: string
  contentType?: string
  /** Override base URL. */
  baseUrl?: string
  fetch?: FetchLike
}

interface WhisperTranscriptionResponse {
  text?: string
  language?: string
  duration?: number
}

/**
 * OpenAI Whisper transcription endpoint. The SDK does not require the
 * `openai` npm package — we POST multipart/form-data directly so the
 * dependency footprint stays at zero.
 */
export class WhisperOpenAiAsrProvider implements AsrProvider {
  readonly name = 'whisper-openai'
  private apiKey: string
  private model: string
  private filename: string
  private contentType: string
  private baseUrl: string
  private fetchImpl: FetchLike

  constructor(options: WhisperOpenAiAsrProviderOptions) {
    if (!options?.apiKey) throw new Error('WhisperOpenAiAsrProvider: apiKey required')
    this.apiKey = options.apiKey
    this.model = options.model ?? 'whisper-1'
    this.filename = options.filename ?? 'audio.wav'
    this.contentType = options.contentType ?? 'audio/wav'
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com'
    this.fetchImpl = options.fetch ?? defaultFetch()
  }

  async *transcribe(
    audio: AsyncIterable<Uint8Array>,
    options: AsrOptions = {},
  ): AsyncIterable<AsrChunk> {
    const flat = await readAllAudio(audio)
    if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
      throw new Error(
        'WhisperOpenAiAsrProvider: requires global FormData + Blob (Node ≥ 18)',
      )
    }
    const form = new FormData()
    form.append('model', this.model)
    if (options.language) form.append('language', options.language)
    if (options.extra) {
      for (const [k, v] of Object.entries(options.extra)) {
        if (v !== undefined && v !== null) form.append(k, String(v))
      }
    }
    // The Blob ctor accepts a BufferSource; structural-typing-wise this is
    // satisfied by Uint8Array. `as unknown as BlobPart` keeps the type
    // checker happy on lib targets that don't ship the BufferSource union.
    const blob = new Blob([flat as unknown as BlobPart], { type: this.contentType })
    form.append('file', blob, this.filename)

    const res = await this.fetchImpl(`${this.baseUrl}/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.apiKey}` },
      body: form,
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`Whisper transcribe failed: ${res.status} ${detail}`.trim())
    }
    const json = (await res.json()) as WhisperTranscriptionResponse
    yield { text: json.text ?? '', final: true }
  }
}

// ---------------------------------------------------------------------------
// ElevenLabs TTS
// ---------------------------------------------------------------------------

export interface ElevenLabsTtsProviderOptions {
  apiKey: string
  /** Voice id (ElevenLabs catalog). Default `'21m00Tcm4TlvDq8ikWAM'` (Rachel). */
  voiceId?: string
  /** Output format the API streams back. Defaults to `mp3_44100_128`. */
  outputFormat?: string
  /** Optional model id, e.g. `eleven_turbo_v2_5`. */
  modelId?: string
  baseUrl?: string
  fetch?: FetchLike
}

interface ElevenLabsRequestBody {
  text: string
  model_id?: string
}

/**
 * ElevenLabs streaming TTS via REST. Yields `TtsChunk`s as audio bytes
 * stream off the wire. When the host's fetch impl exposes a ReadableStream
 * body we consume incrementally; otherwise we fall back to one big chunk.
 */
export class ElevenLabsTtsProvider implements TtsProvider {
  readonly name = 'elevenlabs'
  private apiKey: string
  private voiceId: string
  private outputFormat: string
  private modelId: string | undefined
  private baseUrl: string
  private fetchImpl: FetchLike

  constructor(options: ElevenLabsTtsProviderOptions) {
    if (!options?.apiKey) throw new Error('ElevenLabsTtsProvider: apiKey required')
    this.apiKey = options.apiKey
    this.voiceId = options.voiceId ?? '21m00Tcm4TlvDq8ikWAM'
    this.outputFormat = options.outputFormat ?? 'mp3_44100_128'
    this.modelId = options.modelId
    this.baseUrl = options.baseUrl ?? 'https://api.elevenlabs.io'
    this.fetchImpl = options.fetch ?? defaultFetch()
  }

  async *synthesize(
    text: string | AsyncIterable<string>,
    options: TtsOptions = {},
  ): AsyncIterable<TtsChunk> {
    const fullText = typeof text === 'string' ? text : await collectStringStream(text)

    const url = new URL(
      `/v1/text-to-speech/${encodeURIComponent(this.voiceId)}/stream`,
      this.baseUrl,
    )
    url.searchParams.set('output_format', options.format ?? this.outputFormat)

    const body: ElevenLabsRequestBody = { text: fullText }
    if (this.modelId) body.model_id = this.modelId

    const res = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw new Error(`ElevenLabs synthesize failed: ${res.status} ${detail}`.trim())
    }

    const reader = res.body?.getReader?.()
    if (reader) {
      // Streaming path — yield chunks as they land.
      while (true) {
        const { done, value } = await reader.read()
        if (done) {
          yield { audio: new Uint8Array(0), final: true }
          break
        }
        if (value && value.byteLength > 0) {
          yield { audio: value, final: false }
        }
      }
      return
    }

    // Non-streaming fallback: read whole body once.
    const bytes = res.arrayBuffer
      ? new Uint8Array(await res.arrayBuffer())
      : new TextEncoder().encode(await res.text())
    yield { audio: bytes, final: true, durationMs: bytes.byteLength }
  }
}

async function collectStringStream(stream: AsyncIterable<string>): Promise<string> {
  let buf = ''
  for await (const s of stream) buf += s
  return buf
}
