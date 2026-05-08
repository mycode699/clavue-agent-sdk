/**
 * Example 30: Real voice provider adapters (Deepgram / Whisper / ElevenLabs)
 *
 * Demonstrates the *real* adapters with a stub `fetch` so the example is
 * fully offline. Production hosts pass `globalThis.fetch` (default) or
 * inject their own HTTP client (axios, undici, fetch-with-retries) — same
 * `FetchLike` shape, no code changes in the SDK.
 *
 * Each block is what you would actually write against the live API; only
 * the `fetch:` injection differs from production usage.
 *
 * Run:
 *
 *   npx tsx examples/30-voice-adapters.ts
 *
 * @module
 */

import {
  DeepgramAsrProvider,
  ElevenLabsTtsProvider,
  WhisperOpenAiAsrProvider,
  bufferToChunks,
  collectAudio,
  collectTranscript,
  type FetchLike,
  type FetchResponseLike,
} from '../src/index.js'

// ---------------------------------------------------------------------------
// Stub fetch builders (offline)
// ---------------------------------------------------------------------------

function jsonRes(body: unknown): FetchResponseLike {
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

function bytesRes(bytes: Uint8Array): FetchResponseLike {
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
      return bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer
    },
    body: null,
  }
}

async function main() {
  console.log('--- Example 30: Real voice provider adapters (offline) ---\n')

  // ---------------------------------------------------------------------
  // 1. Deepgram ASR
  // ---------------------------------------------------------------------
  const deepgramFetch: FetchLike = async (url) => {
    console.log(`  [deepgram] POST ${url.split('?')[0]}`)
    return jsonRes({
      results: {
        channels: [
          {
            alternatives: [
              { transcript: 'voice adapters are real now', confidence: 0.94 },
            ],
          },
        ],
      },
    })
  }
  const deepgram = new DeepgramAsrProvider({
    apiKey: 'demo',
    fetch: deepgramFetch,
  })
  const dgOut = await collectTranscript(
    deepgram.transcribe(bufferToChunks(new Uint8Array(64), 16), {
      language: 'en',
    }),
  )
  console.log(`  → "${dgOut}"\n`)

  // ---------------------------------------------------------------------
  // 2. Whisper via OpenAI
  // ---------------------------------------------------------------------
  const whisperFetch: FetchLike = async (url) => {
    console.log(`  [whisper] POST ${url}`)
    return jsonRes({ text: 'hello from whisper-1' })
  }
  const whisper = new WhisperOpenAiAsrProvider({
    apiKey: 'demo',
    fetch: whisperFetch,
  })
  const wOut = await collectTranscript(
    whisper.transcribe(bufferToChunks(new Uint8Array(64), 16)),
  )
  console.log(`  → "${wOut}"\n`)

  // ---------------------------------------------------------------------
  // 3. ElevenLabs TTS (arrayBuffer fallback path)
  // ---------------------------------------------------------------------
  const ttsBytes = new Uint8Array([0x49, 0x44, 0x33, 0x04, 0x00]) // fake mp3 header
  const elFetch: FetchLike = async (url) => {
    console.log(`  [elevenlabs] POST ${url.split('?')[0]}`)
    return bytesRes(ttsBytes)
  }
  const eleven = new ElevenLabsTtsProvider({
    apiKey: 'demo',
    voiceId: '21m00Tcm4TlvDq8ikWAM',
    fetch: elFetch,
  })
  const elOut = await collectAudio(eleven.synthesize('Hello, world.'))
  console.log(`  → ${elOut.byteLength}B audio\n`)

  console.log('— done —')
  console.log(
    'In production: drop the `fetch:` option and the same code calls the live APIs.',
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
