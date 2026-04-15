# Implementation Plan: Retro/Eval Core

Date: 2026-04-14
Feature: retro-eval-core
Repo: /Users/lu/openagent/open-agent-sdk-typescript
Status: ready for execution

## Goal
Add an engine-only retro/eval core to the SDK that runs a typed evaluation pipeline and returns structured findings, scores, evidence, and prioritized workstreams.

## Files to create or modify
- `src/retro/types.ts` — core retro/eval types: dimensions, findings, evidence, scores, recommendations, run input/output
- `src/retro/normalize.ts` — normalize evaluator findings into one schema and apply defaults
- `src/retro/score.ts` — compute per-dimension and overall scores from normalized findings
- `src/retro/plan.ts` — synthesize recommendations and proposed workstreams from findings
- `src/retro/run.ts` — RetroRunManager implementation and `runRetroEvaluation()` entrypoint
- `src/index.ts` — export retro/eval public API
- `tests/retro-run.test.ts` — red/green tests for run output, scoring, and planning
- `README.md` — document the new engine API after code is working

## Task 1: Add the first failing test for a complete retro run
- [ ] Step 1: Create `tests/retro-run.test.ts` with one minimal test that calls the new public API and expects:
  - one score per dimension
  - normalized findings in the result
  - at least one prioritized workstream
  - a summary string
- [ ] Step 2: Run `node --test tests/retro-run.test.ts`
Expected: FAIL because the retro API does not exist yet

## Task 2: Add core retro types
- [ ] Step 1: Create `src/retro/types.ts`
- [ ] Step 2: Define:
  - `RetroDimension`
  - `RetroEvidence`
  - `RetroFinding`
  - `RetroNormalizedFinding`
  - `RetroScore`
  - `RetroRecommendation`
  - `RetroWorkstream`
  - `RetroRunInput`
  - `RetroRunResult`
  - `RetroEvaluator`
- [ ] Step 3: Keep the first version small and explicit; no placeholder fields

## Task 3: Implement normalization
- [ ] Step 1: Create `src/retro/normalize.ts`
- [ ] Step 2: Add `normalizeFindings()` that fills defaults for confidence, severity, and evidence arrays
- [ ] Step 3: Re-run `node --test tests/retro-run.test.ts`
Expected: still FAIL, now because run manager is missing

## Task 4: Implement scoring
- [ ] Step 1: Create `src/retro/score.ts`
- [ ] Step 2: Add `scoreFindings()` that computes:
  - per-dimension score
  - overall score
  - score rationale
- [ ] Step 3: Use a simple severity-weighted deduction model for the first slice

## Task 5: Implement upgrade planning
- [ ] Step 1: Create `src/retro/plan.ts`
- [ ] Step 2: Add `planUpgrades()` that groups findings into:
  - fix_now
  - investigate_next
  - preserve_strengths
  - defer
- [ ] Step 3: Ensure each workstream includes title, dimension, priority, and finding references

## Task 6: Implement run orchestration
- [ ] Step 1: Create `src/retro/run.ts`
- [ ] Step 2: Add `runRetroEvaluation(input)` that:
  - executes evaluators
  - normalizes findings
  - computes scores
  - creates recommendations
  - returns `RetroRunResult`
- [ ] Step 3: Export the API from `src/index.ts`
- [ ] Step 4: Run `node --test tests/retro-run.test.ts`
Expected: PASS

## Task 7: Add focused coverage for scoring and workstream priority
- [ ] Step 1: Extend `tests/retro-run.test.ts` with a second test covering score deductions and workstream ordering
- [ ] Step 2: Run `node --test tests/retro-run.test.ts`
Expected: FAIL until the implementation matches the ordering and score behavior
- [ ] Step 3: Adjust implementation minimally until the test passes

## Task 8: Verify package-level safety
- [ ] Step 1: Run `npm test`
- [ ] Step 2: Run `npm run build`
Expected: PASS

## Task 9: Document the public API
- [ ] Step 1: Add a small README section showing `runRetroEvaluation()` usage
- [ ] Step 2: Keep the example engine-only and typed

## Test commands
- `node --test tests/retro-run.test.ts`
- `npm test`
- `npm run build`

## Notes
- Do not add persistence in this slice
- Do not add CLI commands in this slice
- Do not add LLM-specific evaluator implementations in this slice
- Keep the first version deterministic and easy to test
