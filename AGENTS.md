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

## Security & Configuration Tips

Do not commit local Hermes paths, secrets, socket data, or generated databases. Keep machine-specific settings in environment variables such as `HERMES_HOME`. Treat `legacy-python/` as compatibility code: update it only when intentionally maintaining V1 shims.


<claude-mem-context>
# Memory Context

# [osstack/osstack-p21] recent context, 2026-07-19 5:04pm PDT

Legend: 🎯session 🔴bugfix 🟣feature 🔄refactor ✅change 🔵discovery ⚖️decision
Format: ID TIME TYPE TITLE
Fetch details: get_observations([IDs]) | Search: mem-search skill

Stats: 43 obs (19,916t read) | 3,753,802t work | 99% savings

### Jul 16, 2026
3658 11:18p ✅ osstack Local Repo Synced from GitHub Remote (fast-forward)
3659 11:20p 🔵 osstack Directory Not a Git Repo — Filesystem Permission Blocks Git Init on AIMATE_WORK
3660 11:23p 🔵 osstack Remote Repo Structure Confirmed — pnpm TypeScript Monorepo with 29 Root Entries
### Jul 17, 2026
3661 2:40a ✅ osstack Local Repo Synced to origin/main — PR #138 Hub Integration Phase 2b
3807 3:51p 🔵 osstack `neat` — Knowledge Hygiene Feature Design Document Initiated
3808 3:55p 🔵 osstack neat Design Document Created and Saved to Repo
3809 " 🔵 osstack Reusable Modules Audited for neat Implementation — ~30% Already Exists
3810 " ⚖️ osstack neat Authority File Conflict Resolved — AGENTS.md Canonical by Default
3811 " 🔵 Claude Code MEMORY.md Hard Limit Confirmed — 200 Lines or 25KB, Whichever First
3812 " 🔵 neat-freak Source Verified — MIT License, 282-line SKILL.md, 17.2k GitHub Stars
3813 " ⚖️ osstack neat Technical Architecture — Dual-Layer CLI + Skill, Four-Phase R0–R3 Roadmap
3815 4:00p ⚖️ OSStack `neat` — Knowledge Hygiene Feature Design Review Initiated
3816 4:02p ⚖️ ADR-002: osstack `neat` Governance Engine Ownership — Engine Lives in `@osstack/governance`, Not CLI
3817 " 🟣 osstack `neat` v2 — Full Executable Product and Technical Specification Written
3818 " ✅ Original `neat` Draft v1 Marked as Historical — Superseded by v2 Spec
3819 4:05p 🟣 osstack `neat` Per-PR Implementation Plan Written — 5 Phases, 13 PRs, 1350 Lines
3820 " 🔴 Trailing Blank Line at EOF Fixed in `neat` v2 Spec — Caught by `git diff --check`
3844 4:36p 🟣 osstack neat 全阶段实施目标已创建
3845 4:39p 🟣 osstack neat P0 docs committed to codex/neat-implementation branch
3846 " 🔵 osstack neat spec v2 — full CLI contract, domain schemas, and rule catalog confirmed
3847 " ⚖️ ADR-002 — Neat engine in @osstack/governance, thin CLI surface
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

Access 3754k tokens of past work via get_observations([IDs]) or mem-search skill.
</claude-mem-context>
## Control-plane DB discipline (Phase 2.1-B, incidents 2026-07-18/19)

NEVER invoke `packages/cli/dist/bin.js` (or any osstack CLI) against the
default (`~/.osstack`) or a reserved OSSTACK_HOME from a development checkout —
opening the DB auto-migrates it. The guard now refuses this at runtime for both
`serve` AND direct-DB commands (loop run, daily, agent scorecard, stack, …).
Always set an explicit per-workspace `OSSTACK_HOME` (see the ihiking wrapper
`tools/osstack/osstack.sh` for the reference pattern), or use the installed
`osstack` shim which targets the declared serving home.
