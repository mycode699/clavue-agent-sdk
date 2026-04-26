/**
 * Example 10: Permissions and Allowed Tools
 *
 * Shows how to restrict which tools the agent can use.
 * Creates a read-only agent with a named toolset so it can analyze but not modify code.
 * Read-only tools only run in parallel when they also declare concurrency safety;
 * set AGENT_SDK_MAX_TOOL_CONCURRENCY to cap safe parallel batches.
 *
 * Run: npx tsx examples/10-permissions.ts
 */
import { query } from '../src/index.js'

async function main() {
  console.log('--- Example 10: Read-Only Agent ---\n')

  // repo-readonly expands to Read, Glob, and Grep.
  // disallowedTools still applies last, so you can remove specific tools from a toolset.
  for await (const message of query({
    prompt: 'Review the code in src/agent.ts for best practices. Be concise.',
    options: {
      toolsets: ['repo-readonly'],
      disallowedTools: ['Bash', 'Write', 'Edit'],
    },
  })) {
    const msg = message as any

    if (msg.type === 'assistant') {
      for (const block of msg.message?.content || []) {
        if ('text' in block && block.text?.trim()) {
          console.log(block.text)
        }
        if ('name' in block) {
          console.log(`[${block.name}]`)
        }
      }
    }

    if (msg.type === 'result') {
      console.log(`\n--- ${msg.subtype} ---`)
    }
  }
}

main().catch(console.error)
