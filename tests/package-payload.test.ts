import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('npm package payload includes compiled entrypoints and excludes temp artifacts', async () => {
  const { stdout } = await execFileAsync('npm', ['pack', '--dry-run', '--json'], {
    cwd: packageRoot,
  })

  const packageJson = JSON.parse(
    await import('node:fs/promises').then(({ readFile }) =>
      readFile(resolve(packageRoot, 'package.json'), 'utf-8'),
    ),
  ) as { scripts?: Record<string, string> }
  const [pack] = JSON.parse(stdout) as [{ files: Array<{ path: string }> }]
  const paths = new Set(pack.files.map((file) => file.path))

  assert.ok(
    packageJson.scripts?.prepack || packageJson.scripts?.prepare || packageJson.scripts?.prepublishOnly,
    'expected a publish-time build script so dist is generated before packing',
  )
  assert.equal(
    packageJson.scripts?.test,
    'npx tsx --test tests/*.test.ts',
    'expected npm test to run the checked-in test suite',
  )
  assert.ok(paths.has('dist/index.js'), 'expected dist/index.js to be published')
  assert.ok(paths.has('dist/index.d.ts'), 'expected dist/index.d.ts to be published')
  assert.ok(
    [...paths].every((path) => !path.startsWith('.tmp-retro-ledger/')),
    'expected temp retro ledger artifacts to be excluded',
  )
})
