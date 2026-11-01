# Repository Guidelines

## Project Structure & Module Organization

This is a pnpm TypeScript monorepo for OSBORN stack. Primary source lives in `packages/*/src`, with each package owning its own `package.json` and `tsconfig.json`. Key packages include `packages/cli` for the `osstack` binary, `packages/core` for orchestration and state, `packages/agents` for agent adapters, and `packages/hermes-adapter` for Hermes integration. Tests are colocated with source as `*.test.ts`. Documentation lives in `docs/`, helper scripts in `scripts/`, Hermes skill files in `hermes-skill/`, the reusable Loop Engineering Codex skill in `loop-engineering/`, and preserved V1 Python code in `legacy-python/`.

## Build, Test, and Development Commands

- `corepack enable pnpm`: enables the expected pnpm version.
- `pnpm install`: installs workspace dependencies from `pnpm-lock.yaml`.
- `pnpm build`: builds every workspace package with `tsc` or `tsup`.
- `pnpm test`: runs all package test suites with Vitest.
- `pnpm typecheck`: runs strict TypeScript checks across packages.
- `pnpm dev`: starts the CLI package in `tsup --watch` mode.
- `pnpm --filter @osstack/core test`: runs one package test suite.

The root `lint` script delegates to packages, but package lint scripts are not currently defined.

## Coding Style & Naming Conventions

Use TypeScript ESM and keep exports explicit through package `src/index.ts` entrypoints. Follow the strict compiler settings in `tsconfig.base.json`: no implicit `any`, no unused locals or parameters, exact optional properties, and checked indexed access. Use two-space indentation, `camelCase` for functions and variables, `PascalCase` for types/classes, and kebab-case filenames such as `status-fsm.ts`. Keep package boundaries clear; prefer workspace imports like `@osstack/core` over deep cross-package paths.

## Testing Guidelines

Vitest is the test runner. Place tests beside the code they cover using `*.test.ts`, for example `packages/core/src/policy/engine.test.ts`. Add focused tests for new routing, policy, state, adapter, and parser behavior. Run `pnpm test` before opening a PR, and use `pnpm --filter <package> test` while iterating.

## Commit & Pull Request Guidelines

Recent history follows Conventional Commits, for example `feat(loop): add loop engineering foundation` and `feat: OSStack standalone product + role-based agent configuration`. Use a concise imperative subject and include a scope when it clarifies the affected package. Pull requests should describe the change, list validation commands run, link related issues or docs, and include screenshots only for user-visible CLI, dashboard, or Hermes-facing behavior.

## Branch & Worktree Lifecycle

- Open every PR against `main`. Do not stack PRs on another feature branch: when a base branch is merged without deleting it, the PRs on top merge into that branch and never reach `main` (#178–#184, #326, #327).
- Delete the feature branch, remote and local, as soon as its PR is merged or closed. Remove its worktree in the same step (`git worktree remove`, then `git worktree prune`).
- Worktrees live under `~/Developer/CodeX/.worktrees/osstack/<task>`, never beside the repository or on the internal disk.
- Before deleting a branch that is not an ancestor of `main`, show that its work is in `main` (`git cherry origin/main <branch>` has no `+` lines, or its merged PR's merge commit is in `main`) or list it for the owner to confirm. Do not infer that a branch is abandoned from its name.
- `main` and `changeset-release/main` (owned by the release workflow) are never deleted.
- `main` protection dismisses approvals whenever `main` moves. Approve and merge one PR at a time.

## Performance Budgets

Startup and latency budgets (from `docs/design/2026-08-12-performance-hints-improvement-plan.md`, after Dean & Ghemawat's Performance Hints). CI enforces the first two via the "CLI startup budget" step (`scripts/bench-cli-startup.mjs`); check the rest with `osstack stats` (rpc section).

- `osstack --version` < 150ms local / 250ms CI — served by `cli-entry.ts` without loading the command surface.
- `osstack --help` (full command surface) < 500ms local / 900ms CI.
- Daemon local socket RPC p95 < 10ms per method for non-streaming calls.
- Loop tick overhead < 1% of session wall-clock.

Before adding a top-level import to `packages/cli/src/cli-entry.ts`, `bin.ts`, or any `@osstack/*` package's index: measure its load cost (`node --input-type=module -e "const t=performance.now(); await import('<dep>'); console.log(performance.now()-t)"`). Anything over ~20ms that isn't needed by every invocation should be a lazy `await import()` at its use site — the eager-import class of regression cost 100ms+ per offender when the plan landed.

## Security & Configuration Tips

Do not commit local Hermes paths, secrets, socket data, or generated databases. Keep machine-specific settings in environment variables such as `HERMES_HOME`. Treat `legacy-python/` as compatibility code: update it only when intentionally maintaining V1 shims.


## Control-plane DB discipline (Phase 2.1-B, incidents 2026-07-18/19)

NEVER invoke `packages/cli/dist/bin.js` (or any osstack CLI) against the
default (`~/.osstack`) or a reserved OSSTACK_HOME from a development checkout —
opening the DB auto-migrates it. The guard now refuses this at runtime for both
`serve` AND direct-DB commands (loop run, daily, agent scorecard, stack, …).
Always set an explicit per-workspace `OSSTACK_HOME` (see the ihiking wrapper
`tools/osstack/osstack.sh` for the reference pattern), or use the installed
`osstack` shim which targets the declared serving home.

## Prompt and explanation language

Use the ASD-STE100-inspired authoring policy in [docs/guides/prompt-language.md](docs/guides/prompt-language.md) for new prompts, CLI help, and user explanations. Use short sentences, explicit actions, consistent terms, and separate conditions from actions and results. Preserve command names, flags, paths, schema keys, authorization requirements, and the user's meaning. Apply the same clarity principles to Chinese. Do not claim full STE compliance or runtime enforcement without evidence.


<claude-mem-context>
# Memory Context

# [osstack/readme-links] recent context, 2026-11-01 2:32am PST

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 50 obs (25,302t read) | 3,514,702t work | 99% savings

### Jul 17, 2026
3845 4:39p 🟣 osstack neat P0 docs committed to codex/neat-implementation branch
3846 " 🔵 osstack neat spec v2 — full CLI contract, domain schemas, and rule catalog confirmed
3848 4:41p 🟣 R0.1 TDD — types.ts and fingerprint.ts created for knowledge-hygiene domain
3849 " 🔵 @osstack/protocol unbuilt — Vite cannot resolve workspace package without dist/
3850 4:44p 🟣 R0.1 domain contracts GREEN and committed; R0.1.2 config test RED
3969 11:45p ⚖️ probe Tool — 8 Architecture Decisions Finalized in v1.1 Design Document
3970 " ✅ probe Design Doc v1.1 — Two Incremental Additions from Thariq Source Text
3971 11:48p ✅ probe Design Document Rewritten v1.1→v2.0 as Implementation-Ready Executable Spec
3972 " ⚖️ probe Engine Architecture — Governance Package, Core Persistence, CLI Adapter Only
3973 " ⚖️ probe Portable Ledger Dual-Authority Model — SQLite Active, JSON/Markdown Portable
3974 " ⚖️ probe CLI Write Safety — Idempotency Keys, question_id, if_revision on All Writes
3975 " ⚖️ probe Session State Machine — paused/completed/abandoned Semantics Corrected
3976 " ⚖️ probe Gate — Separate .osstack/probe.yaml from .osstack/policy.yaml
3977 " 🔵 Thariq Source Article Audit — No "90-day Study" or "≥70% ROI" Claims in Original Text
### Jul 18, 2026
4017 12:58a ⚖️ probe Tool — 8 Architecture Decisions Locked in v1.1 Design Doc
4039 1:51a ⚖️ probe Tool — 8 Architecture Decisions Locked via Self-Applied Probe Methodology
4040 " ⚖️ probe Design Doc v1.1 — Adversarial Review + Executable Spec Transformation Mandated
4041 1:54a 🟣 probe add + probe restate — Evidence-Bound Dynamic Finding Registration
4042 " 🟣 probe-skill — Four-Quadrant Elicitation Codex Skill with Blindspot Playbook and Restate Contract
4043 " 🟣 probe compile — Closed-Registry EvaluationSpec Delta Compiler
4044 2:10a 🟣 R3.2 Marked Complete — Changeset and Design Doc Updated
4045 " 🟣 deepseek.test.ts — `OSSTACK_IMPLEMENTATION_DEVIATIONS` Protocol Line Added (Patch Failed)
4046 2:13a 🟣 R3.2 Full Test Suite Green and Committed to Branch
4047 " 🔵 R3.3 Kanban Guard Target — `stackMove` in stack-cli.ts Calls `repo.moveCard` Directly
### Jul 27, 2026
5529 9:07a 🟣 Kimi Autonomy Plan — Five-Phase Adversarial Audit Completed with 1 Critical + 17 High Findings
5530 " ✅ Kimi Autonomy — Three Deliverable MDs Created for Codex Handoff
5531 " ⚖️ Kimi Autonomy Security Model — Five Invariant Gaps Identified as Pre-Implementation Blockers
5532 9:10a 🔵 osstack Repository Facts Verified at Commit 4981378 — Audit Claims Confirmed Against Real Source
5533 " ⚖️ osstack Kimi Autonomy — Execution Document Architecture Chosen for Codex Handoff
5534 9:13a 🔵 Code-Level Evidence for Five Audit Findings Confirmed via Git Grep at Commit 4981378
5535 9:18a 🟣 Kimi Mac Mini Autonomy Plan — Adversarial Audit Completed by 5-Agent Parallel Review
5536 " 🔵 Critical Security Gap — Reviewer Write-Detection Misses `.git/hooks` and Gitignored Paths
5537 " 🔵 Five High-Severity Bypass Chains in Kimi Autonomy Plan — State Machine Lock, TOCTOU, Supply Chain, Identity Forgery, Untracked Files
5538 " 🔵 Three Operability Gaps That Will Break 7-Day Soak — Sleep, Task Supply, Notification Channel
5539 " 🔵 Privacy Scan False-Negative — `gilbertchen` Username Zero-Matches; Real Owner Identifiers Not Covered
5540 " ✅ Kimi Autonomy Master Plan v2 — Five New Invariants and Hardened Promotion Gates
5541 " ⚖️ Codex Execution Strategy — Three-Batch Fix Order with Adversarial Engagement Rules
5542 9:22a 🟣 Four Kimi Autonomy Execution Control Documents Created and Validated in osstack Repo
5543 " 🔵 GitHub Branch Protection Requires Two Separate API Queries — Legacy Endpoint + Rulesets Endpoint
5544 9:41a ⚖️ OSStack Multi-Phase Dev Sprint Plan — 5-Step TDD + Worktree Execution Strategy
5545 9:44a 🟣 osstack-kimi-autonomy-docs Worktree Created — Docs Audit Branch Initialized
5546 " ✅ Kimi Autonomy Docs Consolidated — 7 Files Migrated into osstack-kimi-autonomy-docs Worktree
5547 " 🔵 Kimi Autonomy Phase A–E Architecture — Full 5-Phase Implementation Plan Suite Discovered
5548 " ✅ All Phase Plans Amended — $OSSTACK_WORKTREES_ROOT Portability Fix + v3 Execution Headers Added
5549 9:47a ✅ v3 Mandatory Amendments Applied — 28 Security Hardening Sections Added Across 5 Phase Plans
5550 " ✅ v2 Master Plan Invariants 16–20 Hardened + Design Spec §20 v3 Security Errata Added
5551 " 🔵 osstack v0.12.0 Released — Origin/Main Advanced from Planning Baseline, Phase A Worktree Must Re-Verify
5552 10:20a 🟣 Task 4 COMMITTED — KimiCodeAdapter merged to feat/kimi-adapter-verifier
5553 " 🔵 Task 5 Spec — Review Boundary Gate in packages/governance + packages/loop
5554 10:22a 🟣 Task 5 — evaluateReviewBoundary implemented in @osstack/governance, all 9 tests GREEN

Access 3515k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>