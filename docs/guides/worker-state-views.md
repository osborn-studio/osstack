# Worker state views (V1a+b)

This slice provides a read-only view of durable Session and run state in the
existing daemon database. It is not a process monitor. A stored `completed`
state does not prove a process exited, and a recent timestamp does not prove a
worker is alive. `process_liveness` is always `unknown`.

## Commands and scope

```sh
osstack worker list --repo /absolute/repository --default-tenant --limit 25 --json
osstack worker inspect VIEW_ID --repo /absolute/repository --default-tenant --json
osstack worker list --repo /absolute/repository --default-tenant --cursor CURSOR --json
```

Copy `view_id` or `next_cursor` from the preceding response. Tokens are opaque,
authenticated, scoped to one canonical repository and daemon instance, and
expire after 15 minutes. A cursor chain keeps the first page's expiry; taking
another page does not extend the scan lifetime. A newly issued view has its own
15-minute lifetime. Restarting the daemon invalidates them. Refresh the
list after `invalid_view` or `invalid_cursor`; those errors never fall back to
an unrestricted source-ID query. Inspect reads current metadata in the same
scope; it is not a historical snapshot or a mutation capability.

`--default-tenant` is required; this version does not support tenant selection.
The repository must be an accessible directory. The request is canonicalized
with `realpath`; only rows whose **stored** `repo_path` exactly equals that
canonical path qualify. Any rows containing an empty path, symlink alias, or
another noncanonical spelling are excluded, including newly created sessions
whose writer received an alias. No backfill or writer change is performed.

A qualifying Session must join its task and run with matching task ID,
session ID and agent ID, and both task and run must have a NULL tenant. Runs
have no independent repository column, so a run without this Session binding
is explicitly `excluded_not_bound`. This does not enumerate every executor.
The same worker can appear as two source views (Session and run); `total`
counts source views, not unique processes. `total=0` only means this supported,
explicitly scoped relation has no matches.

## Data and limits

Responses contain structured states, Session revision, latest turn ordinal and
state, decision-record presence, a wait reason, timestamps and freshness.
Decision presence is not proof that its contents are valid or that a particular
person owns the wait. `decision_record_present` only reports that a decision
record exists. Pending, accepted or failed inbound messages set
`uncertain_delivery_recorded`; for nonterminal views they yield
`delivery_unknown`. Terminal views have no active wait but retain this separate
historical uncertainty flag. No message body is read. Timestamps use epoch milliseconds
in the response; stored seconds are converted and rounded. Future timestamps produce
unknown freshness. Run timestamps reflect start/completion, not a heartbeat.
A run with no recorded outcome is `outcome_pending`, not proof of execution.

No native provider IDs, source IDs, prompts, assistant text, decision body,
message payload, task title/description, last-step text or event payload are
returned. Internal source IDs reside only inside encrypted tokens. There are
no execute, resume, cancel, terminal-attach, publish or cleanup controls.

Each page contains at most 50 views (default 25). The complete JSON response,
including its trailing newline and escaped Unicode control/format characters,
is at most 64 KiB; wide identities can produce
a shorter page with a cursor. `truncated` means another page is needed to read the remaining source rows.
Pagination is ordered by source kind and internal ID. Each response uses one
read transaction, but pages are independent live snapshots: concurrent source
insertions/deletions can change totals or place new rows before the cursor.
It is not a frozen scan. Input paths are limited to 4096 characters, tokens to
2048 characters, and corrupt source identities longer than 256 UTF-16 units
fail safely rather than becoming a misleading empty result. JSON-escaped
identities also have a 1200-byte bound so generated tokens fit their input limit.

Graph is `unsupported_authenticated_registration_required`. No Graph tables,
worker maps or log files are read as an authorization shortcut. Graph must be
added through its existing authenticated `GraphRpcService` host registration.
Terminal presentation, log tails, authenticated Graph views, other tenants,
remote homes and action controls remain later work. Text redaction is not
being claimed: this slice withholds raw text entirely.

## Integration contract

`packages/cli/src/worker-view-service.ts` exports:

- `new WorkerViewService(db, { nowMs? })`, using an existing `better-sqlite3`
  connection. Construction does not access a database, migrate, or write.
- `list({ repo_path, default_tenant: true, limit?, cursor? })` and
  `inspect({ repo_path, default_tenant: true, view_id })` are synchronous.
- `handle(method, params)` accepts only `worker.list` / `worker.inspect`.
- Parameter/result Zod schemas and `WorkerViewError` with a stable `code`
  and matching safe `message` (no underlying SQL or filesystem error text).

The daemon should lazily create one service per daemon lifetime over its
already-open connection, then forward those two methods through its existing
local RPC dispatch. Creating a service for each call invalidates tokens and is
incorrect. Supported database schema versions are 24 through the installed
core package's `CURRENT_SCHEMA_VERSION`; newer-than-code or older versions return
`unsupported_schema`. Missing/corrupt tables or a closed DB return
`source_unavailable`. This service never opens a DB path or changes schema.

`packages/cli/src/worker-view-command.ts` exports
`handleWorkerViewCommand(args, { rpc, stdout?, stderr? }): Promise<number>`.
`args` starts with `list`/`inspect`, excluding the top-level `worker` token.
The RPC dependency is `(method: string, params: unknown) => Promise<unknown>`.
It returns the raw successful result, not an `{ ok, result, error }` transport
envelope. The integration unwraps that envelope and throws a safe error code
for a failed response.
It must use the existing daemon socket client; the command never opens a
database. The top-level command and daemon should import these modules lazily.
`WORKER_VIEW_HELP` provides help text. Bin/daemon/protocol registration belongs
to the integration change; this module does not register a parallel endpoint.

The CLI validates bounded response shapes before printing and reports only
allowlisted stable service errors. Unknown transport errors become
`worker_request_failed`. Invalid/oversized remote results become
`invalid_worker_response`. Both JSON and plain output escape terminal controls
and Unicode format characters in paths; parsing JSON restores the exact path.

## Verification and rollback

Colocated tests use real migrated scratch databases, including a readonly
connection and an injected RPC bridge from the CLI to the real service. They
exercise tenant/repository inconsistency, canonical aliases, malformed input,
token forgery/expiry/type confusion/cross-instance reuse, concurrent scope
changes before inspect, byte-limited pagination, withheld content, and no DB
writes. These tests do not certify Graph/remote access or production p95.

Rollback removes the two dispatcher branches and command registration. No
migration, durable token table or provider invocation needs to be undone.
Restart invalidates every outstanding view/cursor token.

A malformed source identity or unsupported source state fails the entire affected page with `source_unavailable`. Pagination cannot skip that row; later rows remain unavailable until the source is repaired. This conservative failure is not a healthy empty list or partial success.
