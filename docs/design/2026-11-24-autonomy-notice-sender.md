# U3 T4: a production sender for the Autonomy notification outbox

Status: design accepted. The owner accepted all four recommendations in §6 on 2026-11-24.
Plan: `docs/plans/2026-11-16-osstack-self-loop-upgrade.md`, U3 "需要改" item 6
and the Autonomy row of the U3 table ("发件箱有，生产没接发送器").
Owner direction (2026-11-24): use the existing attention sender channel.
Read on `main` at `90a14ab2`.

## 1. What exists today

- Autonomy writes owner notifications to its own table,
  `autonomy_notification_outbox`. A row is enqueued on a run transition
  (`packages/autonomy/src/core-persistence.ts:107-124`). There are five kinds
  (`packages/core/src/state/notification-outbox.ts:6-12`):

  | Kind | Fixed summary | Is it a decision? |
  |---|---|---|
  | `awaiting_approval` | Signed Owner approval required | Yes. Also listed by `decisions.list` (source `autonomy`) and notified by #471. |
  | `escalated` | Guarded autonomy run escalated | No |
  | `deploy_frozen` | Production deployment frozen | No |
  | `rollback_failed` | Production rollback failed | No |
  | `delivery_evidence_failed` | Delivery proof integrity failed | No |

- The payload is closed and carries no free text: kind, run id, repository id,
  run state, one of the five summaries, and the fixed status command
  (`notification-outbox.ts:36-59`).
- `drainAutonomyNotifications` (`packages/cli/src/autonomy-notification.ts`)
  sends due rows through an `AutonomyNotificationSender`: 10 s timeout, backoff
  from 30 s to 1 h, 5 attempts, then `dead_letter`. The daemon calls it from
  `refreshAutonomyHealthAndRecover` (`packages/cli/src/daemon.ts:4136-4149`)
  on start and every 30 s, but only when a sender was passed in.
- **No production start passes a sender.** `bin.ts` never sets
  `notificationSender`; only tests do. Rows stay `pending`, and the health
  check `notification_outbox` reports `warn` while any row is pending or
  dead-lettered (`packages/cli/src/autonomy-health.ts:599-613`).
- The attention channel has two senders chosen by
  `OSSTACK_ATTENTION_NOTIFY=local|webhook`
  (`packages/cli/src/attention-webhook-delivery.ts:139-143`): a local spool
  directory, and one HTTPS POST per notice (no redirects, 4 s timeout, 16 KiB
  cap, `Idempotency-Key`). Its message shape is built for decisions
  (`item_id` must be `decision:<hex>` or `verification-waiting:<hex>`), so an
  Autonomy notice cannot be pushed through it unchanged.

**Consequence.** Four of the five kinds reach nobody today. The fifth,
`awaiting_approval`, already reaches the owner as a pending decision.

## 2. Design

One new module in the CLI, `autonomy-notice-delivery.ts`, that builds an
`AutonomyNotificationSender` from the same environment switch and the same
webhook configuration as the attention channel. No new table, no migration,
no change in `packages/autonomy` or `packages/core`.

- `OSSTACK_ATTENTION_NOTIFY` unset → no sender, as today.
- `local` → write one file per notice into the existing spool directory
  `attention-notifications`, same file rules (0600, name from a hash of the id,
  identical retry is a no-op).
- `webhook` → one POST per notice to the configured URL with the configured
  key, `Idempotency-Key: <notification_id>`, same transport limits as the
  attention webhook sender.

Webhook body, a new notice kind:

```json
{
  "schema_version": 1,
  "kind": "autonomy_notice",
  "notification_id": "an_<32 hex>",
  "reason_code": "escalated",
  "text": "<fixed sentence for this reason code>",
  "autonomy_run_id": "...",
  "repo_id": "...",
  "run_state": "...",
  "status_command": "osstack autonomy status <run id> --json"
}
```

- `reason_code` is the outbox kind. `text` is one fixed sentence per kind,
  written in the sender. Every sentence ends with "Replying here does nothing."
- The three references pass the existing id validation used for decision
  notices (no path separators, no control characters, unchanged by the
  redactor); a row that fails it is not sent and counts as a failed attempt.
- A 2xx response is `delivered`. Anything else follows the existing drain
  rules. Nothing is retried beyond what the drain already does.

Wiring: the daemon start uses the sender from the environment when the caller
passed none (`opts.notificationSender ?? select…(process.env, home)`). The sender is
selected under the same condition as the attention sender (the attention
feature is on), so one configuration turns owner notices on or off.

## 3. Things that change when the switch is on

- **No new periodic work besides the drain.** Found while implementing: the
  existing 30-second poll (`refreshAutonomyHealthAndRecover`) first runs log
  and proof retention, which deletes expired proof directories, and only then
  drains the outbox. Passing the environment sender into that poll would make
  a host without guarded autonomy run retention every 30 seconds instead of
  once at start. So: where guarded autonomy is configured, the existing poll
  gets the sender (it already runs there). Where it is not, a separate timer
  runs the drain only, every 30 seconds, and nothing else.
- **A backlog is sent on first start.** Rows that have been `pending` since
  before this change go out, 50 per drain, oldest first (§6 decision 4).
- The health check stops warning once the outbox drains.

## 4. Tests

1. Sender selection: unset, `local`, `webhook`, invalid configuration.
2. Webhook body for each of the five kinds; fixed text; size cap; header.
3. A reference with a path separator or a redactable token is refused before any send.
4. Local spool: file content, mode, idempotent repeat.
5. Drain with the real sender and a fake `fetch`: delivered, retry with
   backoff, dead letter after 5 attempts, timeout.
6. Daemon: with the switch unset nothing changes; with it set and no guarded
   autonomy the poll runs and drains.
7. Whatever §6 decision 3 chooses for `awaiting_approval`.

## 5. Delivery

One PR, CLI only, estimated 150–250 lines with tests, plus a guide section and
a changeset. After merge: the serving daemon must be upgraded, and the first
start with `webhook` sends real notices to the Grok Bot. That needs the
owner's go-ahead and is not part of the PR.

Not in this node: T5 (CI pilot release source); any answer path from the chat.

## 6. Decisions for the owner

1. **A new webhook notice kind `autonomy_notice` with five reason codes.**
   The Grok Bot side receives a body it has not seen before and must accept it.
   Alternative: disguise these as decision notices, which would be false for
   four of the five kinds. Recommended: the new kind.
2. **Same switch and same webhook URL and key as the attention channel.**
   Alternative: a separate switch. Recommended: the same one; one place to
   turn owner notices on or off.
3. **`awaiting_approval` is already notified by #471.** Options:
   (a) send it from the outbox too, so each approval produces two notices
   with different wording; (b) do not send it from the outbox, and record the
   row as delivered with a marker that says it went through the decision path.
   (a) has no special case and keeps the outbox record literal; (b) is quieter
   but writes "delivered" for something this path did not send.
   Recommended: (a), and revisit if the duplicates are a nuisance.
4. **Backlog on first start.** Before enabling, the owner reads the pending
   count with `osstack autonomy health` on the serving home. Options: send the
   whole backlog; or the implementation skips rows older than 24 hours and
   leaves them `pending` for the owner to inspect. Recommended: send the
   backlog if it is small (the owner decides after reading the count); no
   age rule in code.

**Record (2026-11-24).** The owner accepted the recommended option for all four: the new notice kind `autonomy_notice`; the same switch, URL and key as the attention channel; `awaiting_approval` is sent from the outbox as well as by the decision notice; no age rule in code, the owner reads the pending count before enabling.
