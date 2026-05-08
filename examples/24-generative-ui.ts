/**
 * Example 24: Generative UI fragment stream (v3.6 prototype)
 *
 * Framework-agnostic streaming UI: an agent emits a stream of typed
 * `UiFragment`s. Same stream can drive React, Vue, Svelte, plain HTML, or
 * the CLI sink demoed below. Vercel AI SDK's RSC-streaming is React-only;
 * we keep the protocol portable.
 *
 * Three demos:
 *   1. Build a stream with text + component + progressive data updates
 *   2. Reduce it to a final state object
 *   3. Drive a CLI sink that prints fragments as they arrive
 *
 * Run:
 *
 *   npx tsx examples/24-generative-ui.ts
 *
 * @module
 */

import {
  UiStreamBuilder,
  pipeUiStream,
  renderToState,
} from '../src/index.js'
import type { UiFragment, UiStreamSink } from '../src/index.js'

async function main() {
  console.log('--- Example 24: Generative UI fragment stream ---\n')

  // 1. Build the stream as an agent might emit it ----------------------------
  const builder = new UiStreamBuilder()
    .text('Analyzing repository ', 'status')
    .component('chart', 'BarChart', { title: 'Test results', loading: true })
    .text('… complete.\n', 'status')
    .data('chart', { loading: false, bars: [{ label: 'pass', value: 372 }] })
    .data('chart', { bars: [{ label: 'pass', value: 372 }, { label: 'fail', value: 0 }] })
    .component('summary', 'Card', { title: 'Verdict' })
    .data('summary', { body: 'production-ready' })
    .finish('completed', 'all gates green')

  // 2. Reduce to a final state object ---------------------------------------
  const finalState = await renderToState(builder.stream())
  console.log('=== final state ===')
  console.log(JSON.stringify(finalState, null, 2))

  // 3. Drive a CLI sink that prints fragments as they arrive ----------------
  console.log('\n=== streamed to CLI sink ===')
  const cliSink: UiStreamSink = {
    apply(f: UiFragment) {
      switch (f.kind) {
        case 'text':
          process.stdout.write(`text[${f.id ?? '-'}]: ${f.text}\n`)
          break
        case 'component':
          process.stdout.write(`+ component ${f.id} (${f.name}) props=${JSON.stringify(f.props ?? {})}\n`)
          break
        case 'data':
          process.stdout.write(`~ patch ${f.id} ${JSON.stringify(f.patch)}\n`)
          break
        case 'done':
          process.stdout.write(`✓ done reason=${f.reason} message=${f.message ?? '-'}\n`)
          break
      }
    },
  }

  // Re-build a fresh stream — builders are single-pass.
  const replayBuilder = new UiStreamBuilder()
    .text('Analyzing repository ', 'status')
    .component('chart', 'BarChart', { title: 'Test results', loading: true })
    .text('… complete.\n', 'status')
    .data('chart', { loading: false, bars: [{ label: 'pass', value: 372 }] })
    .data('chart', { bars: [{ label: 'pass', value: 372 }, { label: 'fail', value: 0 }] })
    .component('summary', 'Card', { title: 'Verdict' })
    .data('summary', { body: 'production-ready' })
    .finish('completed', 'all gates green')

  await pipeUiStream(replayBuilder.stream(), cliSink)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
