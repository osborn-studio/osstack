# U4b W8: the merge hold of the local-failure route

Date: 2026-11-23. Status: implemented as described here; the points of §4 were chosen by the implementing session and are not owner decisions. §5 holds one decision that is still the owner's.

Baseline: `main` at `76fde562`. Parent contracts: [verify-failure intake](2026-11-16-verify-failure-intake.md) §4.1 ("the intake design") and [route wiring](2026-11-20-local-failure-route-wiring.md) §6 row W8 and decision 6 ("the wiring design"). This is a separate file, not an addendum to the wiring design, because another open change appends to that file at the same place.

## 1. Scope against main as it is

- **The only automatic merge.** One function sends a merge to GitHub: `createSandboxCiMerge(...).request` in `packages/cli/src/contained-mission-sandbox-ci-merge.ts` (App E). It serves the sandbox merge key and the live CI pilot, and is called from two places in `contained-mission-github-ci.ts` when Actions are green. The shadow Merger only records what it would do; its live mode does not exist (`MERGER_LIVE_NOT_IMPLEMENTED`).
- **What a held PR is.** A PR that is opted into the local-failure route: its live revision chain stores a version 2 grant. A version 2 grant never goes back to version 1 on a live chain (trigger `engineering_local_failure_grant_monotonic`).
- **The gap.** The merge path did not look at the chain. With the route switch on, the service refuses to start when a merge path is configured (`LOCAL_FAILURE_ROUTE_MERGE_HOLD_REQUIRED`), so the two never ran together. With the switch off and a version 2 chain already stored, App E could merge that PR on green Actions while a verification result was pending or failed.
- **What a passed recheck can release.** Nothing in this path. App E only merges a head that the CI root Mission or a CI repair child pushed (`pushReceipt`). A head pushed by a local-failure repair is neither, so App E refuses it with or without this node. The recheck ledger only has rows for such heads. The recheck design also says the gate ends at `ready_for_human` and adds no automatic merge (its §6). So the hold has no release: a person merges an opted-in PR.

## 2. What was added

A read-only function `readLocalFailureMergeHold(store, { repository, pr, root_mission_id, head, base })` in the new module `contained-mission-local-failure-merge-hold.ts`. It reads the host database only. It makes no GitHub read and writes nothing.

A PR is **subject to the hold** when a live chain matches it (same repository without regard to letter case and same PR number, or same root Mission) and that chain's grant is version 2 or has a `local_failure` value, or when an intake, dispatch or recheck row exists for that root Mission or for a matched chain. The chain's state does not matter. Shadow chains do not count.

A subject PR is always held. The reason comes from the recheck ledger (`LocalFailureRecheckStore`) and the dispatch table:

| Stored facts | Reason |
|---|---|
| A recheck row at `awaiting_decision` | its reason if it is `verify_recheck_failed` or `verify_recheck_binding_changed`, else `verify_merge_unverified` |
| A recheck row `recheck_passed`, result still current, at the target head and base, chain published at the same head and base | `verify_approval_required` |
| Another recheck row, or a dispatch without one | `verify_recheck_missing` |
| None of these | `verification_pending` |
| The read throws, or stored data cannot be parsed | `verify_merge_unverified` |

The merge path calls it at five points:

1. At the start of `request`, before the push receipt is checked and before any GitHub read. A held PR gets one event `local_failure_merge_held` (`pr`, `head`, `base`, `reason`) on the root Mission, written again only when the head or the reason changes. Nothing is read from GitHub and nothing is reserved.
2. In the hand-off authentication.
3. In the publication and CI check, before the CI read.
4. In the reservation transaction.
5. In the release transaction. A held PR fails it with `SANDBOX_APP_E_RELEASE_REFUSED`, so `ci_app_e_merge_released` is not recorded and the write is not sent.

Recognising a merge that already happened (`acceptsMerge`) is unchanged.

Not changed: `contained-mission-rpc.ts`, the route service, the switch, `packages/core`, any RPC method or schema, any table. `OSSTACK_BRIDGE=1` still refuses to start.

## 3. What it does not do

- It does not lift the start refusal (§5).
- It does not hold a merge made by a person or by any other identity on GitHub. The intake design §4.1 asks for a required check of the verification App on the platform side for that; it is not part of this node.
- It does not change the shadow Merger's "would merge" verdict. That must read the same hold before a live Merger exists.
- It does not stop an automatic approval of a CI repair push on an opted-in PR. That is a push, not a merge; the dispatch rules of the wiring design already allow one writer per root chain.

## 4. Chosen by the implementing session, not decided by the owner

1. **No release.** A passed, current recheck answers `verify_approval_required` and stays held. The intake design §4.1 lets a PR "enter the merge" once a trusted passed result and the host recheck exist; for App E this cannot happen for a repaired head (§1), and for a head that never failed no code defines "trusted passed result for the current head". The stricter reading was taken: an opted-in PR is never merged automatically.
2. **Held by stored facts, not by the switch.** The hold applies whether `OSSTACK_LOCAL_FAILURE_REPAIR` is on or off, and also when the grant has expired or the chain is closed or stopped.
3. **Ledger rows hold on their own.** An intake, dispatch or recheck row holds the PR even if the stored grant no longer says version 2.
4. **The release transaction is the cutoff.** A version 2 grant stored after `ci_app_e_merge_released` was committed does not stop the write that was already released. The window is the time between that commit and App E's request. Closing it would need the grant acceptance to refuse while a released merge is unsettled, which is a change to the grant path and not made here.
5. **The event is written before the push receipt is checked.** So an opted-in PR records `local_failure_merge_held` even when the merge would have been refused for another reason.
6. **The reasons** `verification_pending` (the intake design's word for the state) and `verify_approval_required` for a passed recheck are this node's choice of names.
7. From Codex, accepted: with several recheck rows at `awaiting_decision`, the first by chain id and recheck id gives the reason.

## 5. Still the owner's decision

The wiring design's decision 6 says the service refuses to start with the switch on and a merge path configured "until [W8] is merged". This node keeps that refusal. Removing it allows a start that is refused today, so it needs the owner's explicit yes, and is one condition in `assertLocalFailureRouteStartable` plus its tests. Until then the hold only acts where the switch is off and a version 2 chain exists.

## 6. Guards

New file `contained-mission-local-failure-merge-hold-guards.test.ts`, one test: the function and its module are named only in the module and in the merge module; the module has no write statement, no event write, no network call and no import of a publish, approval, dispatch, diagnosis, recheck-run or GitHub module; the merge module calls the hold exactly five times; the start refusal and its two calls are still present. No existing guard was edited.

## 7. Not verified

- No real repository, GitHub call, merge or container. App E's ports are test doubles.
- The live CI pilot and a version 2 chain were never run together on a real PR; `OSSTACK_BRIDGE=1` cannot start.
- The claim of §1 that App E refuses a locally repaired head rests on reading `pushReceipt` and on the existing tests, not on a new test with a real repair child.
