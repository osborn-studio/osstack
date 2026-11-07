# Bridge revision-chain TLA+ model (phase 5 ordering)

## Current verification revision (2026-11-07)

The historical tables below describe the earlier model. This revision adds a released process
that stops with an unknown result; rejection after a crash; pending versus released halt
reasons; halted-child cancel and abandon; grant renewal that keeps a halted chain stopped;
and expansion of closed chains with uncertain receipts. A human cannot settle an uncertain
receipt while a released process can still act. `Reconciled` now excludes uncertain receipts.
A same-child human resume clears the detection ghost, as a new human decision does.

`bridge-bounded.cfg` checks the full `Spec` exhaustively with one reviewer, one review submission,
one attempt per child, one outsider write and the two-round hard cap. It completed with
2,068,903 generated / 303,148 distinct states, depth 23, and an empty queue. This is bounded
exhaustive model checking, not simulation. `bridge-shadow.cfg` completed with 67,673 generated /
11,897 distinct states, depth 13. The revised full two-reviewer main run completed without error: 553,491,833 generated /
69,290,566 distinct states, depth 48, empty queue, exit 0. Wall time was 1h01 including a
SIGSTOP/SIGCONT scheduling suspension for parent serialized acceptance. The full three-review
rounds run remains pending; no pass is inferred from its progress counts.

Run the portable evidence runner from the repository root:

```sh
TLA2TOOLS_JAR=/path/to/tla2tools.jar JAVA=/path/to/java \
  node scripts/verify-bridge-phase5-tlc.mjs --bounded
# --main checks main, shadow and rounds; --mutants checks every guard config.
```

All fourteen existing guard mutants produced exhaustive invariant counterexamples on the
final model revision (portable runner output saved under the scratch evidence root). Outcome-only probes (removing `ResumeSafety`) found a
`ResumeOutcomeSafety` counterexample only for `resume-uncertain-intent`. The other three
resume probes completed without one: their forbidden historical transition is established by
`ResumeSafety`, whose ghost records the pre-resume facts, rather than by the state-only
`ResumeOutcomeSafety`. The latter must not be described as independently detecting all resume
mutants.

Remaining model limits: one commit per push and an assumed root baseline (the TypeScript
property now checks actual baseline intent plus multi-commit ordered ranges); close paths still
abstract the store's exact stop-reason and reservation cleanup; halted grant renewal preserves
the prior reason rather than modelling every R2 reason rewrite. These limits mean the historical
"all phase 5 gates complete" claim is not established by this model alone.

`bridge.tla` models one revision chain on one PR: the chain ledger (chains, reservations, push
intents, shadow decisions), the child Missions, GitHub (branch history, base, open/closed,
reviews) and the daemon's in-memory state that a crash loses. It covers the row 模型检查 of design
§10.3: chain, heads, 2 registered reviewers, 1 outsider, crashes.

Sources: [design](../2026-11-01-osstack-grok-bridge.md) §8.3–§8.5, §8.7, §10.2–§10.3;
[phase 4 appendix](../2026-11-05-bridge-shadow-reconciler.md) §3–§4;
[phase 5 resume and ordering](../2026-11-07-bridge-phase5-resume-and-ordering.md) §§3–7;
`packages/core/src/bridge/revision-chain.ts`,
`packages/core/src/state/engineering-revision-chain-ddl.ts` and `-store.ts`.

Modelling rule. The current decision function, store and DDL are the baseline. D8 and the
Phase 5 transaction and caller changes follow the approved design; several are still not
implemented. Where the model needs a caller assumption that the store does not enforce, a
boolean constant names it (`StrictConfirmedHead`, `OnePendingIntent`, `ResumeAfterReceipts`).
Each has a mutant showing what breaks without it.

## Files

| File | Purpose |
|---|---|
| `bridge.tla` | the spec, invariants, action property, coverage witnesses |
| `bridge.cfg` | main run: live chain, every guard on |
| `bridge-shadow.cfg` | shadow chain (`OSSTACK_BRIDGE=shadow`) |
| `bridge-rounds.cfg` | two full rounds: 3 review submissions, no outsider |
| `mutants/*.cfg` | one seeded bug each; every config has an exhaustive counterexample |

## Running and current results

SANY passes with official `tla2tools.jar` v1.7.4 (sha256
`936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`) and
`/opt/homebrew/opt/openjdk/bin/java`. The requested breadth-first TLC command is:

```sh
/opt/homebrew/opt/openjdk/bin/java -XX:+UseParallelGC \
  -cp /Volumes/AIMATE_WORK/Developer/tools/tla/v1.7.4/tla2tools.jar tlc2.TLC \
  -workers 4 -metadir /Volumes/AIMATE_WORK/tmp/osstack/smoke/bridge-tla-v2/meta \
  -config bridge.cfg bridge.tla
```

Run from this directory, outside any sandbox (breadth-first TLC opens a loopback socket), with a
distinct metadir for each config. Run each config from a bash script or array: zsh does not split
an unquoted command variable.

**Exhaustive breadth-first TLC (2026-11-07):**

| Config | Result | Generated | Distinct | Depth | Time |
|---|---|---:|---:|---:|---:|
| `bridge.cfg` | no error | 278,795,174 | 34,915,194 | 47 | 21m03s |
| `bridge-rounds.cfg` | no error | 312,871,419 | 42,603,642 | 45 | 13m34s |
| `bridge-shadow.cfg` | no error | 67,673 | 11,897 | 12 | <1s |

The first exhaustive runs found two counterexamples that random simulation had missed. Both were
modelling errors and are fixed in this revision:

1. `PendingBaseSafety` required a stop after the PR closed. `Decide`, like `decideChainStep`,
   returns a transition to `closed` before any head or base check, so the invariant now covers
   open PRs only.
2. `WriteAheadIntent`: a revision landed, an outsider pushed on top of it, and read-back settled
   the intent `uncertain` (correct). `HumanResolveIntent` then settled it `failed` because the
   remote head was not `new_head`. A truthful resolution asks whether `new_head` is *reachable*
   from the remote head, not whether it equals it. **Implementation rule for 5-E:**
   `chain-decide reconcile` decides "landed" by ancestry plus the range check, never by equality.

Every mutant config breaks its target property under exhaustive breadth-first TLC (shortest
counterexample, in states):

| Mutant | Broken property | Trace length |
|---|---|---:|
| `fence-no-chain` | `NoPushAfterClose` | 10 |
| `no-grant-check` | `GrantSafety` | 5 |
| `no-lease` | `LeaseSafety` | 11 |
| `no-reservation-pk` | `Inv2` | 7 |
| `no-rounds` | `Inv1` | 12 |
| `pending-push-skips-base` | `PendingBaseSafety` | 11 |
| `resume-after-push-rejected` | `ResumeSafety` | 11 |
| `resume-before-receipts` | `ResumeSafety` | 8 |
| `resume-uncertain-intent` | `ResumeSafety` | 10 |
| `resume-without-stop-proof` | `ResumeSafety` | 7 |
| `shadow-reserve` | `ShadowNeverWrites` | 3 |
| `store-any-confirmed-head` | `ConfirmedExtensionGuard` | 21 |
| `store-many-pending-intents` | `PendingIntentUniqueness` | 7 |
| `timeline-attribution` | `Inv6` | 3 |

Focused mutant configs keep the same transition actions and limit unrelated choices.
Their bounds are one or two reviewers, one or two reviews, zero to two outsider writes,
`MaxRounds = 2`, and `MaxAttempts = 2`; each `.cfg` records its exact constants and
state constraint. The main configs use two reviewers, two or three reviews, and zero or
two outsider writes. A counterexample is a real violating trace within these bounds;
the main-config results above are exhaustive within these bounds.

Reachability probes used one reviewer, one review, zero outsider writes and depth 60.
Expected violations were found for `W_ResumeEnabled` (358 checked), `W_ResumeRefused` (111),
`W_LateApplyEnabled` (1,736), `W_ApproveLandedEnabled` (1,529),
`W_NormalConfirmEnabled` (772), `W_PendingNoDec` (1,533), `W_PendingBaseStopped`
(591), `W_ReleasedBeforeStop` (620), `W_LateRemoteApply` (2,605), and
`W_ScanClosed` (475). The late-apply trace shows `Release`, then `HaltChild`, then
`RemoteApply`, with the chain still stopped.
The `ENABLED` probes establish that those actions can be taken from reachable states; they do
not prove that all continuations satisfy the invariants. Scratch logs are under the path above.

## Invariants

| Name | Design | Statement in the model |
|---|---|---|
| `Inv1` | §10.2 item 1 | live: `rounds_used ≤ grant.rounds ≤ 2` |
| `Inv2` | item 2 | at most one reservation row per (PR, head); rows are a set of records, so a void row and a new row on the same head are two rows |
| `Inv3`, `Inv3Active` | item 3 | at most one child that is dispatched and not (terminal with the stop proven); at most one `reserved`/`dispatched` row |
| `Inv4` | item 4 | ghost: no new release while an external write or read-back mismatch is detected and no human chain decision has been taken since |
| — | item 5 | spec inheritance: phase 5, out of scope |
| `Inv6` | item 6 | when a reconciler cycle has just run, after recovery and with no pending push intent, a chain it left active has every branch commit beyond the root backed by a `confirmed` push intent |
| `Inv6Published` | item 6 | `published_head` is the root or a confirmed intent's `new_head` |
| `WriteAheadIntent` | §8.7 step 1 | no chain commit is on the branch without a pending, confirmed or uncertain intent |
| `ResumeSafety`, `ResumeOutcomeSafety` | D1, D9 | guard-compliance flag for resume; a resumed running round has no unsettled intent or outstanding release marker, and has a fresh running stop obligation |
| `PendingIntentUniqueness`, `ConfirmedExtensionGuard` | D2–D3 | one pending intent per child; only a confirmed extension may be accepted |
| `PublishedMonotone` | §8.5 | action property: `published_head` only advances, one confirmed revision at a time |
| `LeaseSafety` | §8.7 step 5 | a remote apply never discards a commit already on the branch |
| `ShadowNeverWrites` | appendix §1, §3.2 | a shadow chain has no reservation, no intent, no child, no in-flight state, 0 rounds, and never releases |
| `NoPushAfterClose`, `NoReleaseAfterStop`, `GrantSafety` | §8.7.1, §8.7 step 4 | no new release after a local close or stop; no dispatch or release on an expired or revoked grant |

`Inv6` checks attribution against the PR state the reconciler acted on. A write that lands after
the read is the next cycle's business, and the lease and fence cover it in the meantime. A chain
the reconciler stopped is excluded on purpose, because a stop is how unexplained history is
handled. The two halves of design item 6 are therefore "accepted history has confirmed provenance"
(`Inv6Published`) and "unexplained history stops the chain" (`Inv6`).

`ResumeSafety` records whether a resume consulted its guards; it does not check the effects of a
successful resume. `ResumeOutcomeSafety` checks the resulting running round. The old stop
obligation must be clear before resume; starting execution creates a new obligation. With
`StrictConfirmedHead = TRUE`, `ConfirmedExtensionGuard` follows directly from `Acceptable` and
is trivially true. It has content in `store-any-confirmed-head`, where that flag is FALSE.
Under exhaustive TLC all four `resume-*` mutants stop at `ResumeSafety`, the first invariant
they break, so these runs do not show whether each also breaks `ResumeOutcomeSafety`; a
`-continue` run per mutant would (open for 5-F). `ResumeOutcomeSafety` holds in every main config.

Liveness is not checked. Most legitimate runs end waiting on a human (`awaiting_decision`, a child
whose stop is not proven, an `uncertain` receipt). Any useful progress property would need
fairness on human and reviewer actions that the design does not promise. Symmetry over
`Reviewers` is sound for every property checked here: none of them names a reviewer, and none is
a liveness property.

## Action → code mapping

| Model action | Code (or design, for phase 5) |
|---|---|
| `Reconcile` (`Decide`, `StoreReserveOK`) | `decideChainStep` + `reduceReviewers`; `RevisionChainStore.applyDecision` (`validateDecision`, `reserveInner`, `shadowDecision`); `listOpen` filter; DDL PK, `engineering_reservation_active`, `engineering_reservation_child_exclusive_insert`, `engineering_reservation_live_only`, grant CHECK |
| `Dispatch` | `RevisionChainStore.dispatch`; triggers `engineering_chain_current_child_set`, `engineering_chain_current_child_release`, `engineering_reservation_child_exclusive_dispatch`; design §8.7.1 grant check |
| `VoidReservation` | `voidReservation` (stops the chain only when in flight); normal D10 confirmation now voids it in the same transaction |
| `ClearCurrent` | `clearCurrentMission` + `engineering_chain_current_child_release` |
| `RecordIntent` | `recordIntent` + `engineering_intent_push_binding` |
| `PreCheck`, `Release`, `RemoteApply`, `PushRejected`, `ReleasedProcessLost`, `ReadBack`, `DropStaleIntent` | `publishRevision` and W13 `beforeRemoteMutation`/host process release; `RemoteApply` is the server update |
| `ConfirmPublication`, `LandedReceipt`, `ApproveLanded`, `UncertainIntent`, `FailIntent` | D10 `confirmRevisionPublication` transaction; recovery receipt reconciliation; R3 human `approve_publication` → `resumeLanded` |
| `Crash`, `RecoverIntent`, `RecoverDone` | start-up receipt reconciliation, design §8.7 step 5 (phase 5) |
| `ChildDeliver`, `ChildFail`, `HaltChild`, `CancelRequest`, `CancelDone`, `ProveStop` | contained-Mission runner states, `stop_obligation`, D9 stopped child |
| `Review`, `ExpireReview` | GitHub reviews, 24 h TTL (`REVIEW_TTL_MS`) |
| `OutsiderPush`, `OutsiderForcePush`, `BaseAdvance`, `ClosePR`, `ReopenPR`, `DeadlinePass`, `GrantExpire` | environment |
| `GrantStop`, `HumanResume`, `ResumeChild`, `ResumeRefused`, `HumanClose`, `HumanResolveIntent` | `stopLive` reasons, grant renewal, `resumeChild` through `acknowledgeAdvance`, `resume_refused` with no ledger change, human decisions |
| `ScanStopped` | D7 `listStoppedLive` / stopped-chain scan, `closeLive` and reservation void on closed or merged PR |

## Abstractions

- Commits are integers. The root is 0, the child revising head `c` produces exactly `c + 1`, and
  the outsider writes only `OutCommit`. One commit per push: a multi-commit push would need
  `Inv6` restated over the ancestry range of each confirmed intent (design wording is ambiguous).
- A child's id is the head it revises. This is exact while `Inv2` holds, since there is one
  reservation, and so one dispatch, per head.
- The reconciler reads the PR and applies its decision in one step. The store's revision CAS
  rejects a decision once the chain row has moved, so a read at t1 and a write at t2 with the PR
  changing in between ends in the same state as an atomic step at t1 followed by the PR change.
  Intents can change without a revision bump, but the store re-reads `confirmedPushHeads` inside
  the transaction. A stale *pending* set can only yield `none` or a false `external_write` stop,
  both safe. The `moved` second read is not modelled.
- Reviews: the reduced state per (reviewer, commit) is the latest decisive review, its freshness
  and two sticky flags (ever approved, ever dismissed). `COMMENTED` is a stuttering step and is
  omitted. Reviews are only submitted on the published head and the PR head; others are discarded
  by `reduceReviewers` and never become relevant. Expiry ages out every review of a (reviewer,
  commit) at once, which is exact because submission times are monotone. Registry filtering is
  not modelled (outsider reviews would be discarded before the decision; unit tests cover it).
- `stopObl` is the Mission's `stop_obligation`: set at dispatch, cleared when the child reaches
  `delivering` (the store requires the stop proven before `verified`), and required clear by the
  publication fence. `failed` with it still set also stands for `needs_reconciliation` / `stop_unknown`:
  the child is unreleased and blocks every dispatch until a human ends it and the stop is proven.
- Crashes are explored only while a push intent is pending or the publisher is mid-step. Any
  other crash loses nothing.
- Resolved in this revision (5-F, finding 4): durable releases can reject after a crash or
  take `ReleasedProcessLost` when the stopped process did not establish an outcome. Pre-release
  death is handled by `RecoverIntent`; an uncertain receipt remains for human reconciliation.
- A closed chain is expanded only while a publication is still in flight.
- Resolved in this revision (5-F, finding 11): `Explore` retains closed chains with pending
  or uncertain intents, so late human receipt settlement remains reachable.
- The review deadline and grant expiry are single booleans. Budgets (§8.6), scope permission,
  signed grant validation, the workspace claim and scanned-fact freshness are not modelled.
- `stopObl` combines stop proof and absence of an open host process. `released` is durable
  W13 release state; `RemoteApply` may run after a local stop. PR `CLOSED` and `MERGED` are
  represented by the same `prOpen = FALSE`. The scan rate limit and observation event are omitted.
- R2 grant replacement while a child is halted is not modelled. R3 landed-round recovery
  requires the separate human `ApproveLanded` action. Normal D10 confirmation changes the
  intent, chain, reservation and child together. A receipt after PR closure or base change
  confirms the remote fact while keeping the chain closed or stopped.
- Resolved in this revision (5-F, finding 5): `HaltChild` uses `child_halted` for a pending
  intent that was never released; only uncertain receipts or released work use `intent_uncertain`.
- Resolved in this revision (5-F, finding 6): a halted child can enter cancel or abandon;
  `ProveStop` and reservation release still gate subsequent dispatch.
- Partly resolved in this revision (5-F, finding 7): `HumanResume` keeps a halted child
  stopped until `ResumeChild`; exact R2 stop-reason rewrites remain abstracted.
- Open gap (5-F, finding 10): close paths retain `stopReason` and may leave active reservations.
  The store clears the reason and voids all active reservations on close.
- Mutant precision (finding 12): `resume-uncertain-intent` also widens the resumable-reason
  list; `resume-without-stop-proof` uses `Spec` while the other resume mutants use focused
  targets; and `resume-after-push-rejected` cannot explore a post-crash rejection.
- Bounds: 2 reviewers, `MaxRounds = 2`, 2 push attempts per child, 2 review submissions
  (3 in `bridge-rounds.cfg`), 2 outsider writes.

## Discrepancies the model surfaced

| # | Where | Finding | Model |
|---|---|---|---|
| D1 | `settleIntent('uncertain')` vs design §8.7 step 5 ("其他 → uncertain，转人") | The store stops the chain only when the intent is bound (chain `publishing`, same head and child). An uncertain verdict on an unbound intent leaves the chain running. TLC found a 23-step trace: push lands → reservation voided → outsider pushes → human resumes while the intent is still pending → read-back `uncertain` (chain untouched) → human resolves it → outsider force-pushes back → the chain accepts the head and pushes round 2 with the external write never acted on. | `ResumeAfterReceipts`: human resume waits until no intent is pending or uncertain. Alternative fix: `settleIntent('uncertain')` stops any non-terminal chain. Mutant `resume-before-receipts` (`ResumeSafety`). |
| D2 | `recordIntent` | Nothing refuses a second `pending` push intent for the same child. With two, a stale one can settle `uncertain` while unbound (D1). | `OnePendingIntent`; suggested fix: partial unique index on push intents `(chain_id) WHERE state='pending'`. Mutant `store-many-pending-intents` (`PendingIntentUniqueness`). |
| D3 | `validateDecision` | Accepts a new head when *any* confirmed push intent has that `new_head`, not only the one extending `published_head`. After two rounds, an outsider force-push back to round 1's head is accepted as a legitimate head (a regression). The docstring of `confirmed_push_head` ("not yet reflected") expects the stricter rule. | `StrictConfirmedHead`; suggested fix: require `expected_old_head = published_head` in `validateDecision`. Mutant `store-any-confirmed-head` (`ConfirmedExtensionGuard`; the original `PublishedMonotone` remains checked). |
| D4 | `settleIntent('failed'/'uncertain')` vs §8.7 step 2 ("意图 failed，转人") | The store stops a bound in-flight chain on `failed`; `uncertain` stops any chain not already stopped or closed. | `PreCheck` / lease failure stop and void; `Release` fence refusal stops the chain, fails the intent and halts the child in one step. The model's standalone settlement actions remain an abstraction. |
| D5 | reservation lifecycle | The current store leaves a successful round `dispatched`, blocking the next. The Phase 5 D10 transaction must void it when confirming publication. | `ConfirmPublication` voids atomically; `VoidReservation` remains for other exits. |
| D6 | §8.5 "同事务：预留 + rounds_used+1 + 意图" | Reserve writes no intent. Intents are written at `recordIntent`. | code. |
| D7 | `listOpen` vs appendix §4.2 table | `listOpen` still skips stopped chains; the separate live scan closes them when PR closes or merges and never resumes them. | `ScanStopped`; R4(a). |
| D8 | `decideChainStep` ordering | `in_flight` still returns before reviewer conflict and deadline. A base change inside the pending-push branch now stops with `base_changed`. | `Decide`, `PendingBaseSafety`, D8 mutant. |
| D9 | §8.5 child table | R1 resumes the same halted child in `revising` with its dispatched reservation and unchanged round count. It requires stop proof, no unsettled or confirmed push, live grant and unchanged PR facts; R5 rejects `push_rejected`. | `HaltChild`, `ResumeChild`, `ResumeSafety`, three mutants. |
| D10 | §8.7.4.6 | Phase 5 confirmation must update chain, reservation and child in one transaction. | `ConfirmPublication`; R3 recovery uses `LandedReceipt` then human `ApproveLanded`. |
| D11 | store vs §8.7.1 | No store method checks the grant's expiry or the principal's scope; only the (phase-5) caller can. | `ChecksGrant` on dispatch and push fence. Mutant `no-grant-check`. |
| D12 | `validateDecision` | No whitelist of transition targets: a hand-built `transition` decision whose head and base match is accepted for any `to` (for example `awaiting_decision` → `publishing` with the old child and reservation kept). Only `decideChainStep` output is modelled. | suggested fix: allow only the targets `decideChainStep` can produce (`closed`, `ready_for_human`, `awaiting_review`). |

## Review

The following is the historical Phase 4 review record; it does not establish a verdict for
this Phase 5 revision.

Two read-only adversarial review rounds by Codex (`gpt-6-astra`, reasoning effort medium) against
the design docs and the TS code.

Round 1 (12 findings, request changes):

| # | Finding | Disposition |
|---|---|---|
| 1 | Atomic reconciler hides the post-apply state from `Inv6` | Kept atomic (a split observe step multiplied the state space past the budget). The equivalence argument and the snapshot-relative reading of `Inv6` are stated under "Abstractions" and "Invariants". |
| 2 | `Inv6` weaker than design item 6 | Documented as two halves: `Inv6Published` and `Inv6`. |
| 3 | No grant expiry; dispatch lacks the §8.7.1 check | Fixed: `GrantExpire`, `GrantStop`, `ChecksGrant` on dispatch and fence, `GrantSafety`, mutant `no-grant-check`. |
| 4 | Pruning closed chains hides pushes after close | Fixed: closed chains are expanded while a publication is in flight; `ReopenPR`, `NoPushAfterClose`. |
| 5 | `justReconciled` missing from `vars` | Fixed; `TypeOK` extended. |
| 6 | `failed` is not `needs_reconciliation`; no same-child resume | Abstraction kept (same release behaviour); the missing resume protocol is listed as D9. |
| 7 | 2 reviews cannot reach the full two-round policy | Fixed: `bridge-rounds.cfg` and the `W_*` witnesses. |
| 8 | Store actions carry caller assumptions | Child `pr_opened` moved to a separate `ChildPublished`; `RecordIntent`'s assumptions documented. |
| 9 | Child id = head | Kept: exact while `Inv2` holds. |
| 10 | `Inv4` blind to closed/base read-back mismatches | Fixed: every `uncertain` read-back sets the detection ghost. |
| 11 | One commit per push | Documented abstraction; design wording flagged. |
| 12 | `listOpen` and the `in_flight` short-circuit vs the appendix table | Listed as D7, D8. |

Round 2 (2 findings):

| Finding | Disposition |
|---|---|
| Push fence omits the runner's `stop_obligation = 0` check, and the model kept it set through `delivering` | Fixed: delivery clears `stopObl` (the store proves the stop before `verified`), and the fence requires it clear. The Phase 4 runs were after this fix. |
| D9 claimed the store forbids resuming; `validateDecision` has no transition whitelist | Fixed: D9 reworded; the missing whitelist added as D12. |

Round 2 reported only these two findings (it was asked to check the round-1 fixes, the
constraint, `ResumeAfterReceipts` and the README claims). It was a static review; TLC was run
here afterwards.
