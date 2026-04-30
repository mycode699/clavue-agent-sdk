# Repository Guidelines

## Project Structure & Module Organization

This is a Node 18+ ESM TypeScript SDK. Source files live in `src/`, with the public API exported from `src/index.ts`. Key areas include `src/tools/`, `src/providers/`, `src/mcp/`, `src/skills/`, and `src/retro/`. Tests live in `tests/*.test.ts`. Runnable examples are in `examples/`, including the browser demo under `examples/web/`. Generated output goes to `dist/` and should not be edited by hand.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm run build`: compile `src/` with `tsc` and emit output to `dist/`.
- `npm run dev`: run TypeScript in watch mode during SDK development.
- `npm test`: run all unit tests in `tests/*.test.ts` with `tsx --test`.
- `npm run test:all`: run the deterministic offline example smoke test.
- `npm run test:examples:live`: execute each top-level example script in `examples/`; these examples require provider configuration and may return model/provider errors without credentials.
- `npm run web`: start the example web server from `examples/web/server.ts`.

## Coding Style & Naming Conventions

Use strict TypeScript and ESM imports. Source files should import local modules with `.js` extensions so emitted output works under `NodeNext`; tests may import `.ts` files directly through `tsx`. Match the existing style: two-space indentation, single quotes, no semicolons, and concise named exports. Use PascalCase for classes and exported tool objects, camelCase for functions and variables, and established filename patterns.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`. Add or update a `tests/*.test.ts` file for behavior changes, especially tool validation, provider behavior, permissions, memory, retry logic, and retro workflows. Prefer focused tests with temporary directories via `mkdtemp` for filesystem behavior. Run `npm test` before submitting changes, and run `npm run build` when exported types or package entrypoints change.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commit-style subjects, for example `feat: add named toolsets`, `fix: bump release package metadata`, `docs: add usage best practices`, and `chore: release v0.2.9`. Keep commits scoped and imperative. Pull requests should include a short summary, motivation or linked issue, test results, and notes about API, packaging, or behavior changes.

## Security & Configuration Tips

Do not commit credentials. Use `.env.example` as the template for local configuration, and keep real provider keys in an untracked `.env`. Be careful with tool changes that execute shell commands, access files, or call network APIs; document permission or safety implications in the PR.
