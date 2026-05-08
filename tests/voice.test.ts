import test from 'node:test'
import assert from 'node:assert/strict'

import {
  StubAsrProvider,
  StubTtsProvider,
  bufferToChunks,
  collectAudio,
  collectTranscript,
} from '../src/voice/index.ts'

async function* fromArray<T>(items: T[]): AsyncIterable<T> {
  for (const x of items) yield x
}

test('bufferToChunks splits a Uint8Array into chunks of N bytes', async () => {
  const buf = new Uint8Array([1, 2, 3, 4, 5, 6, 7])
  const chunks: Uint8Array[] = []
  for await (const c of bufferToChunks(buf, 3)) chunks.push(c)
  assert.equal(chunks.length, 3)
  assert.deepEqual(Array.from(chunks[0]!), [1, 2, 3])
  assert.deepEqual(Array.from(chunks[1]!), [4, 5, 6])
  assert.deepEqual(Array.from(chunks[2]!), [7])
})

test('bufferToChunks: empty buffer yields nothing; chunkSize<=0 throws', async () => {
  let count = 0
  for await (const _ of bufferToChunks(new Uint8Array(0), 4)) count += 1
  assert.equal(count, 0)
  await assert.rejects(async () => {
    for await (const _ of bufferToChunks(new Uint8Array([1]), 0)) void _
  }, /chunkSize must be > 0/)
})

test('StubAsrProvider: defaults to byte count tag, single final chunk', async () => {
  const asr = new StubAsrProvider()
  const audio = bufferToChunks(new Uint8Array(64), 16)
  const out: { text: string; final: boolean }[] = []
  for await (const c of asr.transcribe(audio)) out.push({ text: c.text, final: c.final })
  assert.equal(out.length, 1)
  assert.equal(out[0]!.text, '<bytes:64>')
  assert.equal(out[0]!.final, true)
})

test('StubAsrProvider: explicit transcript + partials emits N+1 chunks', async () => {
  const asr = new StubAsrProvider({ transcript: 'hello world', partials: 2 })
  const out: { text: string; final: boolean }[] = []
  for await (const c of asr.transcribe(fromArray([new Uint8Array([1])]))) {
    out.push({ text: c.text, final: c.final })
  }
  assert.equal(out.length, 3)
  assert.equal(out[2]!.final, true)
  assert.equal(out[2]!.text, 'hello world')
  // Partials are non-final and prefixes
  assert.equal(out[0]!.final, false)
  assert.equal(out[1]!.final, false)
  assert.ok(out[0]!.text.length < out[1]!.text.length)
  assert.ok('hello world'.startsWith(out[0]!.text))
  assert.ok('hello world'.startsWith(out[1]!.text))
})

test('collectTranscript: returns final.text', async () => {
  const asr = new StubAsrProvider({ transcript: 'final answer', partials: 3 })
  const text = await collectTranscript(
    asr.transcribe(fromArray([new Uint8Array([0])])),
  )
  assert.equal(text, 'final answer')
})

test('collectTranscript: handles delta chunks by concatenating', async () => {
  async function* deltaStream() {
    yield { text: 'he', final: false, delta: true }
    yield { text: 'llo', final: false, delta: true }
    yield { text: ' world', final: true, delta: true }
  }
  const text = await collectTranscript(deltaStream())
  // delta=true on every chunk including final → final reset+concat semantics:
  // last final chunk in delta mode appends.
  // Implementation: when final & delta, we set last = last + text. Verify:
  // 'he' + 'llo' = 'hello'; '+ world' (final delta) → 'hello world'
  assert.equal(text, 'hello world')
})

test('StubTtsProvider: synthesize string yields chunks summing to UTF-8 bytes', async () => {
  const tts = new StubTtsProvider({ chunkSize: 5 })
  const text = 'hello world'
  const audio = await collectAudio(tts.synthesize(text))
  assert.equal(audio.byteLength, new TextEncoder().encode(text).byteLength)
  // Round-trip the bytes back through the decoder
  assert.equal(new TextDecoder().decode(audio), text)
})

test('StubTtsProvider: marks only the last chunk final=true', async () => {
  const tts = new StubTtsProvider({ chunkSize: 4 })
  const flags: boolean[] = []
  for await (const c of tts.synthesize('abcdefghij')) flags.push(c.final)
  // 10 bytes / 4 = 3 chunks (4, 4, 2). Only last is final.
  assert.deepEqual(flags, [false, false, true])
})

test('StubTtsProvider: empty input yields a single final chunk with 0 bytes', async () => {
  const tts = new StubTtsProvider()
  const out: { len: number; final: boolean }[] = []
  for await (const c of tts.synthesize('')) out.push({ len: c.audio.byteLength, final: c.final })
  assert.deepEqual(out, [{ len: 0, final: true }])
})

test('StubTtsProvider: streamed text input concatenates before chunking', async () => {
  const tts = new StubTtsProvider({ chunkSize: 16 })
  async function* parts() {
    yield 'foo '
    yield 'bar '
    yield 'baz'
  }
  const audio = await collectAudio(tts.synthesize(parts()))
  assert.equal(new TextDecoder().decode(audio), 'foo bar baz')
})

test('StubTtsProvider rejects non-positive chunkSize', () => {
  assert.throws(() => new StubTtsProvider({ chunkSize: 0 }), /chunkSize must be > 0/)
})

test('round-trip: TTS bytes → ASR transcript via stub byte-count fallback', async () => {
  const tts = new StubTtsProvider({ chunkSize: 4 })
  const audio = await collectAudio(tts.synthesize('round-trip'))
  const expectedBytes = audio.byteLength

  const asr = new StubAsrProvider()
  const transcript = await collectTranscript(
    asr.transcribe(bufferToChunks(audio, 3)),
  )
  assert.equal(transcript, `<bytes:${expectedBytes}>`)
})

test('AsrProvider / TtsProvider expose name field', () => {
  const a = new StubAsrProvider()
  const t = new StubTtsProvider()
  assert.equal(a.name, 'stub')
  assert.equal(t.name, 'stub')
})
