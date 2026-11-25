# U3 T2: a harmless dry run of the decision inbox (`osstack decisions try`)

Status: design accepted. The owner accepted all five recommendations in §7 on 2026-11-24.
Plan: `docs/plans/2026-11-16-osstack-self-loop-upgrade.md`, U3 acceptance 6:
"一次无害试跑：发一张测试卡、回答、看到“已续办”，全程不触碰任何真实 Mission。"
Read on `main` at `4e18588c`.

## 1. What the dry run is for

The owner runs one command on the real host and sees the whole path work once,
without any real work depending on it:

1. a test card appears in `osstack decisions list`;
2. the configured notifier delivers a notice for it (local spool or the Grok Bot webhook);
3. the owner answers it with `osstack decisions answer`;
4. the waiting side sees the answer and reports "continued".

It checks the things unit tests cannot: the serving daemon is up, the
engineering credential works, the notifier is configured and reaches the chat,
and an answer finds its way back. It does not test `mission.decide` or any
other real source; those have their own tests (#539 for crash points).

## 2. What exists today

- `decisions.list` reads seven sources through `DecisionQueries`, one method per
  source (`packages/core/src/state/decision-queries.ts`), in the order of the
  `DecisionSource` enum (`packages/protocol/src/decisions.ts:3`).
- `decisions.answer` (`packages/cli/src/decisions/answer.ts`) authenticates the
  credential, checks the listed `source_revision`, and either forwards to the
  source command or, for Hermes, resolves and writes its receipt in one
  transaction (`answer.ts:77-99`).
- Notices for non-session sources come from `createDecisionNoticeSource`
  (`packages/cli/src/decisions/notices.ts`), which reads the same queries and
  feeds `AttentionExperience.enqueueExternal`. The sender is chosen by
  `OSSTACK_ATTENTION_NOTIFY=local|webhook`
  (`packages/cli/src/attention-webhook-delivery.ts:139-143`). Reminders are off
  unless `OSSTACK_ATTENTION_REMINDERS=1`; the first is due after 1800 s by
  default (`packages/core/src/state/attention-reminders.ts:18-25`).
- The webhook notice validates `decision.source` against a fixed list of the
  seven sources (`attention-webhook-delivery.ts:73`). The notice text says
  "Replying here does nothing; answer in osstack": there is no answer path
  from the chat back into osstack today, and this node adds none.
- Nothing can create a pending decision on demand. Every source needs real
  work behind it: a Mission, a chain, a Hermes run, an agent session.

## 3. Options for the test card

| | A. Its own source `probe` (recommended) | B. A fake Hermes approval | C. A fake session decision |
|---|---|---|---|
| Where the card lives | New table `decision_probes` | A made-up row in `runs`, an `approval.requested` event, a row in `approvals` | An `attention_items` row for a made-up session |
| Touches real sources | No | Writes the Hermes run ledger. Run lists, statistics and Hermes pulls would see a run that never existed. Event rows cannot be deleted afterwards. | The answer is sent as text into an agent session; needs a real or fake session adapter. |
| Real path exercised | List, notice, authentication, revision check, answer key, receipt | Same, plus the real `approval.resolve` | Same, plus the real `attention.answer` |
| Cost | One migration, one enum value, one case each in list, answer and the webhook check | No migration; reserved ids and filters in every reader of `runs` | Largest |
| "Harmless" holds because | The table is read by nothing else | Every other reader must learn to ignore the fake run | The fake session must never reach an adapter |

A is recommended: harmlessness holds by construction, not by filters added to
other readers. Its cost is a migration and a new value in a notice field that
the Grok Bot side also reads (§7 decision 2).

## 4. Design (option A)

### 4.1 State

New table `decision_probes` (migration 65), one row per test card:

`probe_id` (random, 32 hex), `state`, `revision` (integer, starts at 1),
`created_at`, `expires_at`, `created_by` (principal id), `answer`,
`answer_id`, `answer_digest`, `answered_by`, `answered_at`, `continued_at`.

```text
pending ──answer──► answered ──continue──► continued
   └── now ≥ expires_at: reads report it as expired; it leaves the pending list
```

- The card is fixed: summary `osstack test card: pick a colour. No work depends on it.`,
  answers `red`, `green`, `blue`. No caller-supplied text enters the card or the notice.
- `expires_at = created_at + 1 hour`. Expiry is computed at read time; no timer
  and no write. With the default 30-minute reminder delay a forgotten test
  card can cause a reminder before it expires; the implementation must count
  how many and the PR must state it.
- At most one unexpired `pending` card exists. A second `try` returns the
  existing card instead of creating another.
- `scope_id` is null: the card shows only in an unfiltered list, and its notice
  uses the scope `host`, like other unbound sources.

### 4.2 Commands and RPCs

| CLI | RPC | Writes |
|---|---|---|
| `osstack decisions try [--wait SECONDS] [--json]` | `decisions.try_create`, then polls `decisions.try_status`, then `decisions.try_continue` | Creates the card. With `--wait`, blocks until answered or timed out, then continues it. |
| `osstack decisions try status ID [--json]` | `decisions.try_status` | None. |
| `osstack decisions try continue ID [--json]` | `decisions.try_continue` | `answered → continued`, once. |
| `osstack decisions answer --source probe --id ID --answer blue --answer-id KEY --source-revision REV` | existing `decisions.answer` | `pending → answered` with the receipt, one transaction. |

All four need a valid engineering credential, like every answer today. No
scope is checked: the card belongs to no Mission scope. `try_create` and
`try_continue` are refused while the daemon is draining.

`try` prints the card id, its revision and the exact `decisions answer`
command to run. After the answer, `--wait` (or `try continue`) prints
`continued: you picked blue`. That line is the "已续办" of the acceptance text.

### 4.3 Answer

A new branch in `answerDecision`, shaped like the Hermes branch but writing
only its own table, inside one immediate transaction:

1. A row with this `answer_id` exists: same digest → `applied`, `replay: true`;
   other content → `conflict`, `answer_id_conflict`.
2. Not `pending` (answered, continued or expired) → `conflict`, `already_resolved`.
3. `source_revision` differs → `stale`, `stale_revision`.
4. Answer not one of the three colours, or any parameter given → `refused`, `invalid_answer`.
5. Otherwise set `state`, `answer`, `answer_id`, `answer_digest`, `answered_by`,
   `answered_at`, and `revision + 1` → `applied`.

The digest is the same HMAC construction as Hermes (`answer.ts:76`). There is
no asynchronous effect, so the outcome is never `unknown`.

### 4.4 Continue

`decisions.try_continue` is a compare-and-set `answered → continued` that
sets `continued_at`. A repeat returns the same result and writes nothing. A
card that is `pending` or expired is refused. It is a separate step from the
answer on purpose: the answer comes from the person, the continue from the
side that was waiting, the way a Mission resumes after its decision.

### 4.5 List and notice

- `DecisionSource` gains `probe` as the last value, so existing page order and
  cursors of the seven sources do not move. `DecisionQueries.probe()` selects
  unexpired `pending` rows. `decisionItem` returns the three answers,
  `answer_command` `decisions.answer`, `requires_local_signature: false`,
  `waiting_since = created_at`, `source_revision = revision`.
- The notice source already loops over every enum value, so the card gets a
  first notice and, where reminders are enabled, reminders until it expires. When it is answered
  or expires it leaves `pending()` and the existing closing logic applies.
- The webhook check adds `probe` to its source list. The notice keeps the
  existing reason `decision_pending` and its fixed text.
- `DecisionsListResult.failures` allows 8 entries instead of 7.

### 4.6 What it must not do

- No write to any table other than `decision_probes` and the attention
  delivery tables the notifier already owns. A test asserts row counts of the
  Mission, chain, Hermes, autonomy and loop tables are unchanged across a full
  dry run.
- No executor, container, GitHub call or repository read.
- No new remote answer path. The card is answered through the existing
  `decisions.answer`, with the existing credential rule.
- The card text and the notice contain no caller input.

## 5. Tests

1. Full run: create → listed once → notice enqueued once with source `probe`
   → answer → `try_continue` → `continued`; other tables unchanged.
2. Answer rules: replay, conflict on changed content, stale revision, invalid
   colour, parameters refused, no credential refused, second answer with a new
   key `already_resolved`.
3. Expiry: after `expires_at` the card is not listed, cannot be answered or
   continued, and a new `try` creates a fresh card.
4. One pending card: a second `try` returns the first.
5. Continue: refused while `pending`; idempotent after `answered`.
6. Restart: the same cases as #539 for a source with no asynchronous effect
   (P1, P2, P4), added to that file's matrix if #539 has merged.
7. Webhook notice builder accepts `probe`; a draining daemon refuses create and continue.
8. Migration: registered in the CLI read-only view and the native upgrade gate;
   full CLI suite.

## 6. Delivery

One PR: the enum value forces core, protocol and CLI to change together.
Estimated 350–450 lines with tests, plus a section in
`docs/guides/pending-decisions.md` and a changeset. The new core module must
stay out of the CLI's static start-up imports (budget in `AGENTS.md`).

After merge, the dry run on the serving host is a separate step by the owner:
the serving daemon has to be upgraded to a build that contains it. With
`OSSTACK_ATTENTION_NOTIFY=webhook` the first `try` sends one real notice to
the Grok Bot. That send needs the owner's go-ahead and is not part of the PR.

Not in this node: answering from the chat, T3 (`approval.resolve` status),
T4 (Autonomy sender), T5 (CI pilot release source).

## 7. Decisions for the owner

1. **Where the test card lives.** A (own source and table), B (fake Hermes
   approval) or C (fake session). Recommended: A.
2. **A new `source` value `probe` in the webhook notice.** The Grok Bot side
   will receive `decision.source: "probe"`. If its adapter rejects unknown
   sources it needs the same one-word change. Alternative: send no webhook
   notice for test cards at all, which would leave the notifier out of the dry
   run. Recommended: send it.
3. **Expiry of one hour and one pending card at a time.** Recommended: yes.
4. **Who may create a card.** Any valid engineering credential on the local
   socket, no scope. Recommended: yes.
5. **Continue as a separate step** (`--wait` or `try continue`) instead of
   marking the card continued inside the answer transaction. Recommended:
   separate.

**Record (2026-11-24).** The owner accepted the recommended option for all five: own source `probe`; the webhook notice is sent with `source: "probe"`; one-hour expiry and one pending card; any valid engineering credential may create a card; continue is a separate step.
