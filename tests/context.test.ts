import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  buildContextPack,
  clearContextCache,
  createContextPipeline,
  getGitStatus,
  renderContextPack,
  type ContextPack,
} from '../src/index.ts'

test('getGitStatus reads git context from argument-based commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-git-'))

  execFileSync('git', ['init', '--initial-branch=main'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.name', 'Context Tester'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['config', 'user.email', 'context@example.test'], { cwd: dir, stdio: 'ignore' })
  await writeFile(join(dir, 'sample.txt'), 'hello\n')
  execFileSync('git', ['add', 'sample.txt'], { cwd: dir, stdio: 'ignore' })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir, stdio: 'ignore' })
  await writeFile(join(dir, 'sample.txt'), 'hello again\n')

  clearContextCache()
  const status = await getGitStatus(dir)

  assert.match(status, /Current branch: main/)
  assert.match(status, /Main branch: main/)
  assert.match(status, /Git user: Context Tester/)
  assert.match(status, /Status:\n ?M sample\.txt/)
})

test('getGitStatus returns empty string outside git repositories', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-nongit-'))

  clearContextCache()
  const status = await getGitStatus(dir)

  assert.equal(status, '')
})

test('buildContextPack returns structured context sections with provenance', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-pack-'))
  const home = await mkdtemp(join(tmpdir(), 'context-home-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  await writeFile(join(dir, 'clavue.md'), 'Project guidance\n')

  try {
    clearContextCache()
    const pack = await buildContextPack(dir, { includeGit: false, now: new Date('2026-04-30T12:00:00Z') })

    assert.equal(pack.cwd, dir)
    assert.equal(pack.sections[0]?.kind, 'date')
    assert.equal(pack.sections[0]?.title, 'currentDate')
    assert.match(pack.sections[0]?.content ?? '', /2026-04-30/)
    assert.equal(pack.sections[1]?.kind, 'project')
    assert.equal(pack.sections[1]?.source, join(dir, 'clavue.md'))
    assert.match(pack.sections[1]?.content ?? '', /Project guidance/)
  } finally {
    process.env.HOME = previousHome
  }
})

test('context pipeline can transform and render selected context sections', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'context-pipeline-'))
  const home = await mkdtemp(join(tmpdir(), 'context-home-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  await writeFile(join(dir, 'clavue.md'), 'Keep responses concise.\n')

  try {
    const pipeline = createContextPipeline()
      .use((pack: ContextPack) => ({
        ...pack,
        sections: pack.sections.filter((section) => section.kind === 'project'),
      }))
      .use((pack: ContextPack) => ({
        ...pack,
        sections: pack.sections.map((section) => ({
          ...section,
          title: `selected:${section.title}`,
        })),
      }))

    const pack = await pipeline.run(dir, { includeGit: false, now: new Date('2026-04-30T12:00:00Z') })
    const rendered = renderContextPack(pack)

    assert.equal(pack.sections.length, 1)
    assert.equal(pack.sections[0]?.title, 'selected:clavue.md')
    assert.match(rendered, /# selected:clavue\.md/)
    assert.match(rendered, /Keep responses concise\./)
  } finally {
    process.env.HOME = previousHome
  }
})
