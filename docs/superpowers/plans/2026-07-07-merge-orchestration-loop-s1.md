# Merge-Orchestration Closed Loop — S1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL on approval: superpowers:subagent-driven-development
> or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
> **Status: DRAFT — awaiting approval. Do not implement yet.**

**Goal:** Give osstack a reusable closed loop for merging a stacked PR chain —
ingest a GitHub PR stack into typed kanban cards, drive them through
verification gates with a recorded event trail, then write a retrospective and
update self-iteration memory that improves future routing. First fixture: the
Knowledge Layer stack (#47 → #48 → #49 → #50 → #52 → #53 → #55 → #56).

**Architecture:** Extend osstack's existing kanban + state + loop packages; do
**not** build a new system. The card model, per-card event log, dependency
links, retrospective drafter, and SQLite memory already exist. S1 adds: a card
**type** discriminator, a **verification checklist**, **PR-stack ingestion**
from `packages/github`, a **runbook** generator, a **stack retrospective**, and
a memory-backed **routing recommendation** — all surfaced by one new
`osstack stack` CLI command group.

**Tech Stack:** TypeScript, pnpm monorepo, `better-sqlite3`, Zod, `gh` CLI
(via existing `packages/github`), vitest.

---

## 0. What already exists (extend, do not rebuild)

Grounding from a read of the repo — S1 must reuse these:

| Need | Already in osstack | File |
|------|--------------------|------|
| Card model + board columns (triage/todo/ready/running/blocked/done/archived) | `CardRow`, `BOARD_COLUMNS`, `isLegalCardTransition` | `packages/core/src/kanban/schema.ts` |
| Card ops + **event emission** on create/move/block/complete | `KanbanRepository.createCard/moveCard/emit` | `packages/core/src/kanban/repository.ts` |
| **Per-card event log** with monotonic id + incremental replay | `kanban_card_events`, `readEventsSince` | `migrations.ts` (#kanban), `repository.ts` |
| **Dependency links** (parent/child) | `kanban_card_links` | `migrations.ts` |
| Comments | `kanban_card_comments`, `CardCommentRow` | schema/migrations |
| SQLite engine + migrations + `withWrite` tx | `openDb`, `runMigrations` | `packages/core/src/state/db.ts`, `migrations.ts` |
| **Retrospective drafter** (success-after-failure lessons) | `shouldDraftLesson`, `renderLessonDraft`, `writeLessonDraft` | `packages/loop/src/lesson-draft.ts` |
| **Self-iteration memory** (facts, pitfall lessons, improvement proposals) | `writeFact`/`readFactsForSubject`, `upsertPitfallLesson`, `upsertImprovementProposal` | `packages/core/src/state/{memory,lessons,improvement-proposals}.ts` |
| **GitHub branch/PR awareness** (checks state, mergeable, PR intents) | `branch-scanner`, `branch-scorer`, `report` | `packages/github/src/` |
| Agent adapters (Claude / Codex / design / verify) | `claude-cli`, `claude-code`, `codex-cli`, `claude-design`, `ds-verify` | `packages/agents/src/adapters/` |
| Deterministic recommendations surface | `deriveRecommendations` | `packages/supervisor/src/` |
| CLI framework + per-command modules + `bin.ts` | `pr-cli`, `loop-cli`, `lessons-cli`, `governance-cli`, `dashboard` | `packages/cli/src/` |

**Implication:** the two big-ticket items the user listed (Event Log; Closed
Loop retrospective) are ~90% present. S1 wires them to the merge use case.

---

## 1. S1 scope (MVP) and out-of-scope

**In (smallest useful loop):**
1. Typed cards: add `card_type ∈ {pr, implementation, review, merge}` + a JSON `meta`.
2. Verification checklist per card (gate items with pass/fail).
3. `osstack stack ingest <base..head | --prs a,b,c>` → creates one `pr` card per
   PR, links dependencies from base/head chain, attaches a per-type checklist,
   records `ingested` events.
4. `osstack stack board` → shows the merge board (reuse dashboard rendering).
5. `osstack stack move <card> <status>` → moves a card (reuses `moveCard`; events emitted).
6. `osstack stack check <card> <item> --pass|--fail` → ticks a gate item, emits event.
7. `osstack stack runbook` → generates the bottom-up merge runbook from the card DAG.
8. `osstack stack retro` → on stack completion, writes a retrospective (what
   worked/failed, which checks caught issues) via `lesson-draft` + persists a
   memory fact + optional improvement proposal.
9. `osstack stack timeline [--card X]` → replays `kanban_card_events` into an ordered timeline.
10. `osstack stack recommend <card>` → reads memory to suggest agent (Claude vs
    Codex), role (code/review/merge-manager), browser-QA yes/no, full-vs-targeted tests.

**Out (deferred past S1):**
- Auto-merging via the GitHub API (S1 only *drives* and *records*; humans click merge).
- Live CI polling daemon / webhooks (S1 pulls state on `ingest`/`refresh`, not continuously).
- Auto-executing agents from cards (routing is a *recommendation*, not auto-dispatch).
- Multi-repo / multi-stack concurrency, tenant scoping beyond the existing `tenant_id`.
- Rewriting `packages/github` scanner; S1 adds a thin `stack.ts` beside it.
- A web/TUI board beyond reusing the existing dashboard text render.

---

## 2. Card / task model (item 1)

Cards stay in `kanban_cards`; add two additive columns and a checklist table.

- **`card_type`** `TEXT NOT NULL DEFAULT 'implementation'` — one of
  `pr | implementation | review | merge`.
- **`meta`** `TEXT` (JSON, nullable) — type-specific fields. For `pr`:
  `{ pr_number, base_ref, head_ref, ci_state, mergeable, merge_state, url }`.
- **Blocked** already modeled: `status='blocked'` + `blocked_reason` (reuse).
- **Owner/agent** already modeled: `assignee` (reuse; `recommend` fills it).
- **Dependencies** already modeled: `kanban_card_links(parent_id, child_id)`.
  A stacked PR's card links to the PR below it (child depends on parent).

**Verification gates** → new table `kanban_card_checks`:
```
card_id TEXT, idx INTEGER, label TEXT, state TEXT('pending'|'pass'|'fail'),
detail TEXT NULL, updated_at INTEGER   -- PK (card_id, idx)
```
Per-type default checklists (seeded on ingest), e.g. `pr` card:
`[mergeable/clean, CI green, migration applied (if any), endpoint/UI smoke, suite green]`.

**Zod:** extend `CardRow` with `card_type` + `meta`; add `CardCheckRow`. Keep
`isLegalCardTransition` unchanged (permissive board).

---

## 3. Event log + replay (item 2)

**Reuse** `kanban_card_events` + `KanbanRepository.emit`. `createCard`/`moveCard`
already emit. S1 additions are just new event *kinds* recorded via `emit`:
- `ingested` (payload: pr_number, base, head)
- `linked` (payload: parent, child)
- `check` (payload: item idx/label, from→to state)
- `ci` (payload: ci_state, mergeable — recorded on `refresh`)
- `runbook_generated`, `retro_written` (payload: path)

**Replay/timeline**: a pure function `renderTimeline(events, opts)` that orders
by `event_id` (monotonic) and formats one line per event; `stack timeline`
prints it. No schema change — replay is reading the append-only log.

---

## 4. Closed loop retrospective (item 3)

On `stack retro` (or auto when all cards reach `done`):
1. Read the stack's cards + their `kanban_card_events` + `kanban_card_checks`.
2. Compute: which checks failed at least once (caught issues), attempts per card
   (moves back out of `running`/`blocked`), which assignee/agent each card used.
3. Render a retro doc via a new `renderStackRetro(input)` that reuses the
   structure of `renderLessonDraft` (what worked / what failed / which checks
   caught bugs / what to change next time).
4. Persist outcomes:
   - a **memory fact** per stack (`writeFact` subject `merge-orchestration`):
     e.g. "browser QA caught the empty-switcher bug in the UI card".
   - optionally an **improvement proposal** (`upsertImprovementProposal`) when a
     gate was missing (e.g. "add build-check gate before UI review").

This closes plan → … → retrospective → memory in the existing machinery.

---

## 5. Self-iteration memory + routing (item 4)

**Storage:** reuse `packages/core/src/state/memory.ts` (facts) and
`lessons.ts` (pitfalls). No new store.

**`recommend(card, deps)` — pure, deterministic:** reads facts/lessons for
subject `merge-orchestration` (and the card's `card_type`) and returns:
```ts
interface RoutingHint {
  agent: "claude-code" | "codex-cli";      // adapter id (existing registry)
  role: "code" | "review" | "merge-manager";
  browserQa: boolean;
  tests: "targeted" | "full";
  reasons: string[];                        // cited from memory facts/lessons
}
```
S1 rules (seeded, then overridable by learned facts):
- `pr`/`merge` card → role `merge-manager`, `tests: full` before a migration-bearing
  merge, `targeted` otherwise; `browserQa` if any linked card is `card_type` UI
  (meta has `ui:true`).
- `review` card touching UI → `browserQa: true`.
- agent default `claude-code`; a learned fact "codex better at X" flips it for that card_type.
The output only *recommends* (writes `assignee` on request); never auto-dispatches in S1.

---

## 6. GitHub / PR-stack support (item 5)

**New file** `packages/github/src/stack.ts` (beside the scanner, reusing its
`gh`/git helpers and `checksState`/`mergeable` types):
- `ingestStack(spec): StackModel` — given explicit PR numbers **or** a
  base..head chain, calls `gh pr view <n> --json number,state,baseRefName,headRefName,mergeable,mergeStateStatus,statusCheckRollup`
  for each, and derives the dependency DAG from base↔head (child.base === parent.head).
- `detectDrift(stack): DriftReport` — flags a PR whose base tip is **not** an
  ancestor of its head (drift), any `CONFLICTING`/`DIRTY` mergeStateStatus, or a
  failing/pending CI rollup.
- Pure model types in `packages/github/src/types.ts` (`StackNode`, `StackModel`, `DriftReport`).

The `stack ingest` CLI maps `StackModel` → cards (`card_type='pr'`, meta filled)
+ `kanban_card_links` + per-type checklist, then a `stack refresh` re-pulls
CI/mergeable and updates card `meta` + `blocked` state (emitting `ci` events).

---

## 7. Data schema (additive migration)

New migration appended in `packages/core/src/state/migrations.ts` (idempotent,
`IF NOT EXISTS`, no drops):
```sql
-- migration: kanban_typed_cards
ALTER TABLE kanban_cards ADD COLUMN card_type TEXT NOT NULL DEFAULT 'implementation';
ALTER TABLE kanban_cards ADD COLUMN meta TEXT;            -- JSON, nullable
CREATE INDEX IF NOT EXISTS idx_kanban_cards_type ON kanban_cards(board, card_type);

CREATE TABLE IF NOT EXISTS kanban_card_checks (
  card_id    TEXT    NOT NULL,
  idx        INTEGER NOT NULL,
  label      TEXT    NOT NULL,
  state      TEXT    NOT NULL DEFAULT 'pending',  -- pending | pass | fail
  detail     TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (card_id, idx)
);
CREATE INDEX IF NOT EXISTS idx_kanban_checks_card ON kanban_card_checks(card_id);
```
`ALTER TABLE ADD COLUMN` on SQLite is safe/idempotent when guarded by the
migration version ledger (osstack migrations run once by name/number).

---

## 8. CLI commands (item 6 surface)

New `osstack stack` group in `packages/cli/src/stack-cli.ts`, wired in `bin.ts`:
```
osstack stack ingest  --prs 47,48,49,50,52,53,55,56 [--repo o/r] [--board kl-merge]
osstack stack ingest  --chain main..feat/…workspace-list-filter
osstack stack refresh [--board kl-merge]        # re-pull CI/mergeable → update cards
osstack stack board   [--board kl-merge]        # render the merge board
osstack stack move    <card> <status> [--reason …]
osstack stack check   <card> <idx> --pass|--fail [--detail …]
osstack stack runbook [--board kl-merge]        # bottom-up merge runbook (stdout/md)
osstack stack timeline [--board kl-merge] [--card <id>]
osstack stack recommend <card>                  # routing hint (prints RoutingHint)
osstack stack retro   [--board kl-merge]        # write retrospective + memory fact
```
All read/write the same SQLite state DB used by the rest of osstack.

---

## 9. Task breakdown (bite-sized, TDD — execute after approval)

> Full copy-paste code is intentionally deferred to execution (per the approval
> gate). Each task lists exact files, the test to write first, and the behavior.

- **Task 1 — Schema/migration.** Files: `state/migrations.ts` (+migration),
  `kanban/schema.ts` (extend `CardRow`, add `CardCheckRow`).
  Test first: `state/db.test.ts` — new DB has `card_type` default + `kanban_card_checks`.
- **Task 2 — Repository typed cards + checks.** Files: `kanban/repository.ts`.
  Tests: `kanban/kanban.test.ts` — `createCard({card_type,meta})` round-trips;
  `setCheck(card,idx,state)` emits a `check` event; `listChecks` reads them.
- **Task 3 — Dependency helpers.** Files: `kanban/repository.ts`.
  Tests: `linkDependency(parent,child)` + `topoOrder(board)` returns bottom-up order;
  cycle → throws.
- **Task 4 — GitHub stack model.** Files: `github/src/stack.ts`, `types.ts`.
  Tests: `stack.test.ts` — `ingestStack` builds the DAG from mocked `gh` JSON;
  `detectDrift` flags conflicting/failing/ancestry-broken nodes. (Mock `gh` like `report.test.ts` does.)
- **Task 5 — Ingest command.** Files: `cli/src/stack-cli.ts` (ingest), `bin.ts`.
  Tests: `stack-cli.test.ts` — ingest of a fixture stack creates N `pr` cards,
  N-1 links, seeded checklists, and `ingested` events.
- **Task 6 — board / move / check / timeline.** Files: `cli/src/stack-cli.ts`.
  Tests: board lists cards by lane; `move` respects legal transitions + emits;
  `timeline` replays events in monotonic order.
- **Task 7 — runbook generator.** Files: `cli/src/stack-cli.ts` (or `github/src/runbook.ts`).
  Test: `renderRunbook(stack)` emits the bottom-up order + per-card verify block
  + retarget/rollback notes (assert on structure, snapshot-light).
- **Task 8 — recommend.** Files: `cli/src/stack-cli.ts` + small `routing.ts`.
  Tests: default rules; a seeded memory fact flips the agent for a card_type.
- **Task 9 — retro + memory.** Files: `loop/src/stack-retro.ts` (reuse lesson-draft
  helpers), `cli/src/stack-cli.ts` (retro).
  Tests: retro cites which checks failed; `writeFact` persisted; idempotent re-run.
- **Task 10 — Dry-run fixture.** Files: `cli/src/stack-cli.dryrun.test.ts` + a
  `fixtures/knowledge-layer-stack.json` (the 8 PRs' `gh` JSON captured).
  Test: end-to-end ingest → board → runbook → (simulated) checks → retro, all
  offline against the fixture (no live `gh`).

---

## 10. Test plan (item 7)

- **Card lifecycle:** create typed card → move through lanes → blocked+reason →
  done; assert events + legal-transition enforcement.
- **Event append/replay:** N ops produce N monotonic events; `renderTimeline`
  is deterministic; replay reconstructs final card states.
- **Dependency ordering:** `topoOrder` returns bottom-up (#47…#56); cycle throws;
  a child can't be "done"-gated before its parent (advisory check, not a hard block in S1).
- **Drift/CI:** `detectDrift` flags conflicting/failing/ancestry-broken nodes on
  mocked `gh` JSON.
- **Retro/memory:** retro names the check that caught a bug; memory fact written & re-readable.
- **Dry run:** the offline Knowledge Layer fixture drives the whole loop; assert
  the generated runbook matches the known-good order and gates.
- **Regression:** `pnpm test` (workspace) stays green; `pnpm typecheck`, `pnpm lint` clean.

---

## 11. Risks

| Risk | Mitigation |
|------|-----------|
| Duplicating existing kanban/loop primitives | Plan is explicitly extension-only (§0 table); no new store, no scanner rewrite. |
| SQLite `ALTER TABLE ADD COLUMN` on an existing DB | Guarded by osstack's run-once migration ledger; additive, no drop. |
| `gh` shape/rate variance during ingest | Ingest is pull-once; fixture-based tests are offline; `refresh` is explicit, not a daemon. |
| Routing recommendation over-reaching (auto-dispatch) | S1 only *recommends* + optionally sets `assignee`; never launches an agent. |
| Scope creep into auto-merge / webhooks | Explicitly out-of-scope (§1); S1 records + drives, humans merge. |
| Fixture drift from the real PRs | Dry-run uses a captured JSON snapshot, versioned in `fixtures/`. |

## 12. Out of scope for S1 (restate)

Auto-merge; CI webhook/daemon; auto-agent dispatch; multi-stack concurrency;
web/TUI board; `packages/github` scanner rewrite; many-to-many card→repo;
non-GitHub forges. These land in S2+ only if S1's fixture proves the loop.

---

## Self-review

- **Spec coverage:** items 1–7 each map to a section (1→§2, 2→§3, 3→§4, 4→§5,
  5→§6, 6→§1/§8, 7→§10) and to tasks 1–10. ✓
- **Grounding:** every reused primitive cites a real file (§0). ✓
- **No auto-implement:** tasks defer full code to execution behind the approval gate. ✓
- **Fixture:** the Knowledge Layer stack is the dry-run fixture (Task 10). ✓
