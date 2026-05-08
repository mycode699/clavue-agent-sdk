/**
 * v3.6 Generative UI — runtime helpers (prototype).
 *
 * `UiStreamBuilder` is a tiny in-memory source producing a well-formed
 * `AsyncIterable<UiFragment>`. `renderToState()` is the reference sink —
 * it reduces a stream into a deterministic final state (text buffer,
 * component table) that any framework can render.
 *
 * Validation rules (peer SDKs are loose here):
 *   - `data.patch` must reference a `component.id` already emitted.
 *   - duplicate `component.id` is rejected (use `data` to update instead).
 *   - exactly one trailing `done` fragment is allowed; producing more is a
 *     no-op (renderer-side defensiveness).
 *
 * @module
 */

import type {
  ComponentFragment,
  DataFragment,
  DoneFragment,
  TextFragment,
  UiFragment,
  UiStreamSink,
  UiStreamSource,
} from './types.js'

export class UiStreamBuilder implements UiStreamSource {
  private fragments: UiFragment[] = []
  private done = false
  private componentIds = new Set<string>()

  text(text: string, id?: string): this {
    if (this.done) throw new Error('UiStreamBuilder: stream already done')
    const f: TextFragment = { kind: 'text', text, ...(id !== undefined ? { id } : {}) }
    this.fragments.push(f)
    return this
  }

  component(id: string, name: string, props?: Record<string, unknown>): this {
    if (this.done) throw new Error('UiStreamBuilder: stream already done')
    if (this.componentIds.has(id)) {
      throw new Error(`UiStreamBuilder: duplicate component id "${id}" (use data() to update)`)
    }
    this.componentIds.add(id)
    const f: ComponentFragment = {
      kind: 'component',
      id,
      name,
      ...(props !== undefined ? { props: { ...props } } : {}),
    }
    this.fragments.push(f)
    return this
  }

  data(id: string, patch: Record<string, unknown>): this {
    if (this.done) throw new Error('UiStreamBuilder: stream already done')
    if (!this.componentIds.has(id)) {
      throw new Error(`UiStreamBuilder: data() refers to unknown component "${id}"`)
    }
    const f: DataFragment = { kind: 'data', id, patch: { ...patch } }
    this.fragments.push(f)
    return this
  }

  finish(reason: DoneFragment['reason'] = 'completed', message?: string): this {
    if (this.done) return this
    this.done = true
    const f: DoneFragment = {
      kind: 'done',
      ...(reason !== undefined ? { reason } : {}),
      ...(message !== undefined ? { message } : {}),
    }
    this.fragments.push(f)
    return this
  }

  /** Async iterator over a snapshot of currently-emitted fragments. */
  async *stream(): AsyncIterable<UiFragment> {
    const snapshot = this.fragments.slice()
    for (const f of snapshot) {
      yield f
    }
  }
}

export interface UiState {
  /** Concatenated text by group id. `''` is the default group for un-id'd text. */
  text: Record<string, string>
  /** Components keyed by id. Props reflect all `data` patches applied. */
  components: Record<string, { name: string; props: Record<string, unknown> }>
  done: boolean
  reason?: DoneFragment['reason']
  message?: string
}

/**
 * Reduce a fragment stream into a final state. Useful for tests, snapshot
 * dumps, and CLI rendering. Real UI frameworks subscribe per-fragment
 * instead of waiting for the full reduction.
 */
export async function renderToState(
  stream: AsyncIterable<UiFragment>,
): Promise<UiState> {
  const state: UiState = { text: {}, components: {}, done: false }
  for await (const f of stream) {
    applyFragment(state, f)
  }
  return state
}

/** Apply one fragment to a state object, in place. Exported for sinks. */
export function applyFragment(state: UiState, f: UiFragment): void {
  switch (f.kind) {
    case 'text': {
      const key = f.id ?? ''
      state.text[key] = (state.text[key] ?? '') + f.text
      break
    }
    case 'component': {
      state.components[f.id] = {
        name: f.name,
        props: { ...(f.props ?? {}) },
      }
      break
    }
    case 'data': {
      const existing = state.components[f.id]
      if (!existing) {
        // Defensive: skip rather than throw — sinks tolerate out-of-order chunks.
        return
      }
      existing.props = { ...existing.props, ...f.patch }
      break
    }
    case 'done': {
      state.done = true
      if (f.reason !== undefined) state.reason = f.reason
      if (f.message !== undefined) state.message = f.message
      break
    }
  }
}

/**
 * Adapter: drive a `UiStreamSink` with a fragment stream. The sink's
 * `apply` is awaited per fragment so async sinks (DOM batched render,
 * WebSocket flush) stay ordered.
 */
export async function pipe(
  stream: AsyncIterable<UiFragment>,
  sink: UiStreamSink,
): Promise<void> {
  for await (const f of stream) {
    await sink.apply(f)
  }
}
