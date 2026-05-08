/**
 * v3.6 Generative UI (prototype) — public surface.
 *
 * Tracking doc: docs/v2_v3_v4_upgrade_chain.md (v3.6 section).
 * @module
 */

export type {
  ComponentFragment,
  DataFragment,
  DoneFragment,
  TextFragment,
  UiFragment,
  UiStreamSink,
  UiStreamSource,
} from './types.js'

export {
  UiStreamBuilder,
  applyFragment,
  pipe,
  renderToState,
  type UiState,
} from './runtime.js'
