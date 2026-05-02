import test from 'node:test'
import assert from 'node:assert/strict'

function createRunResult(overrides: Partial<import('../src/index.ts').AgentRunResult> = {}): import('../src/index.ts').AgentRunResult {
  return {
    schema_version: '1.0.0',
    id: 'run_1',
    session_id: 'session_1',
    status: 'completed',
    subtype: 'success',
    text: 'Completed the task.',
    usage: { input_tokens: 10, output_tokens: 20 },
    num_turns: 3,
    duration_ms: 1200,
    duration_api_ms: 800,
    total_cost_usd: 0.02,
    stop_reason: 'end_turn',
    started_at: '2026-05-02T00:00:00.000Z',
    completed_at: '2026-05-02T00:00:02.000Z',
    messages: [],
    events: [],
    ...overrides,
  }
}

test('createProofOfWork summarizes a completed run with required gates and host references', async () => {
  const { PROOF_OF_WORK_SCHEMA_VERSION, createProofOfWork } = await import('../src/index.ts')

  const proof = createProofOfWork({
    generated_at: '2026-05-02T00:00:03.000Z',
    target: {
      kind: 'issue',
      id: 'SDK-42',
      title: 'Fix autonomous workflow handoff',
    },
    run: createRunResult({
      evidence: [
        { type: 'test', summary: 'Focused tests passed', source: 'eval', location: 'tests/proof-of-work.test.ts' },
      ],
      quality_gates: [
        { name: 'tests', status: 'passed', summary: 'Focused tests passed' },
        { name: 'review', status: 'passed', summary: 'No blocking findings' },
      ],
    }),
    required_gates: ['tests', 'review'],
    references: [
      { type: 'pull_request', label: 'Host-created PR', url: 'https://example.test/pr/42', status: 'open' },
      { type: 'ci', label: 'Host CI', url: 'https://example.test/ci/42', status: 'passed' },
    ],
  })

  assert.equal(proof.schema_version, PROOF_OF_WORK_SCHEMA_VERSION)
  assert.equal(proof.status, 'passed')
  assert.equal(proof.summary, 'Fix autonomous workflow handoff: passed')
  assert.equal(proof.run?.id, 'run_1')
  assert.deepEqual(proof.verification.required_gates, ['review', 'tests'])
  assert.deepEqual(proof.verification.passed_gates, ['review', 'tests'])
  assert.deepEqual(proof.verification.missing_gates, [])
  assert.equal(proof.references.length, 2)
  assert.equal(proof.handoff.ready_for_human_review, true)
})

test('createProofOfWork marks completed work as needs_review when required gates are missing', async () => {
  const { createProofOfWork } = await import('../src/index.ts')

  const proof = createProofOfWork({
    generated_at: '2026-05-02T00:00:03.000Z',
    run: createRunResult({
      quality_gates: [{ name: 'tests', status: 'passed' }],
    }),
    required_gates: ['tests', 'review'],
  })

  assert.equal(proof.status, 'needs_review')
  assert.deepEqual(proof.verification.missing_gates, ['review'])
  assert.equal(proof.handoff.ready_for_human_review, true)
  assert.match(proof.handoff.reason, /review/)
})

test('createProofOfWork marks failed gates and failed jobs as failed', async () => {
  const { createProofOfWork } = await import('../src/index.ts')

  const failedGate = createProofOfWork({
    generated_at: '2026-05-02T00:00:03.000Z',
    run: createRunResult({
      quality_gates: [{ name: 'build', status: 'failed', summary: 'TypeScript failed' }],
    }),
    required_gates: ['build'],
  })

  assert.equal(failedGate.status, 'failed')
  assert.equal(failedGate.handoff.ready_for_human_review, false)
  assert.match(failedGate.handoff.reason, /build/)

  const failedJob = createProofOfWork({
    generated_at: '2026-05-02T00:00:03.000Z',
    job: {
      schema_version: '1.0.0',
      id: 'agent_job_1',
      kind: 'subagent',
      status: 'failed',
      runtimeNamespace: 'proof-test',
      prompt: 'Fix SDK-42',
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:02.000Z',
      error: 'runner failed',
    },
  })

  assert.equal(failedJob.status, 'failed')
  assert.equal(failedJob.job?.id, 'agent_job_1')
})

test('createProofOfWork summarizes issue workflow results without owning tracker integrations', async () => {
  const { createProofOfWork } = await import('../src/index.ts')

  const proof = createProofOfWork({
    generated_at: '2026-05-02T00:00:03.000Z',
    issueWorkflow: {
      status: 'completed',
      finalScore: 96,
      unresolvedFindings: [],
      quality_gates: [{ name: 'tests', status: 'passed', summary: 'unit tests passed' }],
      run: {
        schema_version: '1.0.0',
        id: 'issue_run_1',
        issue: {
          id: 'SDK-42',
          title: 'Fix autonomous workflow handoff',
          body: 'Produce proof of work.',
          labels: ['p1'],
          source: { type: 'inline' },
        },
        status: 'completed',
        createdAt: '2026-05-02T00:00:00.000Z',
        updatedAt: '2026-05-02T00:00:02.000Z',
        correlation_id: 'issue_run_1',
        batch_id: 'batch_1',
        jobs: [
          { role: 'builder', job_id: 'job_1', iteration: 1 },
          { role: 'reviewer', job_id: 'job_2', iteration: 1 },
          { role: 'verifier', job_id: 'job_3', iteration: 1 },
        ],
        requiredGates: ['tests'],
        passingScore: 90,
        finalScore: 96,
      },
    },
    references: [
      { type: 'issue', label: 'External issue', url: 'https://tracker.test/SDK-42' },
    ],
  })

  assert.equal(proof.status, 'passed')
  assert.equal(proof.issue_workflow?.id, 'issue_run_1')
  assert.equal(proof.issue_workflow?.job_count, 3)
  assert.deepEqual(proof.verification.missing_gates, [])
  assert.equal(proof.references[0]?.type, 'issue')
})
