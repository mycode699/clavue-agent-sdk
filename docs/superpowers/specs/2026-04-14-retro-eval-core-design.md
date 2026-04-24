# Retro/Eval Core Design

Date: 2026-04-14
Topic: engine-only retro/eval loop for clavue-agent-sdk
Status: approved in chat

## Goal
Add an engine-level retro/eval core that can run repeated full evaluations of a target codebase and produce structured findings plus an upgrade plan.

## Scope
This first sub-project is engine-only. It does not add a CLI workflow yet.

## Architecture
The SDK gains a run-oriented retro/eval core.

Input:
- target repo/app context
- evaluation focus
- model/tool budget
- evaluation dimensions

Pipeline:
1. inspect current state
2. run evaluators
3. normalize findings
4. score by dimension
5. decide keep/discard/promote
6. synthesize upgrade plan

Output:
- summary
- scores
- findings
- recommendations
- proposed_workstreams
- evidence
- run_metadata

Default dimensions:
- compatibility
- stability
- interaction logic
- reliability

## Core components
- RetroRunManager: owns one evaluation run end-to-end
- Evaluators: dimension-focused analyzers
- FindingNormalizer: converts evaluator output into a uniform schema
- ScoringEngine: produces explainable scores
- UpgradePlanner: turns findings into prioritized workstreams
- RunLedger: persists run snapshots for comparison over time

## Design principles
- Separate observation, judgment, prioritization, and persistence
- Keep the first version typed and composable
- Prefer explainable scores over opaque single-pass prose
- Make later CLI workflows a thin layer over stable SDK contracts

## First implementation slice
Implement a minimal typed retro/eval core that can:
- accept structured input
- execute evaluator functions
- normalize and aggregate findings
- compute dimension and overall scores
- synthesize a structured upgrade plan
- return a single typed run result

Persistence, richer evaluators, and CLI workflow come later.
