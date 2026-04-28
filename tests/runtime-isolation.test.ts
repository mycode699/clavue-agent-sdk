import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  clearConfig,
  clearCronJobs,
  clearMailboxes,
  clearTasks,
  clearTodos,
  ConfigTool,
  CronCreateTool,
  CronListTool,
  EnterPlanModeTool,
  ExitPlanModeTool,
  getAllCronJobs,
  getAllTasks,
  getConfig,
  getCurrentPlan,
  getTodos,
  isPlanModeActive,
  ListMcpResourcesTool,
  readMailbox,
  registerSkill,
  saveSession,
  loadSession,
  SendMessageTool,
  setMcpConnections,
  SkillTool,
  TaskCreateTool,
  TaskListTool,
  TodoWriteTool,
  Agent,
  clearSkills,
} from '../src/index.ts'

const nsA = { runtimeNamespace: 'runtime-a' }
const nsB = { runtimeNamespace: 'runtime-b' }
const cwd = process.cwd()

function resetState() {
  clearTasks()
  clearTodos()
  clearConfig()
  clearCronJobs()
  clearMailboxes()
  setMcpConnections([], nsA)
  setMcpConnections([], nsB)
}

test('runtime namespaces isolate in-memory coordination tools', async () => {
  resetState()

  await TaskCreateTool.call({ subject: 'alpha' }, { cwd, ...nsA })
  await TaskCreateTool.call({ subject: 'beta' }, { cwd, ...nsB })
  assert.deepEqual(getAllTasks(nsA).map((task) => task.subject), ['alpha'])
  assert.deepEqual(getAllTasks(nsB).map((task) => task.subject), ['beta'])

  await TodoWriteTool.call({ action: 'add', text: 'todo-a' }, { cwd, ...nsA })
  await TodoWriteTool.call({ action: 'add', text: 'todo-b' }, { cwd, ...nsB })
  assert.deepEqual(getTodos(nsA).map((todo) => todo.text), ['todo-a'])
  assert.deepEqual(getTodos(nsB).map((todo) => todo.text), ['todo-b'])

  await ConfigTool.call({ action: 'set', key: 'mode', value: 'a' }, { cwd, ...nsA })
  await ConfigTool.call({ action: 'set', key: 'mode', value: 'b' }, { cwd, ...nsB })
  assert.equal(getConfig('mode', nsA), 'a')
  assert.equal(getConfig('mode', nsB), 'b')

  await CronCreateTool.call({ name: 'job-a', schedule: '* * * * *', command: 'a' }, { cwd, ...nsA })
  await CronCreateTool.call({ name: 'job-b', schedule: '* * * * *', command: 'b' }, { cwd, ...nsB })
  assert.deepEqual(getAllCronJobs(nsA).map((job) => job.name), ['job-a'])
  assert.deepEqual(getAllCronJobs(nsB).map((job) => job.name), ['job-b'])

  const taskListA = await TaskListTool.call({}, { cwd, ...nsA })
  const cronListB = await CronListTool.call({}, { cwd, ...nsB })
  assert.match(String(taskListA.content), /alpha/)
  assert.doesNotMatch(String(taskListA.content), /beta/)
  assert.match(String(cronListB.content), /job-b/)
  assert.doesNotMatch(String(cronListB.content), /job-a/)
})

test('runtime namespaces isolate plan mode and mailboxes', async () => {
  resetState()

  await EnterPlanModeTool.call({}, { cwd, ...nsA })
  assert.equal(isPlanModeActive(nsA), true)
  assert.equal(isPlanModeActive(nsB), false)

  await ExitPlanModeTool.call({ plan: 'plan-a', approved: true }, { cwd, ...nsA })
  assert.equal(getCurrentPlan(nsA), 'plan-a')
  assert.equal(getCurrentPlan(nsB), null)

  await SendMessageTool.call({ to: 'worker', content: 'hello-a' }, { cwd, ...nsA })
  await SendMessageTool.call({ to: 'worker', content: 'hello-b' }, { cwd, ...nsB })
  assert.deepEqual(readMailbox('worker', nsA).map((message) => message.content), ['hello-a'])
  assert.deepEqual(readMailbox('worker', nsB).map((message) => message.content), ['hello-b'])
})

test('runtime namespaces isolate MCP resource registries', async () => {
  resetState()

  setMcpConnections([
    {
      name: 'docs',
      status: 'connected',
      tools: [],
      close: async () => {},
      _client: {
        listResources: async () => ({
          resources: [{ name: 'Runtime A Guide', uri: 'docs://a' }],
        }),
      },
    } as any,
  ], nsA)

  const resultA = await ListMcpResourcesTool.call({}, { cwd, ...nsA })
  const resultB = await ListMcpResourcesTool.call({}, { cwd, ...nsB })

  assert.match(String(resultA.content), /Runtime A Guide/)
  assert.equal(resultB.content, 'No MCP servers connected.')
})

test('session store dir isolates duplicate session IDs on one server', async () => {
  const dirA = await mkdtemp(join(tmpdir(), 'clavue-session-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'clavue-session-b-'))

  try {
    await saveSession('same-session', [{ role: 'user', content: 'from-a' }], {
      cwd,
      model: 'model-a',
    }, { dir: dirA })
    await saveSession('same-session', [{ role: 'user', content: 'from-b' }], {
      cwd,
      model: 'model-b',
    }, { dir: dirB })

    const sessionA = await loadSession('same-session', { dir: dirA })
    const sessionB = await loadSession('same-session', { dir: dirB })

    assert.equal(sessionA?.metadata.model, 'model-a')
    assert.equal(sessionB?.metadata.model, 'model-b')
    assert.equal(sessionA?.messages[0]?.content, 'from-a')
    assert.equal(sessionB?.messages[0]?.content, 'from-b')
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('Agent persistence and resume isolate duplicate session IDs by session dir', async () => {
  class StubProvider {
    readonly apiType = 'openai-completions' as const

    async createMessage() {
      return {
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    }
  }

  const dirA = await mkdtemp(join(tmpdir(), 'clavue-agent-session-a-'))
  const dirB = await mkdtemp(join(tmpdir(), 'clavue-agent-session-b-'))

  try {
    const first = new Agent({
      model: 'gpt-5.4',
      sessionId: 'duplicate',
      session: { dir: dirA },
      tools: [],
    })
    const second = new Agent({
      model: 'gpt-5.4',
      sessionId: 'duplicate',
      session: { dir: dirB },
      tools: [],
    })
    ;(first as any).provider = new StubProvider()
    ;(second as any).provider = new StubProvider()

    await first.prompt('from agent a')
    await second.prompt('from agent b')
    await first.close()
    await second.close()

    const resumedA = new Agent({
      model: 'gpt-5.4',
      resume: 'duplicate',
      session: { dir: dirA },
      tools: [],
    })
    const resumedB = new Agent({
      model: 'gpt-5.4',
      resume: 'duplicate',
      session: { dir: dirB },
      tools: [],
    })

    try {
      await Promise.all([(resumedA as any).setupDone, (resumedB as any).setupDone])

      assert.equal(resumedA.getSessionId(), 'duplicate')
      assert.equal(resumedB.getSessionId(), 'duplicate')
      assert.equal((resumedA as any).history[0]?.content, 'from agent a')
      assert.equal((resumedB as any).history[0]?.content, 'from agent b')
      assert.equal((resumedA as any).cfg.runtimeNamespace, 'duplicate')
      assert.equal((resumedB as any).cfg.runtimeNamespace, 'duplicate')
    } finally {
      await resumedA.close()
      await resumedB.close()
    }
  } finally {
    await rm(dirA, { recursive: true, force: true })
    await rm(dirB, { recursive: true, force: true })
  }
})

test('SkillTool advertises and executes namespace-specific skills', async () => {
  const skillNamespace = { runtimeNamespace: 'skill-runtime' }
  clearSkills(skillNamespace)

  try {
    registerSkill({
      name: 'tenant-only',
      description: 'A tenant specific skill',
      userInvocable: true,
      async getPrompt() {
        return [{ type: 'text', text: 'tenant prompt' }]
      },
    }, skillNamespace)

    const defaultPrompt = await SkillTool.prompt?.({ cwd })
    const tenantPrompt = await SkillTool.prompt?.({ cwd, ...skillNamespace })
    const defaultResult = await SkillTool.call({ skill: 'tenant-only' }, { cwd })
    const tenantResult = await SkillTool.call({ skill: 'tenant-only' }, { cwd, ...skillNamespace })

    assert.doesNotMatch(defaultPrompt || '', /tenant-only/)
    assert.match(tenantPrompt || '', /tenant-only/)
    assert.equal(defaultResult.is_error, true)
    assert.equal(tenantResult.is_error, undefined)
    assert.match(String(tenantResult.content), /tenant prompt/)
  } finally {
    clearSkills(skillNamespace)
  }
})
