# clavue.md

This file provides guidance to Clavue (claude.ai/code) when working with code in this repository.

## Development commands

- `npm run build` — compile TypeScript to `dist/` with `tsc`.
- `npm run dev` — run TypeScript in watch mode.
- `npm test` — run the checked-in test suite with `npx tsx --test tests/*.test.ts`.
- `npx tsx --test tests/retro-run.test.ts` — run the end-to-end retro/eval pipeline tests.
- `npx tsx --test tests/retro-verify.test.ts` — run retro verification gate tests.
- `npx tsx --test tests/package-payload.test.ts` — verify published package payload and storage branding.
- `npx tsx --test tests/openai-provider.test.ts` — run OpenAI-compatible provider tests.
- `npx tsx --test tests/memory.test.ts` — run structured memory persistence/query tests.
- `npx tsx --test tests/permissions.test.ts` — run permission-mode and tool-policy tests.
- `npm run test:all` — execute the numbered example scripts in `examples/` as smoke tests.
- `npx tsx examples/01-simple-query.ts` — run a single example directly.
- `npm run web` — start the example web UI server at `examples/web/server.ts`.
- `npm pack --dry-run --json` — inspect the exact package payload; this triggers `prepack` and therefore `npm run build`.

There is currently no dedicated lint script in `package.json`.

## Runtime and package facts

- The package is ESM-only (`"type": "module"`) and publishes `dist/` via the `files` field.
- Node.js support starts at `>=18.0.0`.
- `npm pack` / publish paths run `prepack`, which calls `npm run build`.
- Runtime configuration is primarily through `CLAVUE_AGENT_API_KEY`, `CLAVUE_AGENT_API_TYPE`, `CLAVUE_AGENT_MODEL`, `CLAVUE_AGENT_BASE_URL`, and `CLAVUE_AGENT_AUTH_TOKEN`.

## Architecture overview

- `src/index.ts` is the public SDK surface. It re-exports the high-level agent API, provider layer, built-in tools, skill system, MCP helpers, session helpers, structured memory APIs, context utilities, and the retro/eval pipeline.
- `src/cli.ts` is the optional package binary used by both `clavue-agent-sdk` and `clavue-agent`. It parses prompt/model/API/tool allow-deny flags, uses `run()` for `--json`, and streams `query()` events otherwise.
- `src/agent.ts` is the orchestration layer behind `createAgent()`, `query()`, and `run()`. It resolves credentials and API type, creates the provider, initializes bundled skills, builds the tool pool, connects MCP servers, registers custom subagents, resumes persisted sessions, configures hooks, and hands work to the engine.
- `src/engine.ts` contains the core agent loop. It builds the default system prompt from available tools plus repo context and optional memory injection, calls the provider, executes tool calls, runs hooks, retries transient failures, tracks usage/cost, and auto-compacts conversation history when context grows too large.
- `src/utils/context.ts` defines prompt context injection. It discovers `AGENT.md`, `CLAVUE.md`, `.clavue/CLAVUE.md`, `clavue.md`, and `~/.clavue/CLAVUE.md`, then combines them with the current date and git status for the engine’s default prompt.
- `src/providers/` isolates transport details from the engine. `src/providers/index.ts` selects Anthropic vs OpenAI-compatible providers; `src/providers/openai.ts` and `src/providers/anthropic.ts` translate the SDK’s normalized message/tool format into provider-specific requests.
- `src/tools/index.ts` is the built-in tool registry and filtering layer. The engine works against the shared `ToolDefinition` interface from `src/types.ts`; individual implementations live in `src/tools/*.ts`.
- `src/tool-helper.ts` and `src/sdk-mcp-server.ts` bridge Zod-based SDK tool definitions into engine tools and in-process MCP servers. External MCP connections are handled separately in `src/mcp/client.ts`.
- `src/session.ts` handles transcript persistence under `~/.clavue-agent-sdk/sessions`. `src/memory.ts` and `src/memory-policy.ts` handle structured memory storage/extraction; both are separate from retro/eval persistence.
- `src/retro/` is a deterministic evaluation pipeline, separate from the live agent loop. The flow is: evaluators produce findings, findings are normalized and scored, workstreams are planned, verification gates are run, policy decides the next action, and `cycle.ts` / `loop.ts` assemble those pieces into repeatable retro runs saved by `ledger.ts`.
- `src/skills/` is registry-based. Bundled skills are initialized from `src/agent.ts`, exposed through `src/skills/index.ts`, and invoked through the Skill tool.

## Examples and verification anchors

- The numbered scripts in `examples/` are the best reference for intended SDK usage. Prefer them over README prose when you need canonical behavior.
- `examples/03-multi-turn.ts` is the quickest way to understand reusable agent sessions.
- `examples/06-mcp-server.ts`, `examples/09-subagents.ts`, `examples/11-custom-mcp-tools.ts`, `examples/12-skills.ts`, `examples/13-hooks.ts`, and `examples/14-openai-compat.ts` are the fastest way to understand the major extension points.
- `examples/web/server.ts` is the local sandbox for streaming UI behavior.
- `tests/retro-run.test.ts` is the best entry point for understanding the retro/eval pipeline end to end.
- `tests/retro-verify.test.ts` shows how fixed verification gates are executed and summarized.
- `tests/openai-provider.test.ts` is the focused check for OpenAI-compatible transport behavior.
- `tests/package-payload.test.ts` is the check for packaging expectations and persisted storage paths.

## Repo-specific notes

- This package is an in-process agent SDK, not a CLI wrapper. The full agent loop is meant to run inside the host process.
- Top-level API selection is provider-agnostic. Model naming plus `CLAVUE_AGENT_*` environment variables decide whether the SDK uses Anthropic Messages or OpenAI-compatible APIs.
- If you are updating user-facing behavior, check both the corresponding numbered example and the exported surface in `src/index.ts`; the examples show intended usage, while `src/index.ts` shows what is actually public.
- No `.cursor/rules/`, `.cursorrules`, or `.github/copilot-instructions.md` files are present in this repository right now.

## Current execution directive

- Treat the current working tree as a release-candidate stabilization batch.
- Verified on 2026-04-28: `npm run build` passes; `npm test` passes 151/151; focused gate `npx tsx --test tests/permissions.test.ts tests/memory-integration.test.ts tests/doctor.test.ts tests/package-payload.test.ts` passes 56/56.
- Current batch includes built-in permission semantics, tool safety annotations, lifecycle workflow skill metadata, skill activation constraints, quality-gate terminal failure policy, brain-first memory trace, `doctor()`, `runBenchmarks()`, and package/CLI symlink regression coverage.
- Current ownership split: Codex owns README/docs public API guidance and final docs verification. Clavue should avoid README/doc overlap unless explicitly asked.
- New controlling program: `docs/agent-sdk-capability-upgrade-program.md`. The product goal is broader than coding automation: support collection, organization, planning, problem solving, verification, review, shipping, memory intelligence, skill creation, and self-learning.
- Clavue immediate code-side slice remains model capability registry and provider fallback/error policy, scoped to `src/providers/*`, provider-related types/exports, and provider tests such as `tests/openai-provider.test.ts`.
- Do not touch docs/README in this slice. If docs are needed, leave a TODO or handoff note for Codex.
- Required behavior: expose deterministic model capability lookup; keep existing provider behavior compatible; add tests for GPT/OpenAI-compatible capability detection, unsupported capability/fallback decisions, and normalized provider error categories where feasible.
- After provider/model capability is green, next implementation order is: reusable runtime profiles and startup/context benchmark, `ContextPack` / `ContextPipeline`, richer memory retrieval trace and `brainFirst`, exported skill validation and skill-gate enforcement, skill authoring/scaffolding APIs, skill-aware self-improvement, then reusable agents and workflow templates.
- Stop conditions: if `npm test`, `npm run build`, or `npx tsx --test tests/openai-provider.test.ts` fails, stop feature expansion and fix the gate first. If the API shape is unclear, add a minimal failing test before implementation.
- If build or tests fail, stop feature work and restore the gate before continuing.

<!-- CLAVUE_INIT_DETECTED_CONTEXT_START -->
<!-- This section is maintained by /init. Keep custom guidance outside these markers. -->
## Repository
- Root: open-agent-sdk-typescript
- Top-level directories: dist, docs, examples, src, tests

## Commands
- npm run build
- npm run dev
- npm run test

## Detected Project Context
- package.json: package clavue-agent-sdk; type module; scripts: npm run build (tsc); npm run dev (tsc --watch); npm run test (npx tsx --test tests/*.test.ts); notable deps: typescript
- package-lock.json: {
- README.md: # Clavue Agent SDK
- tsconfig.json: {
<!-- CLAVUE_INIT_DETECTED_CONTEXT_END -->
