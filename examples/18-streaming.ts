/**
 * Example 18: Partial-Message Streaming (TTFT UX)
 *
 * Demonstrates `includePartialMessages: true`. When the agent is waiting on
 * the model, it emits `partial_message` SDK events containing each text
 * delta as it arrives, so UIs can render characters live instead of waiting
 * for the aggregated assistant message.
 *
 * Run: npx tsx examples/18-streaming.ts
 */
import { createAgent } from '../src/index.js'

async function main() {
  console.log('--- Example 18: Partial-Message Streaming ---\n')

  const agent = createAgent({
    model: process.env.CLAVUE_AGENT_MODEL || 'claude-sonnet-4-6',
    maxTurns: 2,
    includePartialMessages: true,
  })

  process.stdout.write('Assistant: ')
  for await (const event of agent.query(
    'Count from 1 to 5 in one short sentence.',
  )) {
    const msg = event as any

    // Live delta — this fires many times per model call.
    if (msg.type === 'partial_message' && msg.partial?.type === 'text') {
      process.stdout.write(msg.partial.text)
    }

    // Final aggregated assistant message still arrives after all partials.
    if (msg.type === 'assistant') {
      process.stdout.write('\n')
    }

    if (msg.type === 'result') {
      console.log(`\n--- Result: ${msg.subtype} ---`)
      console.log(`Tokens: ${msg.usage?.input_tokens} in / ${msg.usage?.output_tokens} out`)
    }
  }
}

main().catch(console.error)
