# U4b D5c: operator re-arm of the host recheck, and the recheck view

Date: 2026-11-23. Status: implemented as described here. The transport was decided by the owner (decision 8 of the [grant renewal note](2026-11-20-local-failure-grant-renewal.md), 2026-11-20). The points of §5 were chosen by the implementing session and are not owner decisions.

Baseline: `main` at `2f8ebf33`. Parent contracts: the [grant renewal note](2026-11-20-local-failure-grant-renewal.md) §4.3 and §7 row D5c, the [host recheck run](2026-11-19-host-recheck-run.md) §1.4, §3.4 and §5.2, and the [route wiring](2026-11-20-local-failure-route-wiring.md) §7.8.

The waiting notice is not part of this node. `contained-mission-local-failure-recheck-waiting.ts` stays without a caller and its guard is unchanged.

## 1. The gap

The recheck step starts one automatic host run in the pass that opens the ledger row. If that run is refused, or never starts, the row stays `reverify_pending` and nothing on the host can start another attempt. The run library already accepts a second and third attempt with the trigger `operator`; no entry called it.

## 2. The re-arm

**Method.** `mission.rearm_local_failure_recheck { credential, mission_id, expected_attempt, decision_id }`. `mission_id` is the root Mission. This is the one new RPC method of the node.

**Host command.** `osstack mission recheck-rearm --mission ROOT --attempt N [--decision-id ID]`. Without `--decision-id` the command generates one.

**It exists only with the route switch on.** With `OSSTACK_LOCAL_FAILURE_REPAIR` off the method answers `unknown_method`, before the parameters are parsed and before the credential is read.

**It arms and returns.** In one immediate transaction under the owner fence the handler checks, in this order:

| Check | Refusal |
|---|---|
| The route is enabled (bridge on, not draining) | `recheck_rearm_unavailable` |
| The caller can read the Mission and has read, write and operator scope on its scope, as authenticated at this call | the store's read error, or `permission_denied` |
| The Mission is the root of a live chain that is not closed, and that chain has exactly one ledger row in `reverify_pending` for this root | `recheck_rearm_not_waiting` |
| No run row that is unsettled or was launched (anything other than `stopped / not_started`) | `recheck_rearm_run_present` |
| Fewer than three run rows | `recheck_run_attempts_exhausted` |
| `expected_attempt` equals the number of run rows plus one | `recheck_rearm_attempt_mismatch` |
| No other request is armed for this row | `recheck_rearm_pending` |
| `decision_id` was not used in an earlier request on this chain | `decision_id_conflict` |

It then appends one chain event `local_recheck_rearm_requested` `{ recheck_id, dispatch_id, attempt, decision_id, principal, session, expires_at }` and, after the transaction has committed, keeps the request in the daemon's memory. It writes nothing else: no run row, no ledger change, no grant change. A repeated call with the same `decision_id`, attempt, principal and session while the request is armed returns the same answer with `replay: true` and writes nothing.

**The tick runs it.** At the start of each recheck pass (every ten minutes) the step takes the armed requests one at a time. Each request is removed from memory when it is looked at, and is used only if, at that moment:

- the route is enabled; a pass that finds the route disabled voids every armed request (`rearm_route_disabled`);
- it is younger than 15 minutes (`rearm_expired`);
- the principal and session that armed it, refreshed now, still have read, write and operator scope (`rearm_authority_lost`);
- the chain, the ledger row and the attempt number are still what was checked at arming (`rearm_stale`).

Then the step calls `runRecheck(ports, id, "operator", signal)` once, through the same single call site as the automatic start. The run library does every admission check of the recheck design again: ledger state, active run, three attempts, grant signature and head rule, budget, root admission. A refused operator run has consumed the request. The log line is `osstack: local-failure recheck: <recheck_id>: operator <outcome>`.

**A restart never launches.** Armed requests live in a `Map` in the route assembly and nowhere else. `recover()` does not read it. After a restart the map is empty; the chain event remains as history.

**What a re-arm cannot do.** It cannot push, approve a candidate, renew or change a grant, pass the ledger, or start a second launched run. Three attempts and "one launched run" are still enforced by the run store and the database.

## 3. Not answerable remotely

- The re-arm is not a decision kind and `packages/protocol` is unchanged.
- `decisions.answer` answers `local_only` with the local command `mission recheck-rearm` for the answer `rearm_local_failure_recheck` on every engineering source, and never forwards it. The `revision_chain` source already forwards nothing.
- The decision list shows a waiting recheck under the existing `revision_chain` source. A live chain that is not closed is listed when it has a ledger row in `reverify_pending`, no unsettled or launched run and fewer than three attempts.
  - A chain listed only for this reason has no allowed answer, is marked as local, and carries `mission recheck-rearm` as its only alternative. Its summary is `recheck waiting: attempt <n> of 3, mission <root>`.
  - A chain that is listed anyway (`ready_for_human`, `awaiting_decision`) keeps its answers and gains `mission recheck-rearm` as one more alternative.
- No file in `daemon`, `bin` or `cli-entry` names the method. The RPC handler calls one function of the route handle and nothing of the host.

Any holder of an operator-scope credential on the local socket can call the method directly; the same holds for the candidate approval (grant renewal note §9).

## 4. The recheck view

`mission.status` of a root Mission gains a `recheck` field when the route switch is on (no new method; with the switch off the answer is unchanged). The read scope is checked by `mission.status` before the view is read. The view is read-only and contains ids, hashes, numbers and fixed codes:

- chain, recheck and dispatch ids, repository, PR number, head and base;
- ledger `state` and `reason`, the `missing` list (`result`, `actions`, `host`), `opened_at` and `waited_ms` while pending;
- `attempts_used`, `attempts_max` (3) and each attempt with its state, outcome and conclusion;
- `last_refusal`: trigger, state, reason and time of the newest `local_recheck_refused` event;
- `rearm`: whether a re-arm would be admitted, the `expected_attempt` to pass, the code that blocks it, whether a request is armed and until when, and the time of the last request.

It is `null` for a Mission without a ledger row. It does not use the close-out reader (`readLocalFailureCloseout`), which needs a GitHub read and writes an event, and it does not show the waiting notice.

## 5. Chosen, not decided by the owner

1. **The handler does not wake the tick.** A re-arm is used at the next ten-minute pass. If a pass takes longer than the remaining life of a request (another container is running), the request expires and the person re-arms. Waking the tick from the handler would be faster and was not taken, to keep the RPC from reaching the run.
2. **A disabled pass voids every armed request**, also one that has not expired.
3. **Authority is checked twice**: at the call, and again at the tick by refreshing the principal and session that armed the request.
4. **`decision_id` is required** by the method (the command generates one). A `decision_id` cannot be reused on the same chain.
5. **A second request for the same row is refused while one is armed**, whoever sends it, except for the exact replay.
6. **Refusal codes.** New: `recheck_rearm_unavailable`, `recheck_rearm_not_waiting`, `recheck_rearm_run_present`, `recheck_rearm_attempt_mismatch`, `recheck_rearm_pending`. Reused: `permission_denied`, `recheck_run_attempts_exhausted`, `decision_id_conflict`.
7. **With the switch off the method is `unknown_method`**, not `local_failure_route_disabled` as the candidate approval answers.
8. **The view rides on `mission.status`** and exists only with the switch on.
9. **The waiting recheck is shown under `revision_chain`**, marked local, with `mission.chain_decide` as the nominal answer command and no allowed answer. The decision list cannot see the switch: with the switch off it still shows the item, and the command then answers `unknown_method`.
10. **A refused operator run with the same state and reason as the last refusal writes no second `local_recheck_refused` event.** This is the run library's existing rule (the trigger is not part of the comparison); the request event and the log line are the trace.
11. **A waiting recheck produces no outward decision notice.** The decision notice sender (`decisions/notices.ts`, used by the supervision service) reads the same query as the decision list. A chain that is listed only for a waiting recheck is skipped there, so the set of notices is exactly what it was before this node. Sending one would be a new message on the Grok Bot channel, which belongs to the notice node. A chain that is listed anyway keeps its notice unchanged.
12. **The run store's rows are read through one new read-only core method**, `LocalFailureRecheckStore.runFacts`, so that CLI files other than the ports factory still do not name the run store.

## 6. Guards

- `contained-mission-diagnosis-guards.test.ts`, three edits. (1) The recheck step still has exactly one `runRecheck(` and one `recoverRecheckRuns(` call; `"automatic"` and `"operator"` each occur exactly once, and the word `operator` occurs nowhere else in the file. Before, the word was forbidden. (2) In "gives the recheck step one caller" the word `operator` left the forbidden list, because (1) now pins it. (3) The assembly has exactly seven imports (was five) and must import the re-arm and view modules.
- Two tests that pin the list of Mission RPC methods gained the one method.
- New `contained-mission-local-failure-recheck-rearm-guards.test.ts`: the method name only in the RPC file, the command file and `decisions/answer.ts`, and never as `mission.…` in the last; the two modules and their functions only in themselves and the assembly; the event kind only in the two modules; `runFacts` only in the store and the two modules; the re-arm module has exactly one `appendEvent(` and no SQL write, timer, file, environment, network, run, grant, approval, publish, dispatch or diagnosis name; the view module has no write; the RPC case names nothing of the host, no `tick`, no `await`.
- The new guard also keeps `decisions/notices.ts` free of `rearm`, `local_recheck` and `verification_waiting`, and the webhook delivery file free of `rearm`.
- Unchanged and green: the guard that keeps the waiting notice unwired. Also unchanged: "prepares only SELECTs and imports only read dependencies" for the notice source; the decision query still starts with `SELECT`.

## 7. Traces asked for with this node

- **The head rule for a renewed grant (R3) is in the operator path.** `verifyRecheckGrant` (`packages/core/src/bridge/recheck-admission.ts:62`) refuses a grant on the run head unless it carries `renews` for the ledger row's chain. `runRecheck` calls it for both triggers, so "renew, then re-arm" goes through it.
- **Whether the root Mission's repository holds the repaired head** (open doubt of the D5b node). By reading: yes in the normal flow. The run reads the candidate from the root Mission's `repo_path`; the repair child keeps the same `repo_path` and works in a `git worktree` of it, which shares the object store, and the pushed commit is the child's candidate. Not settled: nothing pins that commit against a later `git gc` once its branch is gone. A missing commit ends as `verify_infrastructure_error`, which a re-arm can retry.
- **What the scan does with a failed result on the new head** (open doubt of the D5b node). By reading: it registers one diagnosis request per result, once. The diagnosis then refuses it with `verify_grant_invalid` because the grant binds the old head; no intake row, no container. After a renewal that binds the new head a diagnosis could run once, but no second repair is dispatched (`verify_repair_limit`; the dispatch query excludes a root that has a dispatch). Not settled: no caller retries a request already held at `awaiting_decision` after a renewal. Neither point was changed here.

## 8. Not verified

- No live daemon, socket, real GitHub read, container or Docker. Tests use real SQLite stores, the in-process RPC service and fake `prepare` and `run` ports.
- `OSSTACK_BRIDGE=1` refuses to start, so the method cannot be called in production yet.
- The two traces of §7 are from reading the source, not from a run.
- Two ledger rows in `reverify_pending` for one chain would list the chain twice in the decision query. One dispatch per root is enforced elsewhere; this was not tested as a fault case.
