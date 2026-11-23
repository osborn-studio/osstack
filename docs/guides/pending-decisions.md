The pending decisions list reads seven local sources through `decisions.list`.
Use `osstack decisions list [--scope ID] [--limit 1..100] [--cursor TOKEN] [--json]`.
The command connects to an existing daemon. It does not start a daemon, answer a
request, update a projection, or send a notification.

The result contains `items`, `failures`, and `next_cursor`. The default page size
is 50. The maximum is 100. Sources follow protocol enum order; each source uses
ascending source ID order. Pass `next_cursor` as `--cursor` for the next page.
The cursor binds the scope filter and current read grants. Changed read grants
require a new scan. Pages are live reads, not a retained snapshot. If a source
fails, retry from the first page after it recovers to include its earlier IDs.

Each item has `source`, `source_id`, `scope_id`, `waiting_since`, `summary`,
`allowed_answers`, `answer_command`, `requires_local_signature`, and
`source_revision`. Times are epoch milliseconds. Unknown waiting times are
`null`. Summaries pass through `redactSecrets` and GitHub token redaction before
single-line normalization and truncation to 240 UTF-16 code units.
`answer_command` contains a command name and required parameter names. Optional
`alternatives` list other existing answer routes. No credential or signature
values are returned. An RPC name uses dots; a CLI command uses spaces.

`allowed_answers` lists state-supported answer kinds, or Session choice IDs.
`free_text` denotes unstructured input; Hermes approval `choice` denotes its
existing unconstrained choice parameter. Every answer still needs the original
command's authorization, source checks, configuration, and stop evidence. The
list does not grant authority. Shadow revision chains have no supported answer
route and return an empty answer list. Session risk and task-authorization gates
also return an empty answer list: current host routes reject unsigned answers.
They retain `requires_local_signature: true`; this change adds no signed answer
route. Autonomy decisions and entries that offer `grant_revisions` also set the
flag. Native Hermes approval.resolve keeps its existing unsigned behavior.

Mission, CI repair, and revision-chain queries require engineering credentials.
The CLI reads `OSSTACK_ENGINEERING_CREDENTIAL` if supplied. The daemon uses the
existing EngineeringAccess principal and reloads its authority on each page.
SQL filters these entries by `read_scopes` before projecting any data. A chain
uses its root Mission's scope. A read grant does not imply a write grant.
Without usable credentials these three sources report `permission_denied`.
Without a configured engineering authority they report `source_unavailable`.
Other sources keep their existing daemon-local read boundary.

`--scope` filters all seven sources. Session items and Missions have direct
scope bindings. Autonomy, Hermes, and loop events use their persisted task's
attention-scope binding. Unbound sources remain visible only in an unfiltered
query. If a task has multiple scopes, its item has `scope_id: null`; an explicit
filter still matches the task's recorded scopes. Repository discovery and remote
queries do not run. Each reader returns at most page-size plus one rows.

A source read or decoding failure produces `{source, code: "read_failed"}`.
Other sources continue. Exception messages, repository paths, PR numbers, and
SHAs from errors do not enter the response. Revisions come from source revisions
when present; other sources use a SHA-256 digest of their read record.
Hermes IDs use `approval:<approval_id>` and `clarify:<clarify_id>` to distinguish
the two tables. Loop IDs are escalation event IDs, or `card:<card_id>` for background-loop escalation cards; they are not task IDs.

The waiting-time evidence is:

| Source | Waiting start | Reader | Original writer |
|---|---|---|---|
| Session attention | `null`. `attention_items.created_at` records projection time, not waiting entry. | `packages/core/src/state/decision-queries.ts:25` | `packages/core/src/state/attention-store.ts:200` |
| Contained Mission | Latest state-entry event whose payload `to` is the current waiting state and `from` differs; `created_at` in ms. Later receipts and self-transitions do not reset it. | `packages/core/src/state/decision-queries.ts:40` | `packages/core/src/state/engineering-contained-store.ts:177` |
| CI repair | Same Mission entry event, classified by `ci_repair` and latest halted reason `publication_pending`. | `packages/core/src/state/decision-queries.ts:40` | `packages/cli/src/contained-mission-runner.ts:655` |
| Revision chain | Latest `transition` event entering the current waiting state; `created_at` in ms. | `packages/core/src/state/decision-queries.ts:57` | `packages/core/src/state/engineering-revision-chain-store.ts:740` |
| Autonomy | Latest transition into `awaiting_approval` from a different state; `occurred_at` seconds multiplied by 1000. | `packages/core/src/state/decision-queries.ts:69` | `packages/core/src/state/autonomy-runs.ts:306` |
| Hermes approvals / clarifies | Durable `requested_at` seconds multiplied by 1000. The request event supplies this field. | `packages/core/src/state/decision-queries.ts:77` | `packages/core/src/state/run-store.ts:137`, `:158` |
| Loop escalated | `loop.escalated` event `created_at` in ms; background cards use the latest `kanban_card_events.blocked` entry in seconds × 1000. | `packages/core/src/state/decision-queries.ts:88`, `:99` | `packages/loop/src/loop-engine.ts:1602`, `packages/cli/src/daemon.ts:2311`; cards: `packages/core/src/kanban/repository.ts:149`, `:76` |

Missing Mission, chain, or Autonomy entry events also produce `null`; projection
update timestamps are not substituted. Loop coverage includes events and blocked background-loop escalation cards
persisted in this daemon's database. Standalone loop JSON/JSONL files are not
discovered. Background cards stop appearing when they leave blocked status. Their waiting
start is the latest Kanban `blocked` entry event (seconds × 1000), not the
card's update time. Unbound background cards appear only in unfiltered queries.
The loop run-event ledger has no human-decision receipt. A later execution or
escalation for the same task and loop supersedes an earlier escalation; stopping
a loop alone does not resolve it. Decisions made only outside that ledger cannot
be inferred by this read-only query.

## 回答 / Answer one decision

Use the listed `source`, `source_id`, and exact `source_revision`. Provision an
engineering credential out of band. Set `OSSTACK_ENGINEERING_CREDENTIAL` on the
client. The authority file must be configured on the daemon. All answers require
a valid credential, including Hermes and Session answers. The daemon reloads the
authority for each request. Mission and chain answers also require the source's
read and write scopes. CI approval retains its operator-scope check.

```sh
osstack decisions answer --source hermes --id approval:APPROVAL_ID \
  --answer choice --param choice=yes --answer-id chat:REQUEST_ID \
  --source-revision REVISION_FROM_LIST --json
```

Keep the same `--answer-id` and content when a response is lost. Use a new key for
a new answer. Never retry an unknown effect with a replacement key. The RPC is
`decisions.answer`; its fields are `credential`, `source`, `source_id`, `answer`,
`params`, `answer_id`, and `source_revision`. Unknown parameters are refused.

| Source | Answer and parameters | Authority and retry guarantee |
|---|---|---|
| Contained Mission | Existing `mission.decide` kind; no parameters | Forwards `decision_id` and `expected_revision`. Existing Mission events provide atomic admission. Immediate transitions commit with admission. Asynchronous effects retain the source's receipts and `unknown` recovery rules. This is not an exactly-once external execution guarantee. |
| CI repair | `approve_ci_repair`, `--param candidate=COMMIT`; or `abandon` without parameters | Uses `mission.approve_ci_repair` or `mission.decide`. Approval and the keyed receipt commit in one transaction in existing Mission events. Candidate and operator checks remain in the source operation. Keys conflict across the two routes. |
| Session | Listed choice ID without text, or `free_text --param text=TEXT`; optional `--param takeover=true --param takeover_grant_id=GRANT_ID` | Forwards `action_id` to `attention.answer`. List revision carries `revision:content_hash`. The existing action reservation atomically deduplicates the send. Applied, in-flight and uncertain receipts retain their original meaning. Choice labels become the existing answer text. The selected kind is also bound to the receipt. |
| Hermes approval | `choice --param choice=VALUE` | The router calls `approval.resolve` only for a pending row. It still writes status `accepted` for any choice. Resolution and receipt metadata in the original request event payload commit atomically. The adapter event sequence stays unchanged. After a direct `approval.resolve` succeeds, repeating it with the same ID and choice returns the first result and changes nothing. A different choice returns `already_resolved`. |
| Hermes clarify | `free_text --param text=TEXT` | Same pending check and atomic request-event receipt around existing `clarify.resolve`. After a direct `clarify.resolve` succeeds, repeating it with the same ID and answer returns the first result and changes nothing. A different answer returns `already_resolved`. |

The router records the authenticated actor in the original event actor field or
forwarded payload. Hermes receipts also bind the client session. Their digest is authenticated with
HMAC using the supplied credential. Producer-supplied payload fields cannot forge
a successful answer. Retrying a Hermes key needs the same valid credential;
credential rotation produces a conflict and returns the current source state.
The router adds only `decisions_answer` metadata to the original request payload.
It preserves all source fields and allocates no adapter sequence number. If that
request event is missing, the router returns `not_answerable` with code
`idempotency_unsupported` and the native local resolve command. It performs no
answer write. Answers never
interpret source summaries or errors as commands. Current pending summaries keep
the list's redaction and 240-character bound.

The result contains `accepted`, `replay`, `outcome`, `code`, and
`current: {state, item}`. `code` preserves the source error code. `item` is the
current pending item, or `null` after it leaves the pending set. `accepted` means
the source accepted the answer; it does not prove external effects completed.
An early acknowledgement has outcome `accepted`. An ambiguous receipt has
outcome `unknown`. Changed content under an accepted key conflicts. A stale
source revision is refused before a new admission. Missing credentials or scopes
cause no answer writes. CLI JSON prints the full result; a refused answer exits 1.

These boundaries also apply to callers on the local socket:

| Source or kind | Unified answer result | Local command and reason |
|---|---|---|
| Revision chain `abandon`, `takeover`, `reconcile` | `not_answerable`, code `idempotency_unsupported` | `mission chain-decide` (RPC `mission.chain_decide`). Its current revision CAS uses the service's current revision, not a client revision. The interface has no client key. Reconcile and child cancellation await external work. A wrapper cannot atomically commit that work and a receipt. No unsafe check-then-execute route is offered. |
| `grant_revisions` | `local_only` | `mission grant-revisions`; an external signature is required. |
| `approve_local_failure_repair` | `local_only` | `mission approve-local-failure-repair --mission ID --candidate SHA` (RPC `mission.approve_local_failure_repair`). A person approves the exact verified candidate of a local-failure repair on the host. It needs read, write and operator scope and lasts 15 minutes. The list marks such an item with `requires_local_signature`; `abandon` on the same item is still forwarded. |
| Autonomy approval | `local_only` | `autonomy approve` / `autonomy reject`; use the original signed decision flow. |
| Loop escalation or blocked background card | `local_only` | Listed `cockpit retry` or `cockpit approve`; use the local terminal flow. No remote retry receipt is available. |
| Session `risk_approval` / `task_authorization` | `local_only` | `attention answer` (RPC `attention.answer`) is the source command name. The current source rejects unsigned answers; this release adds no signed answer route. |

These refusals never forward to a write command. No table, migration, or index is
added. Native source commands remain the sole state authorities.
