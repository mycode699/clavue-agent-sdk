/**
 * Example 16: Durable background AgentJobs
 *
 * Shows AgentTool run_in_background, AgentJobList/Get/Stop tools,
 * exported AgentJob APIs, and forked skills that create background jobs.
 *
 * Run: npx tsx examples/16-background-agent-jobs.ts
 */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AgentJobGetTool,
  AgentJobListTool,
  AgentTool,
  SkillTool,
  clearAgentJobs,
  getAgentJob,
  listAgentJobs,
  registerAgents,
  registerSkill,
  stopAgentJob,
} from '../src/index.js'
import type { CreateMessageParams, CreateMessageResponse, LLMProvider } from '../src/index.js'

class StubProvider implements LLMProvider {
  readonly apiType = 'openai-completions' as const
  calls: CreateMessageParams[] = []

  constructor(private readonly responses: CreateMessageResponse[]) {}

  async createMessage(params: CreateMessageParams): Promise<CreateMessageResponse> {
    this.calls.push(params)
    return this.responses.shift() ?? {
      content: [{ type: 'text', text: 'background work complete' }],
      stopReason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }
  }
}

interface ExampleJobStore {
  dir: string
  runtimeNamespace: string
}

async function waitForJob(jobId: string, store: ExampleJobStore): Promise<void> {
  for (let i = 0; i < 50; i++) {
    const job = await getAgentJob(jobId, store)
    if (job?.status === 'completed' || job?.status === 'failed' || job?.status === 'cancelled') return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`Timed out waiting for background job: ${jobId}`)
}

async function main() {
  console.log('--- Example 16: Durable background AgentJobs ---\n')

  const runtimeNamespace = 'background-agent-job-example'
  const jobsDir = await mkdtemp(join(tmpdir(), 'clavue-agent-jobs-example-'))
  const jobStore = { dir: jobsDir, runtimeNamespace }
  const previousJobsDir = process.env.CLAVUE_AGENT_JOBS_DIR
  process.env.CLAVUE_AGENT_JOBS_DIR = jobsDir

  try {
    await clearAgentJobs(jobStore)

    const context = {
      cwd: process.cwd(),
      runtimeNamespace,
      model: 'gpt-5.4',
      provider: new StubProvider([
        {
          content: [{ type: 'text', text: 'background review complete' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 8, output_tokens: 5 },
        },
        {
          content: [{ type: 'text', text: 'forked skill review complete' }],
          stopReason: 'end_turn',
          usage: { input_tokens: 6, output_tokens: 4 },
        },
      ]),
    }

    const started = await AgentTool.call({
      prompt: 'Review README.md for release-readiness issues.',
      description: 'readme review',
      subagent_type: 'Explore',
      run_in_background: true,
    }, context)

    const startedPayload = JSON.parse(String(started.content))
    console.log('Started background job:', startedPayload)

    await waitForJob(startedPayload.job_id, jobStore)

    const jobs = await listAgentJobs(jobStore)
    console.log('SDK listAgentJobs:', jobs.map((job) => ({
      id: job.id,
      status: job.status,
      traceTurns: job.trace?.turns.length ?? 0,
    })))

    const job = await getAgentJob(startedPayload.job_id, jobStore)
    console.log('SDK getAgentJob:', {
      status: job?.status,
      output: job?.output,
      hasTrace: Boolean(job?.trace),
    })

    const listToolResult = await AgentJobListTool.call({}, context)
    console.log('AgentJobList tool output:', String(listToolResult.content).slice(0, 200))

    const getToolResult = await AgentJobGetTool.call({ id: startedPayload.job_id }, context)
    console.log('AgentJobGet tool output:', String(getToolResult.content).slice(0, 200))

    const stoppedCompletedJob = await stopAgentJob(startedPayload.job_id, 'example cleanup', jobStore)
    console.log('stopAgentJob on completed job leaves status:', stoppedCompletedJob?.status)

    registerAgents({
      reviewer: {
        description: 'Durable review subagent',
        prompt: 'Review carefully and return concise findings.',
        tools: ['Glob', 'Grep'],
      },
    }, { runtimeNamespace })

    registerSkill({
      name: 'durable-review',
      description: 'Run a forked durable review job',
      context: 'fork',
      agent: 'reviewer',
      allowedTools: ['Glob'],
      model: 'gpt-5.4',
      userInvocable: true,
      async getPrompt(args) {
        return [{ type: 'text', text: `Review target: ${args}` }]
      },
    }, { runtimeNamespace })

    const forked = await SkillTool.call({ skill: 'durable-review', args: 'src/' }, context)
    const forkedPayload = JSON.parse(String(forked.content))
    console.log('Forked skill background job:', {
      status: forkedPayload.status,
      job_id: forkedPayload.job_id,
    })

    await waitForJob(forkedPayload.job_id, jobStore)
    const forkedJob = await getAgentJob(forkedPayload.job_id, jobStore)
    console.log('Forked job artifacts:', {
      status: forkedJob?.status,
      output: forkedJob?.output,
      traceTurns: forkedJob?.trace?.turns.length ?? 0,
      evidenceCount: forkedJob?.evidence?.length ?? 0,
      qualityGateCount: forkedJob?.quality_gates?.length ?? 0,
    })

    await clearAgentJobs(jobStore)
  } finally {
    if (previousJobsDir === undefined) {
      delete process.env.CLAVUE_AGENT_JOBS_DIR
    } else {
      process.env.CLAVUE_AGENT_JOBS_DIR = previousJobsDir
    }
    await rm(jobsDir, { recursive: true, force: true })
  }
}

main().catch(console.error)
