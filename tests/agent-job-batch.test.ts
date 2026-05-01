import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  AgentTool,
  clearAgentJobs,
  createAgentJobBatch,
  getAgentJob,
  listAgentJobs,
  summarizeAgentJobs,
} from '../src/index.ts'

class StubProvider {
  readonly apiType = 'openai-completions' as const

  constructor(private readonly responses: string[]) {}

  async createMessage() {
    return {
      content: [{ type: 'text' as const, text: this.responses.shift() || 'done' }],
      stopReason: 'end_turn' as const,
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

async function eventually(assertion: () => Promise<void> | void): Promise<void> {
  let lastError: unknown
  for (let i = 0; i < 50; i++) {
    try {
      await assertion()
      return
    } catch (err) {
      lastError = err
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }
  throw lastError
}

test('createAgentJobBatch creates one job per task with shared batch metadata', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'clavue-agent-job-batch-'))
  try {
    const options = { dir, runtimeNamespace: 'batch-test' }
    const result = await createAgentJobBatch({
      correlation_id: 'release-candidate-0.7.5',
      tasks: [
        {
          prompt: 'Inspect provider fallback behavior',
          description: 'Provider fallback slice',
          subagent_type: 'general-purpose',
          model: 'gpt-5.4',
          allowedTools: ['Read'],
        },
        {
          prompt: 'Inspect runtime profile behavior',
          description: 'Runtime profile slice',
          subagent_type: 'general-purpose',
          model: 'gpt-5.4',
          allowedTools: ['Read', 'Grep'],
        },
      ],
    }, options)

    assert.match(result.batch_id, /^agent_job_batch_/)
    assert.equal(result.correlation_id, 'release-candidate-0.7.5')
    assert.equal(result.jobs.length, 2)
    assert.equal(result.summary.total, 2)
    assert.equal(result.summary.batch_count, 1)
    assert.deepEqual(result.summary.batches, [
      {
        batch_id: result.batch_id,
        correlation_id: 'release-candidate-0.7.5',
        total: 2,
        by_status: {
          queued: 2,
          running: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          stale: 0,
        },
        job_ids: result.jobs.map((job) => job.id).sort(),
      },
    ])

    for (const job of result.jobs) {
      assert.equal(job.status, 'queued')
      assert.equal(job.batch_id, result.batch_id)
      assert.equal(job.correlation_id, 'release-candidate-0.7.5')
    }

    const allJobs = await listAgentJobs(options)
    assert.equal(allJobs.length, 2)

    const jobsInBatch = await listAgentJobs({ ...options, batch_id: result.batch_id })
    assert.deepEqual(
      jobsInBatch.map((job) => job.id).sort(),
      result.jobs.map((job) => job.id).sort(),
    )

    const summaryForCorrelation = await summarizeAgentJobs({
      ...options,
      correlation_id: 'release-candidate-0.7.5',
    })
    assert.equal(summaryForCorrelation.total, 2)
    assert.equal(summaryForCorrelation.batch_count, 1)
    assert.deepEqual(summaryForCorrelation.batches.map((batch) => batch.batch_id), [result.batch_id])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('AgentTool background batch creates one policy-bounded job per task', async () => {
  const context = { runtimeNamespace: 'agent-tool-batch-test' }
  await clearAgentJobs(context)

  try {
    const result = await AgentTool.call(
      {
        run_in_background: true,
        batch: [
          {
            prompt: 'Inspect package payload',
            description: 'package payload',
            allowed_tools: ['Read', 'Bash'],
          },
          {
            prompt: 'Inspect provider fallback',
            description: 'provider fallback',
          },
        ],
        correlation_id: 'policy-bounded-batch',
      },
      {
        cwd: process.cwd(),
        provider: new StubProvider(['package done', 'provider done']),
        model: 'gpt-5.4',
        apiType: 'openai-completions',
        runtimeNamespace: context.runtimeNamespace,
        availableTools: ['Read', 'Grep'],
      },
    )
    const payload = JSON.parse(String(result.content))

    assert.equal(payload.type, 'clavue.agent.job.batch')
    assert.equal(payload.status, 'queued')
    assert.match(payload.batch_id, /^agent_job_batch_/)
    assert.equal(payload.job_ids.length, 2)
    assert.equal(payload.summary.total, 2)
    assert.equal(payload.summary.batch_count, 1)

    await eventually(async () => {
      const jobs = await listAgentJobs({ ...context, batch_id: payload.batch_id })
      assert.equal(jobs.length, 2)
      assert.deepEqual(jobs.map((job) => job.id).sort(), payload.job_ids.sort())

      const narrowed = jobs.find((job) => job.description === 'package payload')
      const inherited = jobs.find((job) => job.description === 'provider fallback')
      assert.deepEqual(narrowed?.allowedTools, ['Read'])
      assert.deepEqual(inherited?.allowedTools, ['Read', 'Grep'])
      assert.equal(narrowed?.status, 'completed')
      assert.equal(inherited?.status, 'completed')
    })

    await clearAgentJobs(context)
    for (const jobId of payload.job_ids) {
      const job = await getAgentJob(jobId, context)
      assert.equal(job, null)
    }
  } finally {
    await clearAgentJobs(context)
  }
})
