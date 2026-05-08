import test from 'node:test'
import assert from 'node:assert/strict'

import {
  UiStreamBuilder,
  applyFragment,
  pipe,
  renderToState,
  type UiFragment,
  type UiState,
  type UiStreamSink,
} from '../src/genui/index.ts'

test('builder: text + component + data + done in order', async () => {
  const b = new UiStreamBuilder()
    .text('hello ')
    .text('world', 'greeting')
    .component('card1', 'Card', { title: 'Hi' })
    .data('card1', { body: 'streamed in' })
    .finish()

  const out: UiFragment[] = []
  for await (const f of b.stream()) out.push(f)

  assert.equal(out.length, 5)
  assert.equal(out[0]!.kind, 'text')
  assert.equal(out[2]!.kind, 'component')
  assert.equal(out[3]!.kind, 'data')
  assert.equal(out[4]!.kind, 'done')
})

test('builder: emits after finish() throw', () => {
  const b = new UiStreamBuilder().finish()
  assert.throws(() => b.text('late'), /already done/)
  assert.throws(() => b.component('c', 'X'), /already done/)
  assert.throws(() => b.data('c', { foo: 1 }), /already done/)
})

test('builder: finish is idempotent (no double-done)', async () => {
  const b = new UiStreamBuilder().text('hi').finish().finish('cancelled')
  const out: UiFragment[] = []
  for await (const f of b.stream()) out.push(f)
  // text + done (only one)
  assert.equal(out.length, 2)
  assert.equal(out[1]!.kind, 'done')
})

test('builder: duplicate component id rejected', () => {
  const b = new UiStreamBuilder()
  b.component('c1', 'X')
  assert.throws(() => b.component('c1', 'Y'), /duplicate component id/)
})

test('builder: data() to unknown component id rejected', () => {
  const b = new UiStreamBuilder()
  assert.throws(() => b.data('ghost', { foo: 1 }), /unknown component "ghost"/)
})

test('renderToState: concatenates text by id, default group is empty string', async () => {
  const b = new UiStreamBuilder()
    .text('un')
    .text('grouped')
    .text('A:', 'a')
    .text('hello', 'a')
    .text(' B:', 'b')
    .finish()
  const state = await renderToState(b.stream())
  assert.equal(state.text[''], 'ungrouped')
  assert.equal(state.text['a'], 'A:hello')
  assert.equal(state.text['b'], ' B:')
})

test('renderToState: data patches merge shallow into component props', async () => {
  const b = new UiStreamBuilder()
    .component('chart', 'Chart', { title: 't', loading: true })
    .data('chart', { loading: false, points: [1, 2, 3] })
    .finish()
  const state = await renderToState(b.stream())
  assert.deepEqual(state.components.chart, {
    name: 'Chart',
    props: { title: 't', loading: false, points: [1, 2, 3] },
  })
})

test('renderToState: done sets reason / message', async () => {
  const b = new UiStreamBuilder().text('hi').finish('cancelled', 'user pressed esc')
  const state = await renderToState(b.stream())
  assert.equal(state.done, true)
  assert.equal(state.reason, 'cancelled')
  assert.equal(state.message, 'user pressed esc')
})

test('applyFragment: orphan data() is skipped (sink-side defensiveness)', () => {
  const state: UiState = { text: {}, components: {}, done: false }
  applyFragment(state, { kind: 'data', id: 'never-existed', patch: { foo: 1 } })
  assert.deepEqual(state.components, {})
})

test('pipe: drives an async sink in order, awaiting each apply', async () => {
  const order: string[] = []
  const sink: UiStreamSink = {
    async apply(f) {
      // Simulate async render (DOM batch / WebSocket flush).
      await new Promise((r) => setTimeout(r, 1))
      order.push(`${f.kind}:${'id' in f ? (f as { id?: string }).id ?? '' : ''}`)
    },
  }
  const b = new UiStreamBuilder()
    .text('a', 't1')
    .component('c1', 'X')
    .data('c1', { v: 1 })
    .finish()
  await pipe(b.stream(), sink)
  assert.deepEqual(order, ['text:t1', 'component:c1', 'data:c1', 'done:'])
})

test('component fragment with no props yields {} props in state', async () => {
  const b = new UiStreamBuilder().component('c', 'Bare').finish()
  const state = await renderToState(b.stream())
  assert.deepEqual(state.components.c, { name: 'Bare', props: {} })
})

test('builder: text without explicit done still streams; state.done=false', async () => {
  const b = new UiStreamBuilder().text('half')
  const state = await renderToState(b.stream())
  assert.equal(state.done, false)
  assert.equal(state.text[''], 'half')
})

test('props are cloned at builder time — mutating after does not bleed', async () => {
  const props = { title: 'orig' }
  const b = new UiStreamBuilder().component('c', 'X', props).finish()
  props.title = 'mutated'
  const state = await renderToState(b.stream())
  assert.equal(state.components.c!.props.title, 'orig')
})
