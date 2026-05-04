# Plan: Validate published CLI symlink entrypoint regression

## Superseded Coordination Note

The CLI symlink regression is now covered by package tests and should not be Clavue's next focus unless it regresses.

Current Clavue assignment:
- Avoid README/docs overlap; Codex owns public API guidance and final docs verification.
- Take the provider/model capability code slice.
- Work primarily in `src/providers/*`, provider-related exports/types, and `tests/openai-provider.test.ts` or a new focused provider capability test.
- Required gates: `npx tsx --test tests/openai-provider.test.ts`, `npm run build`, and `npm test`.

Do not spend this session re-validating the old CLI symlink plan unless package-payload tests fail.

## Context
Codex reported that the published `clavue-agent-sdk@0.3.0` library APIs pass smoke tests, but invoking installed package binaries via `./node_modules/.bin/clavue-agent-sdk --help` or `npx clavue-agent-sdk@0.3.0 --help` exits 0 with no output. Direct execution of `node node_modules/clavue-agent-sdk/dist/cli.js --help` works. The likely cause is the CLI entrypoint guard comparing `import.meta.url` to `pathToFileURL(process.argv[1]).href`, which fails when npm invokes the executable through a symlink.

## Findings from read-only inspection
- `package.json` publishes two binaries, `clavue-agent-sdk` and `clavue-agent`, both mapped to `dist/cli.js`.
- `src/cli.ts:219` and built `dist/cli.js:204` gate `main()` with:
  - `import.meta.url === pathToFileURL(process.argv[1] || '').href`
- This is symlink-sensitive. For npm bin execution, `process.argv[1]` can be the `.bin` symlink path, while `import.meta.url` is the resolved package file URL, so the module imports successfully but never calls `main()`.
- Direct `node dist/cli.js --help` locally prints help and exits 0, matching Codex’s direct-path observation.
- This repository checkout does not currently have `node_modules/.bin/clavue-agent-sdk`, so direct local bin reproduction from this checkout was not possible without installing/linking.
- Existing tests check package payload binary mappings in `tests/package-payload.test.ts`, but no test appears to execute the installed binary path through an npm-style symlink.

## Severity assessment
- Severity: high for CLI/package UX, medium for the SDK as a whole.
- Rationale: the core library runtime is reportedly functional, but both documented package binary names are effectively inert under normal npm/npx invocation. Users trying the CLI get a successful exit with no output, which is confusing and blocks CLI adoption. It does not appear to affect importing the SDK or direct execution of `dist/cli.js`.

## Recommended patch
Modify the CLI entrypoint guard in `src/cli.ts` to compare real paths rather than the raw symlink path, or otherwise use a robust direct-entrypoint predicate.

Recommended minimal approach:
- Import `realpathSync` from `node:fs` and `fileURLToPath` from `node:url`.
- Add a small predicate that resolves both `fileURLToPath(import.meta.url)` and `process.argv[1]` through `realpathSync` before comparing.
- Keep the guard behavior so importing `parseArgs` from tests does not run the CLI.
- Preserve current `main()` behavior and help output.

Critical file to modify:
- `src/cli.ts`

Suggested shape:
```ts
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

function isDirectCliInvocation(metaUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false
  return realpathSync(fileURLToPath(metaUrl)) === realpathSync(argv1)
}

if (isDirectCliInvocation(import.meta.url, process.argv[1])) {
  main().catch(...)
}
```

If Windows compatibility is a concern, normalize paths before comparing if tests expose casing/separator differences.

## Recommended tests
Add coverage that proves both direct execution and npm-style symlink execution invoke the CLI.

Primary test location:
- `tests/package-payload.test.ts` or a new focused CLI test file under `tests/`

Test cases:
1. Build or use checked-in `dist/cli.js` as the target.
2. Create a temporary directory with a `.bin`-style symlink pointing to `dist/cli.js`.
3. Execute the symlink with `--help` using `spawnSync` or `execFile`.
4. Assert exit status is 0 and stdout contains `Clavue Agent SDK CLI`.
5. Optionally assert direct `node dist/cli.js --help` still works.

## Verification
After implementing:
- `npm run build`
- Targeted CLI/package test, e.g. `npx tsx --test tests/package-payload.test.ts` if test is added there
- Full suite: `npm test`
- Manual checks:
  - `node dist/cli.js --help`
  - execute a temp symlink to `dist/cli.js` with `--help`
  - optionally `npm pack --dry-run --json` to confirm package payload remains correct

## Product score
- Current published `0.3.0`: 7/10 overall if judging SDK/library utility, but 4/10 for first-run package experience because the advertised installed CLI silently does nothing.
- With the symlink guard fix and regression test: 8/10+ for package readiness, assuming Codex’s runtime smoke tests remain green.
