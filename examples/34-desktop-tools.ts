/**
 * Example 34: Cross-platform desktop tools.
 *
 * Demonstrates the `clavue-agent-sdk/desktop` subpath — opt-in tools that
 * let an agent interact with the user's machine: clipboard, screenshots,
 * file search, opening folders/apps/URLs, drafting emails, system
 * notifications.
 *
 * Tier system:
 *   - tier: 'safe'        → read-only / user-initiated (default).
 *   - tier: 'automation'  → launch apps, draft emails, notify, AppleScript,
 *                           PowerShell.  Always wire canUseTool!
 *   - tier: 'all'         → both.
 *
 * Run:
 *   export CLAVUE_AGENT_API_KEY=...
 *   export CLAVUE_AGENT_MODEL=claude-sonnet-4-6
 *   npx tsx examples/34-desktop-tools.ts
 */
import { createAgent } from '../src/index.js'
import { buildDesktopServer, currentPlatform } from '../src/desktop/index.js'

async function main() {
  console.log(`--- Example 34: Desktop tools (platform=${currentPlatform()}) ---\n`)

  // Pick a tier. For first runs use 'safe'; flip to 'all' once you trust
  // your consent gate.
  const desktop = buildDesktopServer({
    tier: 'all',
    // Drop dangerous tools if you don't want them at all:
    exclude: ['run_applescript', 'run_powershell'],
  })

  const agent = createAgent({
    systemPrompt: [
      'You are a desktop assistant. You can:',
      ' - Read or write the clipboard',
      ' - Capture the screen',
      ' - Find files',
      ' - Open folders / files / URLs',
      ' - Launch apps (WeChat, Lark, Word, ...)',
      ' - Draft emails (you NEVER send — only open a draft)',
      ' - Show system notifications',
      'Always prefer a single targeted action over multi-step automation.',
      'After every change, end with `notify` to give the user a clear receipt.',
    ].join('\n'),
    mcpServers: { desktop: desktop as any },
    allowedTools: ['mcp__desktop__*'],
    permissionMode: 'default',
    maxTurns: 8,
    maxBudgetUsd: 0.05,
    canUseTool: async (name, input) => {
      // Replace this with a real consent UI in your host app.
      console.error(`[gate] ${name} ${JSON.stringify(input).slice(0, 120)}`)
      return { behavior: 'allow', updatedInput: input }
    },
  })

  try {
    // Try one of the prompts below by uncommenting:
    const result = await agent.run(
      'Read my clipboard and show me a system notification with a one-line summary of what is in it.',
    )
    // const result = await agent.run('Find PDF files in ~/Downloads from the last week and reveal the first match in Finder.')
    // const result = await agent.run('Draft an email to alex@example.com asking when the design review is.')
    // const result = await agent.run('Open https://feishu.cn in my default browser.')
    // const result = await agent.run('Capture my current screen and tell me what application I am in.')

    console.log('\n--- Agent reply ---')
    console.log(result.text)
    console.log(`\nstatus: ${result.status} cost: $${(result.total_cost_usd ?? 0).toFixed(4)}`)
  } finally {
    await agent.close()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
