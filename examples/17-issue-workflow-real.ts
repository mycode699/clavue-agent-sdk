/**
 * Example 17 — runIssueWorkflowWithAgent (real LLM-driven loop).
 *
 * What it shows:
 *   - The v2 `runIssueWorkflowWithAgent` API drives a real Agent through
 *     `build → verify → review → fix` iterations until a Verifier reports
 *     all required gates passing, or `maxIterations` is reached.
 *   - A `Verifier` is anything implementing `verify({ cwd, iteration })`.
 *     This example uses `CommandVerifier` (shells out to user-supplied
 *     commands) but you can write your own if you already have a CI agent.
 *   - The legacy `runIssueWorkflow` API still works — this is a pure addition.
 *
 * This example uses a deterministic mock Agent so it runs without API keys.
 * Replace `mockAgent` with `new Agent({ apiKey: process.env.ANTHROPIC_API_KEY })`
 * to run against a real model.
 *
 * Usage:
 *   npx tsx examples/17-issue-workflow-real.ts
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_RUN_RESULT_SCHEMA_VERSION,
  CommandVerifier,
  normalizeIssueInput,
  runIssueWorkflowWithAgent,
} from '../src/index.ts'
import type { AgentLike } from '../src/index.ts'

async function main() {
  // 1. Set up a sandbox cwd. In real use this would be your repository root or
  //    an isolated worktree.
  const cwd = await mkdtemp(join(tmpdir(), 'clavue-issue-real-demo-'))
  // Seed a "test" file the verifier can run.
  await writeFile(join(cwd, 'fake-test.sh'), '#!/bin/sh\necho "running tests…"\nexit 0\n')

  // 2. Define an Agent. Real usage:
  //      const agent = new Agent({ apiKey: process.env.ANTHROPIC_API_KEY })
  //
  //    Mock for this offline demo — pretends to do build / review work.
  const mockAgent: AgentLike = {
    async run(prompt) {
      const phase = prompt.includes('Verification failed') ? 'review' : 'build'
      return {
        schema_version: AGENT_RUN_RESULT_SCHEMA_VERSION,
        id: `run_${phase}_${Date.now()}`,
        session_id: 'demo',
        status: 'completed',
        subtype: 'success',
        text: phase === 'build'
          ? `(would-be) Implemented changes for issue. Phase: ${phase}.`
          : `(would-be) Suggested fix plan: tighten validation, add a test, retry.`,
        usage: { input_tokens: 0, output_tokens: 0 },
        num_turns: 1,
        duration_ms: 1,
        duration_api_ms: 1,
        total_cost_usd: 0,
        cost: 0,
        started_at: new Date().toISOString(),
        completed_at: new Date().toISOString(),
        events: [],
      } as any
    },
  }

  // 3. Define a Verifier. Here we just shell out to a command — substitute
  //    `npm test`, `pnpm typecheck`, or whatever your project uses.
  const verifier = new CommandVerifier([
    { name: 'tests', cmd: 'sh ./fake-test.sh', timeoutMs: 10_000 },
  ])

  // 4. Build an issue record. `normalizeIssueInput(text)` accepts a
  //    "title\n\nbody" string; you can also pass a fully-formed
  //    `IssueWorkflowRecord`.
  const issue = normalizeIssueInput([
    'Fix flaky retry classification',
    '',
    'When the provider returns a retryable category but the underlying status is 404,',
    'the engine should still treat it as fallback-eligible.',
  ].join('\n'))

  // 5. Run the loop.
  const result = await runIssueWorkflowWithAgent({
    issue,
    agent: mockAgent,
    verifier,
    cwd,
    requiredGates: ['tests'],
    maxIterations: 3,
  }, { storeRoot: cwd })

  console.log('Status:', result.status)
  console.log('Final score:', result.finalScore)
  console.log('Quality gates:', result.quality_gates.map((g) => `${g.name}=${g.status}`).join(', '))
  console.log('Unresolved findings:', result.unresolvedFindings.length)
  console.log('Proof-of-work status:', result.proof_of_work.status)

  await rm(cwd, { recursive: true, force: true })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
