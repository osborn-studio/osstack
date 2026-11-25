# U3 T5: show the CI pilot release in the decision inbox

Status: design accepted. The owner accepted all five recommendations in §6 on 2026-11-24.
Plan: `docs/plans/2026-11-16-osstack-self-loop-upgrade.md`, U3 table row
"CI 试点放行 | 无状态，靠私有文件 | 负责人手工改文件" and acceptance 1 ("一个查询列出七类来源的全部未决条目").
Read on `main` at `46b642ee`.

## 1. What exists today

- **The production CI pilot is closed.** The runbook
  `docs/runbooks/bridge-ci-production-pilot.md` asks the owner to approve
  it; it has not been approved. It runs only in a separate daemon with its own
  `OSSTACK_HOME` and `OSSTACK_CONTAINED_CI_PILOT=shadow|live`.
- **The release is a file the owner writes by hand.**
  `$OSSTACK_HOME/bridge/ci-pilot-release.json` (0600, directory 0700): the
  SHA-256 of the profile file, `issued_at`, `expires_at` (at most 72 hours
  later), `principal_id`, `client_session_id`. There is no command that writes
  it. Removing it is the stop switch.
- **The host checks it on every write.** `ProductionCiPilot.permit`
  (`packages/cli/src/contained-mission-ci-pilot.ts:62-77`) reads the profile
  and the release on each admission, push, repair approval and merge. Missing,
  expired, too long, or bound to another profile → `CI_PILOT_NOT_AUTHORIZED`.
  At most five roots per scope ever bind (`:88-97`).
- **Nothing records the refusal.** An admission is refused before any row
  exists; a later write is refused inside a running chain, which then stalls.
  No source in `decisions.list` sees either, and no notice goes out.

So the owner only learns that the release expired by finding a stuck chain.

## 2. What a "pending decision" is here

There is no question with options; the decision is always one of
"issue a new release", "switch the daemon to shadow" or "stop". All of them
are host actions on the authorization for production writes. The owner
decided on 2026-11-17 that signature-bound decisions (revision grants, risk
approvals, task authorizations, autonomy approvals) get no remote answer
path. The release is not on that list; this design treats it the same way
because it authorizes the same kind of write (§6 decision 2). So this source is **visible and
notified, never answerable**: `requires_local_signature: true`, no allowed
answers, and `decisions.answer` returns `local_only`.

One item per pilot daemon, listed only while the daemon runs with
`OSSTACK_CONTAINED_CI_PILOT=live` and the bridge is not killed. Reasons:

| Reason | When | `waiting_since` |
|---|---|---|
| `release_missing` | No release file | `null` (no durable start) |
| `release_expired` | `now >= expires_at` | `expires_at` |
| `release_invalid` | Unreadable, wrong permissions, bound to another profile digest, or longer than 72 h | `null` |
| `release_expiring` | Valid, expires within 24 h, and at least one bound root is not closed | `expires_at - 24 h` |
| `slots_exhausted` | Five roots bound and all closed: the pilot run is over; the runbook asks the owner whether to widen it | latest close time |

At most one reason per item, in the order of the table. No item when the
release is valid and none of the last two apply.

## 3. Design

- **Read-only, derived at read time.** No table, no migration, no new event
  kind, no change to how the release authorises writes. A new method on
  `ProductionCiPilot`, `decisionRow(now)`, reads the profile, the release and
  the ledger exactly as `permit` and `bindNewRoot` already do, but returns a
  reason instead of throwing. It never writes and never calls GitHub.
- **Wiring.** `DecisionQueries` gets an optional provider for the new source
  (it stays SELECT-only for the other sources). The daemon passes
  `pilot.decisionRow` when a pilot is configured; the list, the answer router
  and the notice source all use the same queries object.
- **List item.** Source `ci_pilot`, id `ci_pilot:<scope_id>`, scope the
  pilot's scope, summary one fixed sentence per reason (no paths, no principal
  ids, no times in free text), `allowed_answers: []`,
  `requires_local_signature: true`, revision = digest of
  (reason, profile digest, release digest or `none`).
- **Answer.** `decisions.answer` for `ci_pilot` → `local_only` with
  `local_command: "mission ci-pilot-status"`. It writes nothing.
- **Read-only status command.** `osstack mission ci-pilot-status [--json]`
  on the pilot host: mode, reason, `expires_at`, roots used of five, roots
  not yet closed, and the exact field list of a release file. It never writes
  the release. The owner still writes it by hand per the runbook.
- **Notice.** The notice source already iterates the source enum, so the item
  is notified with the existing "needs a signature on the owner's own machine"
  text and, if reminders are on, reminded. The webhook source list gains
  `ci_pilot`.

## 4. Tests

1. Each reason from real files and a real ledger: missing, expired at the
   exact boundary, wrong mode, wrong profile digest, 73-hour release, expiring
   with an open root, expiring with all roots closed (no item), five closed
   roots, valid release (no item).
2. Shadow mode, bridge killed, no pilot configured → no item and no file read.
3. `decisionRow` writes nothing (row counts) and makes no network call.
4. List: item shape, scope filter, cursor across the new last source,
   `failures` allows nine entries.
5. Answer: `local_only`, no write, for every answer kind.
6. Notice: one notice per reason change; webhook builder accepts `ci_pilot`.
7. Status command output, human and JSON; no write.

## 5. Delivery

One PR: the source enum forces protocol and CLI to change together.
Estimated 250–350 lines with tests, a guide section and a changeset. It has
no effect on any host until the owner runs a pilot daemon in `live` mode,
which the runbook still has to approve.

## 6. Decisions for the owner

1. **Do it now, or wait until the production pilot is approved.** Now, the
   item appears on no host; it only matters once a pilot daemon runs `live`.
   Doing it now means the first live run already reports an expiring release
   instead of stalling silently. Recommended: now.
2. **Local only, read-only derived item (this design).** The release gets no remote answer path, like the signature-bound decisions. Alternatives: recording refusals as
   durable events (needs a migration, and an admission refusal has no Mission
   to attach to), versus a host command that writes the release (a new way to
   authorise production writes). Recommended: read-only derived.
3. **The five reasons in §2**, including `release_expiring` (24 h before
   expiry, only with an open root) and `slots_exhausted`. Recommended: all five.
4. **A new source value `ci_pilot`** in the list and in the webhook notice; the
   Grok Bot side sees it with the local-signature text. Recommended: yes.
5. **A read-only `osstack mission ci-pilot-status`** so the card names a real
   command. Recommended: yes; it never writes the release.

**Record (2026-11-24).** The owner accepted the recommended option for all five: build it now; local only, read-only and derived at read time (the release is treated like the signature-bound decisions and gets no remote answer path); all five reasons; the new source value `ci_pilot` in the list and the webhook notice; a read-only `osstack mission ci-pilot-status`.
