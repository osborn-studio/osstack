# U3 T6: a client key and revision for `mission.chain_decide`

Status: design, waiting for the owner's decisions in §6. No code yet.
Plan: `docs/plans/2026-11-16-osstack-self-loop-upgrade.md`, U3 "需要改" item 3
(client idempotency keys and expected revisions before forwarding) and the U3
status row ("修订链决定没有客户端幂等键，统一入口不转发").
Read on `main` at `076159dc`.

## 1. What exists today

- `mission.chain_decide` takes `chain_id` and `decision`
  (`abandon` | `takeover` | `reconcile`) and nothing else
  (`packages/cli/src/contained-mission-rpc.ts:56`).
- `RevisionGrantService.chainDecide` (`packages/cli/src/contained-mission-grant.ts:395-417`):
  - `abandon` / `takeover`: `chains.closeLive(chain_id, chain.revision, …)`.
    The revision compared is the one the service just read, not one the
    client saw, so a stale answer still closes the chain. Then, outside the
    transaction, it asks the host to cancel the current child Mission and
    reports `child_cancel: not_needed | requested | failed`.
  - `reconcile`: only when a push intent is `uncertain`; it awaits
    `reconcileReceipt(chain)` (a GitHub read that settles the intent) and
    returns `{ settled }`.
- No receipt is written for the answer itself. A retry after a lost response
  gets `chain_terminal` (abandon/takeover) or `nothing_to_reconcile`
  (reconcile) instead of the first result; an answer from a stale view is not
  refused.
- `decisions.answer` therefore refuses revision chains with
  `not_answerable` / `idempotency_unsupported`
  (`packages/cli/src/decisions/answer.ts:73-78`).

## 2. Design

Follow the keyed admission `mission.decide` already uses
(`contained-mission-rpc.ts:305-345`), recorded in the chain's own
append-only event table (`engineering_revision_chain_events`, free-text kind,
no migration).

**RPC.** Two optional fields: `decision_id` (same pattern as
`mission.decide`) and `expected_revision` (positive integer). Without them the
call behaves exactly as today.

**abandon / takeover with a key**, in one transaction with the close:

1. A `chain_answer_accepted` event with this `decision_id` exists: same
   principal and same digest (`{decision}`) → return its recorded result with
   `replay: true`; other principal → `decision_id_owner_mismatch`; other
   content → `decision_id_conflict`. Nothing is written.
2. `expected_revision` given and not the current revision → `stale_revision`.
3. Otherwise `closeLive` with the client's revision, and in the same
   transaction append `chain_answer_accepted` with
   `{decision_id, principal_id, digest, revision, decision, result}`.

After the transaction the child cancel runs as today, and its outcome is
appended as `chain_answer_child_cancel` `{decision_id, outcome}`. A replay
reports the recorded cancel outcome, or `unknown` when none was recorded (the
process died between close and cancel). A replay never requests a second
cancel. The implementation must show, with a test, what happens to a child
whose chain closed while its cancel request was lost (which existing recovery
path stops it, if any), and stop and report if none does (§6 decision 2).

**reconcile with a key.** The effect is a GitHub read whose result settles an
uncertain intent; it is not atomic with any receipt.

1. Same replay/conflict rules as above on `chain_answer_accepted`.
2. `expected_revision` check as above.
3. Append `chain_answer_accepted` (no result yet) and
   `chain_answer_effect_started`, then await `reconcileReceipt`, then append
   `chain_answer_result` `{decision_id, settled}`.
4. A replay with a result returns it. A replay with `effect_started` and no
   result returns `outcome: unknown` and starts nothing; the owner checks the
   chain and answers again with a new key if the intent is still uncertain.

**Router.** `decisions.answer` forwards `source: revision_chain` with
`answer` in `abandon | takeover | reconcile` to `mission.chain_decide` with
`decision_id = answer_id` and `expected_revision = source_revision`, and maps
the outcome like the Mission route. `grant_revisions` and the recheck re-arm
stay `local_only`. Shadow chains keep their empty answer list.

**List.** Unchanged: `source_revision` of a chain is already its integer
revision (`DecisionQueries.revision_chain`), so the router passes it as
`expected_revision`.

## 3. What does not change

- `closeLive`, the reservation voiding, the stop obligations and the child
  cancel path.
- Grants, renewals, recheck re-arm: still host-signed and local only.
- No table, no migration, no new RPC method.

## 4. Tests

1. Keyed abandon and takeover: first call closes and records; replay returns
   the same result and writes nothing; other decision under the same key →
   conflict; other principal → owner mismatch; stale `expected_revision` →
   refused, chain unchanged.
2. Death between close and cancel (P2 of #539): replay reports cancel
   `unknown`, no second cancel request.
3. Keyed reconcile: result recorded and replayed; death after
   `effect_started` → `unknown`, no second GitHub read; a new key after
   `unknown` is admitted only if an intent is still uncertain.
4. Unkeyed calls: byte-identical responses to today (existing tests untouched).
5. Router: forwards the three answers; `grant_revisions` stays `local_only`;
   shadow chain refused; scope checks as for Missions.
6. Crash-point file (#539): add revision chain routes for `abandon` (P1, P2,
   P4) and `reconcile` (P1, P2, P3, P4).
7. The guide's answer and boundary tables updated.

## 5. Delivery

One PR, CLI only (the chain store already has the event append), estimated
250–350 lines with tests, a guide update and a changeset.

## 6. Decisions for the owner

1. **Allow remote answers for `abandon`, `takeover` and `reconcile` on live
   revision chains.** They stop or settle work and are not signature-bound;
   the plan's rule (2026-11-16) puts abandon and retry-like decisions on the
   remote side. `grant_revisions` and the recheck re-arm stay local.
   Recommended: yes.
2. **No second child cancel on replay**; rely on the existing recovery.
   Alternative: re-request the cancel on replay when the outcome is unknown
   (cancel is idempotent on the host, but it is an extra write path).
   Recommended: no second cancel.
3. **Unkeyed `mission.chain_decide` keeps today's behaviour**, including
   comparing the service-read revision. Alternative: require a key from now
   on, which breaks `osstack mission chain-decide` callers until they pass
   one. Recommended: keep it optional; the CLI command gains
   `--decision-id` and `--expected-revision`.
