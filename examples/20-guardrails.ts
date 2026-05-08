/**
 * Example 20: Guardrails (v3.4 prototype) — 4 scopes, offline demo
 *
 * Shows clavue's 4-scope guardrail registry (openai-agents has only 2):
 *   - input        scrub prompts before the model sees them
 *   - output       block outbound model text containing forbidden content
 *   - tool_input   gate each tool call pre-execution
 *   - tool_output  scrub tool results before they go back to the model
 *
 * No real LLM call. Run:
 *
 *   npx tsx examples/20-guardrails.ts
 *
 * @module
 */

import { GuardrailRegistry } from '../src/index.js'

async function main() {
  console.log('--- Example 20: Guardrails — 4 scopes ---\n')

  const reg = new GuardrailRegistry()
    .add({
      name: 'no_api_keys_in_prompt',
      scope: 'input',
      check: (payload) => {
        const hit = /sk-[a-z0-9]{6,}/i.test(String(payload ?? ''))
        return hit
          ? { pass: false, message: 'prompt leaks an API key' }
          : { pass: true }
      },
    })
    .add({
      name: 'no_profanity_in_response',
      scope: 'output',
      check: (payload) => {
        const hit = /\b(damn|hell)\b/i.test(String(payload ?? ''))
        return hit
          ? { pass: false, blocking: false, message: 'mild language (warn-only)' }
          : { pass: true }
      },
    })
    .add({
      name: 'no_destructive_bash',
      scope: 'tool_input',
      check: (input) => {
        const cmd = String((input as { command?: string }).command ?? '')
        return /rm\s+-rf\s+\//.test(cmd)
          ? { pass: false, message: 'rm -rf / blocked' }
          : { pass: true }
      },
    })
    .add({
      name: 'scrub_aws_keys_in_tool_output',
      scope: 'tool_output',
      check: (payload) => {
        const hit = /AKIA[0-9A-Z]{16}/.test(String(payload ?? ''))
        return hit
          ? { pass: false, message: 'AWS access key in tool output' }
          : { pass: true }
      },
    })

  const cases: Array<[string, () => Promise<unknown>]> = [
    ['input: clean prompt', () => reg.evaluate('input', 'summarize this repo')],
    ['input: leaky prompt', () => reg.evaluate('input', 'call the api with sk-abcdef12345')],
    ['output: mild language', () => reg.evaluate('output', 'well damn it worked')],
    [
      'tool_input: rm -rf blocked',
      () => reg.evaluate('tool_input', { command: 'rm -rf /' }, { toolName: 'Bash' }),
    ],
    [
      'tool_output: AWS key leak',
      () =>
        reg.evaluate('tool_output', 'key=AKIAIOSFODNN7EXAMPLE', {
          toolName: 'Read',
          agentId: 'reviewer',
        }),
    ],
  ]

  for (const [label, run] of cases) {
    const ev = (await run()) as { passed: boolean; violations: unknown[] }
    console.log(`${label.padEnd(34)}  passed=${ev.passed}  violations=${ev.violations.length}`)
    for (const v of ev.violations as Array<{ guardrail: string; message?: string; blocking: boolean }>) {
      console.log(`    - [${v.blocking ? 'BLOCK' : 'warn '}] ${v.guardrail}: ${v.message ?? '(no message)'}`)
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
