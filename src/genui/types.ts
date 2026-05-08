/**
 * v3.6 Generative UI — fragment protocol types (prototype).
 *
 * Framework-agnostic streaming UI: an agent emits a stream of typed
 * `UiFragment`s. Renderers (React, Vue, Svelte, CLI, plain HTML…) consume
 * the same stream. Vercel AI SDK ties this to React; we keep it on plain
 * `AsyncIterable<UiFragment>` so nobody is locked in.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.6 section).
 *
 * @module
 */

/** Append-only chunk of free text. Renderers concatenate to a buffer. */
export interface TextFragment {
  kind: 'text'
  /** Optional id so renderers can group multi-chunk text streams. */
  id?: string
  text: string
}

/**
 * A typed component invocation. The renderer maps `name` to its native
 * widget (React component, Vue component, ANSI box, etc.).
 *
 *   { kind: 'component', name: 'Card', props: { title: 'Hi' } }
 */
export interface ComponentFragment {
  kind: 'component'
  /** Stable id for in-place updates via `data` fragments. */
  id: string
  name: string
  props?: Record<string, unknown>
}

/**
 * Update an existing component's props by id. Lets a streaming agent
 * progressively fill in fields without re-emitting the whole component.
 */
export interface DataFragment {
  kind: 'data'
  /** Must reference an earlier `component.id`. */
  id: string
  /** Patch merged shallow into existing props. */
  patch: Record<string, unknown>
}

/** End-of-stream sentinel. Carries optional reason / final state. */
export interface DoneFragment {
  kind: 'done'
  reason?: 'completed' | 'cancelled' | 'error'
  message?: string
}

export type UiFragment =
  | TextFragment
  | ComponentFragment
  | DataFragment
  | DoneFragment

/** Producer side: any agent that emits a UI stream. */
export interface UiStreamSource {
  stream(): AsyncIterable<UiFragment>
}

/** Consumer side: any renderer that knows how to apply a fragment. */
export interface UiStreamSink {
  apply(fragment: UiFragment): void | Promise<void>
}
