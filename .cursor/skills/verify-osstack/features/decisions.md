# Pending decisions

An owner asks the daemon "what is waiting on me?" with `osstack decisions list`, which reads every pending owner decision (Session attention, contained Mission, CI repair, revision chain, CI pilot release, Autonomy, Hermes approvals/clarifies, loop escalations, `decisions try` test cards) in one page, and answers one with `osstack decisions answer`, which forwards to that source's own command only with a valid engineering credential and the listed source revision. `osstack decisions try` creates one harmless colour-choice test card (`probe` source) to rehearse the inbox end to end; it also needs a valid engineering credential.

## Sub-features

- `decisions-list` `decisions list --json` returns `items`, `failures`, `next_cursor`; on a fresh scratch daemon `items` is empty and the four engineering sources (`contained_mission`, `ci_repair`, `revision_chain`, `ci_pilot`) report `source_unavailable`.
- `decisions-list-text` the plain-text view prints `No pending decisions on this page.` and one `<source>: <code>` line per failure.
- `decisions-scope` `--scope <64 lowercase hex>` and `--limit 1..100` filter the page; malformed values are refused client-side.
- `decisions-answer-refused` `decisions answer` without a credential is refused before any RPC; with a credential but no configured engineering authority the daemon refuses with `permission_denied` and writes nothing.
- `decisions-try-refused` `decisions try` without a credential (or with a malformed `--wait`) is refused before any RPC; with a credential but no configured engineering authority the daemon refuses `decisions.try_create`, the CLI prints the fixed error line, and no test card is created.

## How to get to it (user POV)

- Run `osstack decisions list [--scope ID] [--limit N] [--cursor TOKEN] [--json]` in a terminal (daemon required; it never starts one).
- Run `osstack decisions answer --source S --id ID --answer KIND [--param k=v ...] --answer-id KEY --source-revision REV [--json]` with `OSSTACK_ENGINEERING_CREDENTIAL` set.
- Run `osstack decisions try [--wait 1..3600] [--json]`, then `osstack decisions try status ID [--json]` / `osstack decisions try continue ID [--json]`, with `OSSTACK_ENGINEERING_CREDENTIAL` set; the create output prints the matching `decisions answer --source probe ...` command.
- User guide: `docs/guides/pending-decisions.md`.

## Driving it with verify-osstack.sh

Preconditions:

- Doctor healthy. Fresh scratch home (no engineering authority file, no `OSSTACK_ENGINEERING_CREDENTIAL` in the env).

- **List (JSON).** Run `$V cli dec-list -- decisions list --json`. Exit `0`; `items: []`, `next_cursor: null`, `failures` is exactly `contained_mission`, `ci_repair`, `revision_chain`, `ci_pilot` each with `code: "source_unavailable"` (observed 2026-11-25; `ci_pilot` was added by #546).
- **List (text).** Run `$V cli dec-list-text -- decisions list`. Exit `0`; stdout is `No pending decisions on this page.` followed by `contained_mission: source_unavailable`, `ci_repair: source_unavailable`, `revision_chain: source_unavailable`, `ci_pilot: source_unavailable`.
- **Scope filter.** Run `$V cli dec-scope -- decisions list --scope $(printf 'a%.0s' $(seq 64)) --limit 1 --json`. Exit `0`; same empty shape. Then `$V cli dec-badscope -- decisions list --scope scope_nosuch`: exit `1`, stderr `osstack decisions: request failed; check flags and daemon availability` (scope IDs must be 64 lowercase hex; `--limit 0` is refused the same way).
- **Answer without credential.** Run `$V cli dec-ans -- decisions answer --source hermes --id approval:nosuch --answer choice --param choice=yes --answer-id verify:1 --source-revision r1 --json`. Exit `1`, same fixed stderr line, no stdout.
- **Answer refused by the daemon.** Run `OSSTACK_ENGINEERING_CREDENTIAL=$(printf 'x%.0s' $(seq 40)) $V cli dec-ans-cred -- decisions answer` with the same arguments. Exit `1`; JSON `accepted: false`, `replay: false`, `outcome: "refused"`, `code: "permission_denied"`, `current: {state: "unknown", item: null}`. Then `decisions list --json` is unchanged.
- **Try without credential.** Run `$V cli dec-try -- decisions try --json` and `$V cli dec-try-badwait -- decisions try --wait 0`. Each exits `1` with the same fixed stderr line and no stdout (observed 2026-11-25).
- **Try refused by the daemon.** Run `OSSTACK_ENGINEERING_CREDENTIAL=$(printf 'x%.0s' $(seq 40)) $V cli dec-try-cred -- decisions try --json`. Exit `1`, same fixed stderr line, no stdout, and the credential is not echoed; `$V cli stats-try -- stats` lists `decisions.try_create` in its RPC table (the request reached the daemon), and `decisions list --json` is unchanged (no `probe` item).

## Gotchas

- A non-empty list needs real pending sources: a Hermes approval/clarify, an Autonomy run in `awaiting_approval`, a daemon-side `loop.escalated` event, or a blocked background-loop card (`card_loop_*`, assignee `osstack-loop`). A manually created kanban card in `blocked` does not appear, and local `deliver` escalations do not reach the daemon DB. Mission / CI repair / revision-chain items need a configured engineering authority and credential. None of these are seeded by this map; report the non-empty list and an accepted answer as not covered. The same holds for a created `decisions try` card, `try --wait`, `try status` / `try continue`, and answering it with `--source probe`.
- With `OSSTACK_ATTENTION=1` and a configured notify sender, the daemon also sends each pending decision as an attention notice (`decision:*` items, scope `host` when the decision has none; failed reminders count as dead letters in the cockpit attention panel). The default run has no sender and no pending decisions, so notices are not covered.
- The credential must be 32–4096 characters or the CLI refuses it client-side; credentials are never echoed in output. Do not use a real credential here.
- All client-side errors share one fixed stderr line; distinguish flag errors from daemon errors by whether `$OSSTACK_SOCKET` answered (`$V doctor`).
