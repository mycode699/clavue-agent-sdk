/**
 * Voice provider adapters (v3.7) — stub-fetch tests.
 *
 * Verifies request shape + response parsing + error paths for
 * DeepgramAsrProvider, WhisperOpenAiAsrProvider, ElevenLabsTtsProvider
 * without hitting real APIs.
 *
 * @module
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DeepgramAsrProvider,
  ElevenLabsTtsProvider,
  WhisperOpenAiAsrProvider,
  bufferToChunks,
  collectAudio,
  collectTranscript,
  type FetchLike,
  type FetchResponseLike,
} from '../src/index.ts'

interface RecordedCall {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: unknown
}

function jsonResponse(body: unknown): FetchResponseLike {
  return {
    ok: true,
    status: 200,
    async text() {
      return JSON.stringify(body)
    },
    async json() {
      return body
    },
  }
}

function errorResponse(status: number, message: string): FetchResponseLike {
  return {
    ok: false,
    status,
    statusText: message,
    async text() {
      return message
    },
    async json() {
      return { error: message }
    },
  }
}

// ---------------------------------------------------------------------------
// Deepgram
// ---------------------------------------------------------------------------

test('DeepgramAsrProvider POSTs to /v1/listen with model + raw audio + token auth', async () => {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    })
    return jsonResponse({
      results: {
        channels: [
          {
            alternatives: [{ transcript: 'hello world', confidence: 0.97 }],
          },
        ],
      },
    })
  }

  const provider = new DeepgramAsrProvider({
    apiKey: 'dg-test-key',
    model: 'nova-2',
    fetch: fetchImpl,
  })

  const audioBytes = new Uint8Array([1, 2, 3, 4, 5])
  const transcript = await collectTranscript(
    provider.transcribe(bufferToChunks(audioBytes, 2), { language: 'en' }),
  )

  assert.equal(transcript, 'hello world')
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.ok(call.url.startsWith('https://api.deepgram.com/v1/listen?'))
  assert.match(call.url, /model=nova-2/)
  assert.match(call.url, /language=en/)
  assert.equal(call.method, 'POST')
  assert.equal(call.headers?.Authorization, 'Token dg-test-key')
  assert.equal(call.headers?.['Content-Type'], 'audio/wav')
  assert.ok(call.body instanceof Uint8Array)
  assert.equal((call.body as Uint8Array).byteLength, 5)
})

test('DeepgramAsrProvider passes options.extra as query params', async () => {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push({ url })
    return jsonResponse({
      results: { channels: [{ alternatives: [{ transcript: 'x' }] }] },
    })
  }
  const provider = new DeepgramAsrProvider({ apiKey: 'k', fetch: fetchImpl })
  await collectTranscript(
    provider.transcribe(bufferToChunks(new Uint8Array([0]), 1), {
      extra: { punctuate: true, diarize: false },
    }),
  )
  assert.match(calls[0]!.url, /punctuate=true/)
  assert.match(calls[0]!.url, /diarize=false/)
})

test('DeepgramAsrProvider throws on non-ok response', async () => {
  const fetchImpl: FetchLike = async () => errorResponse(401, 'Unauthorized')
  const provider = new DeepgramAsrProvider({ apiKey: 'bad', fetch: fetchImpl })
  await assert.rejects(
    () =>
      collectTranscript(provider.transcribe(bufferToChunks(new Uint8Array([1]), 1))),
    /Deepgram transcribe failed: 401/,
  )
})

test('DeepgramAsrProvider constructor requires apiKey', () => {
  assert.throws(
    () => new DeepgramAsrProvider({ apiKey: '' }),
    /apiKey required/,
  )
})

// ---------------------------------------------------------------------------
// Whisper (OpenAI)
// ---------------------------------------------------------------------------

test('WhisperOpenAiAsrProvider POSTs multipart form with Bearer auth', async () => {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    })
    return jsonResponse({ text: 'transcribed text' })
  }
  const provider = new WhisperOpenAiAsrProvider({
    apiKey: 'sk-test',
    fetch: fetchImpl,
  })
  const out = await collectTranscript(
    provider.transcribe(bufferToChunks(new Uint8Array([1, 2, 3]), 2)),
  )
  assert.equal(out, 'transcribed text')
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.equal(call.url, 'https://api.openai.com/v1/audio/transcriptions')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers?.Authorization, 'Bearer sk-test')
  // Body should be a FormData instance (global in Node ≥ 18).
  assert.ok(call.body instanceof FormData)
  const form = call.body as FormData
  assert.equal(form.get('model'), 'whisper-1')
  const file = form.get('file')
  assert.ok(file instanceof Blob)
})

test('WhisperOpenAiAsrProvider forwards language + extra fields', async () => {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push({ url: _url, ...(init?.body !== undefined ? { body: init.body } : {}) })
    return jsonResponse({ text: 'ok' })
  }
  const provider = new WhisperOpenAiAsrProvider({ apiKey: 'k', fetch: fetchImpl })
  await collectTranscript(
    provider.transcribe(bufferToChunks(new Uint8Array([1]), 1), {
      language: 'zh',
      extra: { temperature: 0.2, prompt: 'clavue' },
    }),
  )
  const form = calls[0]!.body as FormData
  assert.equal(form.get('language'), 'zh')
  assert.equal(form.get('temperature'), '0.2')
  assert.equal(form.get('prompt'), 'clavue')
})

test('WhisperOpenAiAsrProvider throws on non-ok response', async () => {
  const fetchImpl: FetchLike = async () => errorResponse(500, 'server error')
  const provider = new WhisperOpenAiAsrProvider({ apiKey: 'k', fetch: fetchImpl })
  await assert.rejects(
    () =>
      collectTranscript(provider.transcribe(bufferToChunks(new Uint8Array([1]), 1))),
    /Whisper transcribe failed: 500/,
  )
})

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

test('ElevenLabsTtsProvider POSTs to voice stream URL with xi-api-key', async () => {
  const calls: RecordedCall[] = []
  const audioBody = new Uint8Array([9, 8, 7, 6])
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      ...(init?.method !== undefined ? { method: init.method } : {}),
      ...(init?.headers !== undefined ? { headers: init.headers } : {}),
      ...(init?.body !== undefined ? { body: init.body } : {}),
    })
    return {
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      async json() {
        return {}
      },
      async arrayBuffer() {
        return audioBody.buffer.slice(
          audioBody.byteOffset,
          audioBody.byteOffset + audioBody.byteLength,
        ) as ArrayBuffer
      },
      body: null,
    }
  }
  const provider = new ElevenLabsTtsProvider({
    apiKey: 'el-key',
    voiceId: 'voice-xyz',
    modelId: 'eleven_turbo_v2_5',
    fetch: fetchImpl,
  })
  const audio = await collectAudio(provider.synthesize('Hello, world.'))
  assert.equal(audio.byteLength, 4)
  assert.equal(calls.length, 1)
  const call = calls[0]!
  assert.match(call.url, /\/v1\/text-to-speech\/voice-xyz\/stream\?/)
  assert.match(call.url, /output_format=mp3_44100_128/)
  assert.equal(call.method, 'POST')
  assert.equal(call.headers?.['xi-api-key'], 'el-key')
  assert.equal(call.headers?.['Content-Type'], 'application/json')
  assert.equal(call.headers?.Accept, 'audio/mpeg')
  const body = JSON.parse(call.body as string)
  assert.equal(body.text, 'Hello, world.')
  assert.equal(body.model_id, 'eleven_turbo_v2_5')
})

test('ElevenLabsTtsProvider streams chunks when response body exposes a reader', async () => {
  const parts = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]
  let idx = 0
  const fetchImpl: FetchLike = async () => ({
    ok: true,
    status: 200,
    async text() {
      return ''
    },
    async json() {
      return {}
    },
    body: {
      getReader() {
        return {
          async read() {
            if (idx < parts.length) {
              return { done: false, value: parts[idx++]! }
            }
            return { done: true }
          },
        }
      },
    },
  })
  const provider = new ElevenLabsTtsProvider({ apiKey: 'k', fetch: fetchImpl })
  const chunks: Uint8Array[] = []
  let finalSeen = false
  for await (const c of provider.synthesize('hi')) {
    chunks.push(c.audio)
    if (c.final) finalSeen = true
  }
  assert.equal(finalSeen, true)
  // 2 data chunks + 1 terminal (empty + final)
  assert.equal(chunks.length, 3)
  assert.deepEqual(Array.from(chunks[0]!), [1, 2])
  assert.deepEqual(Array.from(chunks[1]!), [3, 4, 5])
  assert.equal(chunks[2]!.byteLength, 0)
})

test('ElevenLabsTtsProvider accepts URL-encoded voiceId', async () => {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (url) => {
    calls.push({ url })
    return {
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      async json() {
        return {}
      },
      async arrayBuffer() {
        return new ArrayBuffer(0)
      },
      body: null,
    }
  }
  const provider = new ElevenLabsTtsProvider({
    apiKey: 'k',
    voiceId: 'needs/encoding',
    fetch: fetchImpl,
  })
  await collectAudio(provider.synthesize('x'))
  assert.match(calls[0]!.url, /\/v1\/text-to-speech\/needs%2Fencoding\/stream/)
})

test('ElevenLabsTtsProvider accepts AsyncIterable<string> text input', async () => {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (_url, init) => {
    calls.push({ url: _url, ...(init?.body !== undefined ? { body: init.body } : {}) })
    return {
      ok: true,
      status: 200,
      async text() {
        return ''
      },
      async json() {
        return {}
      },
      async arrayBuffer() {
        return new ArrayBuffer(0)
      },
      body: null,
    }
  }
  const provider = new ElevenLabsTtsProvider({ apiKey: 'k', fetch: fetchImpl })
  async function* chunks() {
    yield 'foo '
    yield 'bar'
  }
  await collectAudio(provider.synthesize(chunks()))
  const body = JSON.parse(calls[0]!.body as string)
  assert.equal(body.text, 'foo bar')
})

test('ElevenLabsTtsProvider throws on non-ok response', async () => {
  const fetchImpl: FetchLike = async () => errorResponse(429, 'rate limit')
  const provider = new ElevenLabsTtsProvider({ apiKey: 'k', fetch: fetchImpl })
  await assert.rejects(
    () => collectAudio(provider.synthesize('hi')),
    /ElevenLabs synthesize failed: 429/,
  )
})
