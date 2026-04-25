/**
 * Example 15: Self-Improvement Memory
 *
 * Shows how to enable opt-in run learning. Failed tool signals and run failures
 * are saved as bounded, redacted improvement memories that future runs can recall.
 *
 * Run: npx tsx examples/15-self-improvement.ts
 */
import { createAgent, queryMemories } from '../src/index.js'

async function main() {
  console.log('--- Example 15: Self-Improvement Memory ---\n')

  const repoPath = process.cwd()
  const agent = createAgent({
    cwd: repoPath,
    model: process.env.CLAVUE_AGENT_MODEL || 'claude-sonnet-4-6',
    memory: {
      enabled: true,
      autoInject: true,
      repoPath,
    },
    selfImprovement: {
      memory: {
        repoPath,
        maxEntriesPerRun: 4,
      },
    },
    toolsets: ['repo-readonly'],
    maxTurns: 5,
  })

  try {
    const result = await agent.run('Review package.json and identify release readiness risks. Be concise.')
    console.log(result.text)
    console.log(`\nSaved improvement memories: ${result.self_improvement?.savedMemories.length ?? 0}`)

    const memories = await queryMemories({
      repoPath,
      type: 'improvement',
      text: 'release readiness package',
      limit: 5,
    })

    for (const memory of memories) {
      console.log(`- ${memory.title}`)
    }
  } finally {
    await agent.close()
  }
}

main().catch(console.error)
