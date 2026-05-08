/**
 * Example 25: Voice provider-agnostic ASR / TTS (v3.7 prototype)
 *
 * Define one `AsrProvider` + one `TtsProvider` interface; the SDK ships
 * stubs that work offline. Real providers (OpenAI Realtime, Deepgram,
 * Whisper-local, Azure, ElevenLabs) implement the same interfaces and
 * swap in transparently.
 *
 * Three demos:
 *   1. TTS: synthesize text → audio chunks
 *   2. ASR: feed audio chunks → final transcript
 *   3. Round-trip: TTS output piped into ASR input
 *
 * Run:
 *
 *   npx tsx examples/25-voice.ts
 *
 * @module
 */

import {
  StubAsrProvider,
  StubTtsProvider,
  bufferToChunks,
  collectAudio,
  collectTranscript,
} from '../src/index.js'

async function main() {
  console.log('--- Example 25: Voice provider-agnostic ASR / TTS ---\n')

  // 1. TTS: synthesize text → audio ----------------------------------------
  const tts = new StubTtsProvider({ chunkSize: 8 })
  const text = 'Hello from clavue voice prototype.'
  console.log(`TTS input: "${text}"`)

  let chunkIndex = 0
  let totalBytes = 0
  for await (const chunk of tts.synthesize(text)) {
    chunkIndex += 1
    totalBytes += chunk.audio.byteLength
    console.log(
      `  chunk ${chunkIndex.toString().padStart(2)}  ${chunk.audio.byteLength}B  final=${chunk.final}`,
    )
  }
  console.log(`  → ${chunkIndex} chunks, ${totalBytes}B total\n`)

  // 2. ASR with partials: feed audio → transcript --------------------------
  const asr = new StubAsrProvider({ transcript: 'transcribed offline', partials: 3 })
  const fakeAudio = bufferToChunks(new Uint8Array(128), 32)
  console.log(`ASR (with 3 partials):`)
  for await (const chunk of asr.transcribe(fakeAudio)) {
    console.log(
      `  [${chunk.final ? 'FINAL' : 'partial'}] conf=${chunk.confidence?.toFixed(2)}  "${chunk.text}"`,
    )
  }
  console.log()

  // 3. Round-trip: TTS → ASR (via byte-count fallback) ---------------------
  const tts2 = new StubTtsProvider({ chunkSize: 4 })
  const audio = await collectAudio(tts2.synthesize('round-trip text'))
  console.log(`Round-trip: TTS produced ${audio.byteLength}B`)

  const asr2 = new StubAsrProvider()
  const transcript = await collectTranscript(asr2.transcribe(bufferToChunks(audio, 8)))
  console.log(`            ASR returned: "${transcript}"`)

  console.log('\n— done —')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
