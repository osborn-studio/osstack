# Pending decisions

An owner asks the daemon "what is waiting on me?" with `osstack decisions list`, which reads every pending owner decision (Session attention, contained Mission, CI repair, revision chain, Autonomy, Hermes approvals/clarifies, loop escalations) in one page, and answers one with `osstack decisions answer`, which forwards to that source's own command only with a valid engineering credential and the listed source revision.

## Sub-features

- `decisions-list` `decisions list --json` returns `items`, `failures`, `next_cursor`; on a fresh scratch daemon `items` is empty and the three engineering sources report `source_unavailable`.
- `decisions-list-text` the plain-text view prints `No pending decisions on this page.` and one `<source>: <code>` line per failure.
- `decisions-scope` `--scope <64 lowercase hex>` and `--limit 1..100` filter the page; malformed values are refused client-side.
- `decisions-answer-refused` `decisions answer` without a credential is refused before any RPC; with a credential but no configured engineering authority the daemon refuses with `permission_denied` and writes nothing.

## How to get to it (user POV)

- Run `osstack decisions list [--scope ID] [--limit N] [--cursor TOKEN] [--json]` in a terminal (daemon required; it never starts one).
- Run `osstack decisions answer --source S --id ID --answer KIND [--param k=v ...] --answer-id KEY --source-revision REV [--json]` with `OSSTACK_ENGINEERING_CREDENTIAL` set.
- User guide: `docs/guides/pending-decisions.md`.

## Driving it with verify-osstack.sh

Preconditions:

- Doctor healthy. Fresh scratch home (no engineering authority file, no `OSSTACK_ENGINEERING_CREDENTIAL` in the env).

- **List (JSON).** Run `$V cli dec-list -- decisions list --json`. Exit `0`; `items: []`, `next_cursor: null`, `failures` is exactly `contained_mission`, `ci_repair`, `revision_chain` each with `code: "source_unavailable"` (observed 2026-11-18).
- **List (text).** Run `$V cli dec-list-text -- decisions list`. Exit `0`; stdout is `No pending decisions on this page.` followed by `contained_mission: source_unavailable`, `ci_repair: source_unavailable`, `revision_chain: source_unavailable`.
- **Scope filter.** Run `$V cli dec-scope -- decisions list --scope $(printf 'a%.0s' $(seq 64)) --limit 1 --json`. Exit `0`; same empty shape. Then `$V cli dec-badscope -- decisions list --scope scope_nosuch`: exit `1`, stderr `osstack decisions: request failed; check flags and daemon availability` (scope IDs must be 64 lowercase hex; `--limit 0` is refused the same way).
- **Answer without credential.** Run `$V cli dec-ans -- decisions answer --source hermes --id approval:nosuch --answer choice --param choice=yes --answer-id verify:1 --source-revision r1 --json`. Exit `1`, same fixed stderr line, no stdout.
- **Answer refused by the daemon.** Run `OSSTACK_ENGINEERING_CREDENTIAL=$(printf 'x%.0s' $(seq 40)) $V cli dec-ans-cred -- decisions answer` with the same arguments. Exit `1`; JSON `accepted: false`, `replay: false`, `outcome: "refused"`, `code: "permission_denied"`, `current: {state: "unknown", item: null}`. Then `decisions list --json` is unchanged.

## Gotchas

- A non-empty list needs real pending sources: a Hermes approval/clarify, an Autonomy run in `awaiting_approval`, a daemon-side `loop.escalated` event, or a blocked background-loop card (`card_loop_*`, assignee `osstack-loop`). A manually created kanban card in `blocked` does not appear, and local `deliver` escalations do not reach the daemon DB. Mission / CI repair / revision-chain items need a configured engineering authority and credential. None of these are seeded by this map; report the non-empty list and an accepted answer as not covered.
- The credential must be 32–4096 characters or the CLI refuses it client-side; credentials are never echoed in output. Do not use a real credential here.
- All client-side errors share one fixed stderr line; distinguish flag errors from daemon errors by whether `$OSSTACK_SOCKET` answered (`$V doctor`).
