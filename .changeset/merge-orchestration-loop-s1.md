---
"@osstack/core": minor
"@osstack/github": minor
"@osstack/loop": minor
"@osstack/cli": minor
---

Merge-orchestration closed loop (S1). A new `osstack stack` command family turns a
stack of GitHub PRs into a driveable, self-reflecting workflow — extension-only over
the existing kanban/loop/github/cli primitives.

- `@osstack/core`: additive migration #7 — typed kanban cards (`card_type`, `meta`)
  plus a `kanban_card_checks` table; repository gains typed-card + checklist ops
  (`putCheck`/`setCheckState`/`listChecks`), dependency links, and deterministic
  bottom-up `topoOrder` (cycle throws). Existing kanban/event/memory semantics are
  backward-compatible (new columns default; event `kind` stays free-form).
- `@osstack/github`: `stack.ts` — `ingestStack` (read-only `gh pr view` → dependency
  DAG) and `detectDrift` (conflicting/ci_failing/ci_pending/not_mergeable/orphan_base).
- `@osstack/loop`: pure `renderStackRetro` — a retrospective that cites which checks
  caught issues and derives missing-gate suggestions.
- `@osstack/cli`: `stack ingest|board|move|check|timeline|runbook|recommend|retro`,
  memory-backed routing recommendation, and an offline dry-run fixture.

S1 records and drives; humans still merge. No auto-merge, no auto-agent-dispatch, no
CI webhook/daemon.
