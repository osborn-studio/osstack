# Local follow-up obligations

`follow-up` records a local operator's promise, builds an unsent draft, and records explicit local resolution. It does not send messages, recognize provider delivery receipts, or implement a public transport. `fulfilled_local` means only that the operator's selected local Session condition was verified; it does not mean anyone received a reply.

All commands require `--repo PATH --default-tenant`. The service canonicalizes an existing readable/searchable directory and joins an existing Session to its matching task and run in that exact repository, requiring both tenant IDs to be NULL. Graph and unbound run sources are unsupported. The daemon provides authentication and DB access; an `actor` is an audit label, never an authorization credential. This feature does not depend on the Attention enable flag.

```text
osstack follow-up create --repo /canonical/repository --default-tenant --input obligation.json --json
osstack follow-up list --repo /canonical/repository --default-tenant --limit 20 --json
osstack follow-up draft UUID --repo /canonical/repository --default-tenant --revision 1 --actor operator --json
osstack follow-up resolve UUID --repo /canonical/repository --default-tenant --revision 2 --actor operator --mode condition --reason "Verified local completion" --json
```

Create input is a JSON file of at most 16 KiB. Scope is supplied through flags and must not appear in the input file:

```json
{
  "source_session_id": "existing-local-session",
  "expected_source_version": 1,
  "idempotency_key": "review-local-result-1",
  "actor": "operator",
  "promise": "Review this Session's local result",
  "destination_ref": "local_operator",
  "resolution_condition": "session_completed",
  "due_at": null
}
```

`destination_ref` accepts only the exact built-in local operator reference. Arbitrary URLs, recipient strings and registered external channels are unsupported in this release. `resolution_condition` accepts `manual` or `session_completed`. Manual obligations are explicitly waivable only; this version does not accept a caller assertion as proof of fulfillment. Due dates are optional safe Unix epoch milliseconds; a past date is an overdue promise rather than an invalid request. Promise text is bounded to 4,096 UTF-8 bytes, actor labels to 128, and resolution reasons to 1,024. Whitespace/control/format-only values are rejected. Text is stored and displayed as data and is never sent to a model or shell.

Creation verifies the actual Session version and records an immutable source identity digest bound to the source session/task/run IDs, request digest, task creation time and run start time. Native session IDs, source prompts and raw model output are not read. Reusing a create key with exactly the same canonical payload returns the existing obligation, including after source cleanup or later resolution. Changing the content under an existing key fails. New keys require a currently valid matching source. The source snapshot and every transition remain in append-only local history.

`draft` requires the current obligation revision and records a deterministic text draft containing the operator's promise and current structured source facts. Its content digest hashes the exact UTF-8 draft text. It always says `UNSENT`, changes only the local state to `drafted`, and never satisfies a condition or grants permission to send. A completed Session still requires a separate resolve operation. Missing/deleted/replaced or malformed sources remain visible as `source_missing`; the obligation and its original promise survive cleanup.

`resolve --mode condition` succeeds only when the original declared condition is `session_completed` and the same bound source Session is currently `completed`. A task's `done` status, a completed run, a model's assertion, a draft, a local spool file, or a URL cannot satisfy this condition. The resulting `fulfilled_local` record stores the verified source version/state/time and source identity binding. It records no external delivery. `resolve --mode waive` instead requires an explicit actor and reason; it works even when the original source is missing and retains the original promise. Terminal obligations are sealed. Pending draft text is omitted from terminal responses, while its exact bytes and digest remain in immutable draft-event history and the stored row. Creation reserves escaped response capacity for a maximal local waiver so a later draft cannot make the obligation unresolvable. Both paths use expected-revision checks, so competing/stale callers cannot overwrite each other's decisions.

`list` is read-only, returns at most 50 records and less than 64 KiB including JSON escaping, and provides a keyset cursor for the next page. The cursor binds repository and state filter, but is a paging position, not an authority token. Each request must independently assert its scope. Listings are current views rather than immutable multi-page snapshots; new records or source changes can appear between pages. Restart listing to discover records inserted before an already-consumed position, including timestamp ties. Write timestamps are clamped to the existing record (and latest repository write at creation) on a backward wall-clock step; this preserves local ordering without blocking an explicit waiver. It does not certify real wall time. A forward clock jump can leave the logical timestamp ahead of wall time; correcting the wall clock does not rewrite sealed evidence. The overdue count covers all open/drafted obligations in the selected repository, regardless of the page's optional state filter. Source uncertainty never automatically removes or fulfills an obligation. List responses use previews; complete promise/draft values are available in mutation responses. Long paths/text may reduce page size or fail a mutation's response-size bound; no oversized evidence is silently truncated.

Migration 44 adds `follow_up_obligations` and `follow_up_obligation_events` after triage migration 43. No source table is changed. The CLI and service perform no automatic retries; a stable database error can also indicate malformed owner-modified storage and should be inspected before retrying. Constructors do not migrate or write. Append-only means the API retains transition evidence and database triggers reject event updates/deletes; it is not a cryptographic audit chain or protection against an owner who directly rewrites the database. Row mutation, revision advancement and append-only event recording share one preflighted transaction; evidence failure rolls the mutation back. Existing `openDb` performs normal lineage checks and forward migration. Disable the command/RPC registration to roll back feature exposure while retaining history; do not lower schema versions or delete ledger rows.

The protocol schemas, `FollowUpObligationService(db, dbPath, {nowMs?})`, and `handleFollowUpCommand(args, {rpc, stdout?, stderr?})` support daemon integration. The handler expects raw validated RPC results; the root integration unwraps its existing transport response. RPC methods are `follow-up.create`, `follow-up.list`, `follow-up.draft`, `follow-up.resolve`. Register them using the existing authenticated daemon and its write ownership controls. There is no direct-DB CLI fallback.

Component validation covers restart/idempotence, source cleanup/replacement, scope and tenant joins, stale source/revision checks, rollback, two DB connections, terminal/event sealing, unsent drafts, fake delivery claims, bounded inputs/output, escaped controls, and the real schema 43→44 upgrade. Real daemon/CLI registration and repository-wide qualification are integration-owner checks. Public follow-up remains partial until a separately authorized, registered transport and actual delivery evidence are implemented and qualified.
