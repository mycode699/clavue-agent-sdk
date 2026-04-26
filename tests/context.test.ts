import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { clearContextCache, getGitStatus } from '../src/index.ts'

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
