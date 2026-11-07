# Bridge revision-chain TLA+ model (phase 4-B)

`bridge.tla` models one revision chain on one PR: the chain ledger (chains, reservations, push
intents, shadow decisions), the child Missions, GitHub (branch history, base, open/closed,
reviews) and the daemon's in-memory state that a crash loses. It covers the row 模型检查 of design
§10.3: chain, heads, 2 registered reviewers, 1 outsider, crashes.

Sources: [design](../2026-11-01-osstack-grok-bridge.md) §8.3–§8.5, §8.7, §10.2–§10.3;
[phase 4 appendix](../2026-11-05-bridge-shadow-reconciler.md) §3–§4;
`packages/core/src/bridge/revision-chain.ts`,
`packages/core/src/state/engineering-revision-chain-ddl.ts` and `-store.ts`.

Modelling rule. The pure decision function, the store and the DDL are modelled as written. The
phase-5 callers that do not exist yet (`publishRevision`, start-up recovery, the dispatch driver,
human decisions) are modelled as the design describes them. Where the model needs a caller
assumption that the store does not enforce, a boolean constant names it (`StrictConfirmedHead`,
`OnePendingIntent`, `ResumeAfterReceipts`). Each one has a mutant showing what breaks without it.

## Files

| File | Purpose |
|---|---|
| `bridge.tla` | the spec, invariants, action property, coverage witnesses |
| `bridge.cfg` | main run: live chain, every guard on |
| `bridge-shadow.cfg` | shadow chain (`OSSTACK_BRIDGE=shadow`) |
| `bridge-rounds.cfg` | two full rounds: 3 review submissions, no outsider |
| `mutants/*.cfg` | one seeded bug each; every one must produce a counterexample (`store-many-pending-intents` uses the bounded `FocusPublish` constraint) |

## Running

TLC is `tla2tools.jar` v1.7.4 from the official `tlaplus/tlaplus` release
(sha256 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`), on Java 11+.
Keep TLC's working files out of the repository. Copy the specs to a scratch directory under
`$OSSTACK_SCRATCH_ROOT` and run there:

```sh
W="$OSSTACK_SCRATCH_ROOT/smoke/bridge-tla"; mkdir -p "$W"
cp -R docs/design/specs/bridge.tla docs/design/specs/*.cfg docs/design/specs/mutants "$W/"
cd "$W"
java -cp tla2tools.jar tla2sany.SANY bridge.tla                       # parse + level check
java -XX:+UseParallelGC -Xmx10g -cp tla2tools.jar tlc2.TLC -workers auto \
     -metadir "$W/meta" -config bridge.cfg bridge.tla
```

Mutants: `-config mutants/<name>.cfg`. Each mutant's first line names the property it must break.

Witnesses: each `W_*` definition is expected to be violated. Check one at a time:

```sh
for w in W_Reserved W_OneRoundExhausted W_LeaseFailed W_ExternalWrite W_HeadRegressed \
         W_ReviewerConflict W_IntentUncertain W_CrashAfterPush W_RecoveredPush W_SecondRoundPublished; do
  sed -e '/^INVARIANTS/,$d' bridge.cfg > w.cfg; printf 'INVARIANTS %s\n' "$w" >> w.cfg
  java -cp tla2tools.jar tlc2.TLC -workers auto -metadir "$W/meta-w" -config w.cfg bridge.tla | grep -E 'is violated|No error'
done
# W_TwoRoundsReady W_ThirdRequestStops: same loop with bridge-rounds.cfg
# W_ShadowWouldReserve W_ShadowStopped: same loop with bridge-shadow.cfg
```

## Results

Checked 2026-11-06 with TLC v1.7.4 (the jar above), OpenJDK 26, `-workers auto` on a 10-core,
16 GB Mac mini, `-XX:+UseParallelGC -Xmx10g`. SANY parses the module with no errors.

Full runs (exhaustive within the bounds; "distinct" counts states modulo reviewer symmetry):

| Config | Result | Generated | Distinct | Depth | Time |
|---|---|---|---|---|---|
| `bridge.cfg` (live) | no error | 212,416,199 | 28,702,050 | 45 | 9m00s |
| `bridge-shadow.cfg` | no error | 67,673 | 11,897 | 13 | 1s |
| `bridge-rounds.cfg` (3 reviews, no outsider) | no error | 273,209,571 | 40,562,634 | 43 | 13m57s |

Seeded bugs. Every mutant yields a counterexample (TLC stops at the first; "trace" is its length
in states):

| Mutant (`mutants/`) | Guard removed | Property broken | Trace |
|---|---|---|---|
| `no-lease` | `--force-with-lease` | `LeaseSafety` | 9 |
| `shadow-reserve` | every shadow layer (store mode check, DB triggers, grant shape, CHECK) | `ShadowNeverWrites` | 4 |
| `fence-no-chain` | chain check in the push fence | `NoPushAfterClose` (10); with `Inv4` alone: `Inv4` (11) | 10 |
| `no-rounds` | rounds check in decision, store and CHECK | `Inv1` | 13 |
| `no-reservation-pk` | reservation PK + `reserved_heads` | `Inv2` | 6 |
| `timeline-attribution` | head accepted only via a confirmed intent | `Inv6` | 4 |
| `no-grant-check` | grant re-validation (dispatch, fence) | `GrantSafety` | 6 |
| `store-any-confirmed-head` | caller passes only the intent extending `published_head` (D3) | `PublishedMonotone` | 22 |
| `resume-before-receipts` | human resume waits for receipts (D1) | `Inv4` | 23 |
| `store-many-pending-intents` | at most one pending push intent per child (D2) | `Inv4`: two pending intents, one confirmed, the stale one settles `uncertain` unbound, a later round pushes. Bounded search (one reviewer, `CONSTRAINT FocusPublish`); unbounded runs were stopped at 21M (2 reviewers) and 15M (1 reviewer) distinct states, before depth 24 | 24 |

Coverage witnesses (each expected violation was found, so the path is reachable):
`W_Reserved` (3), `W_ExternalWrite` (4), `W_ReviewerConflict` (4), `W_CrashAfterPush` (9),
`W_LeaseFailed` (9), `W_IntentUncertain` (10), `W_HeadRegressed` (11), `W_OneRoundExhausted` (11),
`W_RecoveredPush` (14), `W_SecondRoundPublished` (19); with `bridge-rounds.cfg`:
`W_TwoRoundsReady` (17), `W_ThirdRequestStops` (21); with `bridge-shadow.cfg`:
`W_ShadowWouldReserve` (4), `W_ShadowStopped` (3).

Mutant runs take 0–6 minutes each (the deep ones: `store-any-confirmed-head` 4m52s,
`resume-before-receipts` 5m26s, `store-many-pending-intents` 13s bounded).

What was bounded to keep runs to minutes (all recorded in "Abstractions"): 2 review submissions
in the main run (3 in the rounds run, without an outsider), 2 outsider writes, 2 push attempts
per child, crashes only while a publication is in flight, `GrantExpire` only while the chain is in
flight, `ReopenPR` only for closed chains, closed chains expanded only while a publication is in
flight, the reconciler as one atomic step. Live and shadow chains run as separate configs. One
earlier attempt with a separate observe step and 4 reviews reached more than 10M distinct states
with the queue still growing, which is why these bounds were chosen.

Model bugs TLC found while the spec was being written, fixed before the runs above: a
`Released(None)` evaluation (TLC splits `\/` inside actions), and a first `Reconciled` definition
that still counted a decision taken while a receipt was pending.

## Invariants

| Name | Design | Statement in the model |
|---|---|---|
| `Inv1` | §10.2 item 1 | live: `rounds_used ≤ grant.rounds ≤ 2` |
| `Inv2` | item 2 | at most one reservation row per (PR, head); rows are a set of records, so a void row and a new row on the same head are two rows |
| `Inv3`, `Inv3Active` | item 3 | at most one child that is dispatched and not (terminal with the stop proven); at most one `reserved`/`dispatched` row |
| `Inv4` | item 4 | ghost: no push while an external write or read-back mismatch is detected and no human chain decision has been taken since |
| — | item 5 | spec inheritance: phase 5, out of scope |
| `Inv6` | item 6 | when a reconciler cycle has just run, after recovery and with no pending push intent, a chain it left active has every branch commit beyond the root backed by a `confirmed` push intent |
| `Inv6Published` | item 6 | `published_head` is the root or a confirmed intent's `new_head` |
| `WriteAheadIntent` | §8.7 step 1 | no chain commit is on the branch without a pending, confirmed or uncertain intent |
| `PublishedMonotone` | §8.5 | action property: `published_head` only advances, one confirmed revision at a time |
| `LeaseSafety` | §8.7 step 5 | a chain push never discards a commit already on the branch |
| `ShadowNeverWrites` | appendix §1, §3.2 | a shadow chain has no reservation, no intent, no child, no in-flight state, 0 rounds, and never pushes |
| `NoPushAfterClose`, `GrantSafety` | §8.7.1, §8.7 step 4 | no push for a closed chain; no dispatch or push on an expired or revoked grant |

`Inv6` checks attribution against the PR state the reconciler acted on. A write that lands after
the read is the next cycle's business, and the lease and fence cover it in the meantime. A chain
the reconciler stopped is excluded on purpose, because a stop is how unexplained history is
handled. The two halves of design item 6 are therefore "accepted history has confirmed provenance"
(`Inv6Published`) and "unexplained history stops the chain" (`Inv6`).

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
| `VoidReservation` | `voidReservation` (stops the chain only when in flight) |
| `ClearCurrent` | `clearCurrentMission` + `engineering_chain_current_child_release` |
| `RecordIntent` | `recordIntent` + `engineering_intent_push_binding` |
| `PreCheck`, `Push`, `ReadBack`, `DropStaleIntent` | `publishRevision`, design §8.7 step 4 (phase 5); settles through `settleIntent` |
| `ConfirmIntent`, `UncertainIntent`, `FailIntent` | `settleIntent` (moves the chain only when the intent is bound) |
| `Crash`, `RecoverIntent`, `RecoverDone` | start-up receipt reconciliation, design §8.7 step 5 (phase 5) |
| `ChildDeliver`, `ChildFail`, `CancelRequest`, `CancelDone`, `ChildPublished`, `ProveStop` | contained-Mission runner states, `stop_obligation` |
| `Review`, `ExpireReview` | GitHub reviews, 24 h TTL (`REVIEW_TTL_MS`) |
| `OutsiderPush`, `OutsiderForcePush`, `BaseAdvance`, `ClosePR`, `ReopenPR`, `DeadlinePass`, `GrantExpire` | environment |
| `GrantStop`, `HumanResume`, `HumanClose`, `HumanResolveIntent` | phase-5 driver and human decisions (no code yet) |

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
- A closed chain is expanded only while a publication is still in flight.
- The review deadline and grant expiry are single booleans. Budgets (§8.6) are not modelled.
- Bounds: 2 reviewers, `MaxRounds = 2`, 2 push attempts per child, 2 review submissions
  (3 in `bridge-rounds.cfg`), 2 outsider writes.

## Discrepancies the model surfaced

| # | Where | Finding | Model |
|---|---|---|---|
| D1 | `settleIntent('uncertain')` vs design §8.7 step 5 ("其他 → uncertain，转人") | The store stops the chain only when the intent is bound (chain `publishing`, same head and child). An uncertain verdict on an unbound intent leaves the chain running. TLC found a 23-step trace: push lands → reservation voided → outsider pushes → human resumes while the intent is still pending → read-back `uncertain` (chain untouched) → human resolves it → outsider force-pushes back → the chain accepts the head and pushes round 2 with the external write never acted on. | `ResumeAfterReceipts`: human resume waits until no intent is pending or uncertain. Alternative fix: `settleIntent('uncertain')` stops any non-terminal chain. Mutant `resume-before-receipts`. |
| D2 | `recordIntent` | Nothing refuses a second `pending` push intent for the same child. With two, a stale one can settle `uncertain` while unbound (D1). | `OnePendingIntent`; suggested fix: partial unique index on push intents `(chain_id) WHERE state='pending'`. Mutant `store-many-pending-intents`. |
| D3 | `validateDecision` | Accepts a new head when *any* confirmed push intent has that `new_head`, not only the one extending `published_head`. After two rounds, an outsider force-push back to round 1's head is accepted as a legitimate head (a regression). The docstring of `confirmed_push_head` ("not yet reflected") expects the stricter rule. | `StrictConfirmedHead`; suggested fix: require `expected_old_head = published_head` in `validateDecision`. Mutant `store-any-confirmed-head` (`PublishedMonotone`). |
| D4 | `settleIntent('failed')` vs §8.7 step 2 ("意图 failed，转人") | `failed` never stops the chain; the caller must also call `voidReservation`. | `PreCheck` / lease failure void the reservation and stop the chain. |
| D5 | reservation lifecycle | A successful round leaves its reservation `dispatched`. `reserveInner` refuses the next round (`chain_busy`) until someone calls `voidReservation`. There is no `completed` state, and no code does this yet. | `VoidReservation` is a free driver action. |
| D6 | §8.5 "同事务：预留 + rounds_used+1 + 意图" | Reserve writes no intent. Intents are written at `recordIntent`. | code. |
| D7 | `listOpen` vs appendix §4.2 table ("任意非终态 → closed") | `awaiting_decision` chains are not scanned, so a stopped chain whose PR closes stays `awaiting_decision`. | code. |
| D8 | `decideChainStep` vs appendix §4.2 table | `in_flight` returns before reviewer conflict and deadline checks, so a conflict or deadline during a revision does not stop the chain (head and base changes still do). | code. |
| D9 | §8.5 child table ("恢复…同一个子 Mission") | No driver or protocol says how a chain returns to `revising`/`publishing` after the same child is resumed from `needs_reconciliation`. The design state machine has no such edge. | not modelled; the safety results do not cover same-child resume. |
| D10 | §8.7.4.6 "一个事务…子 Mission 转为终态" | `settleIntent` does not touch the Mission ledger. | separate `ChildPublished` step. |
| D11 | store vs §8.7.1 | No store method checks the grant's expiry or the principal's scope; only the (phase-5) caller can. | `ChecksGrant` on dispatch and push fence. Mutant `no-grant-check`. |
| D12 | `validateDecision` | No whitelist of transition targets: a hand-built `transition` decision whose head and base match is accepted for any `to` (for example `awaiting_decision` → `publishing` with the old child and reservation kept). Only `decideChainStep` output is modelled. | suggested fix: allow only the targets `decideChainStep` can produce (`closed`, `ready_for_human`, `awaiting_review`). |

## Review

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
| Push fence omits the runner's `stop_obligation = 0` check, and the model kept it set through `delivering` | Fixed: delivery clears `stopObl` (the store proves the stop before `verified`), and the fence requires it clear. All runs above are after this fix. |
| D9 claimed the store forbids resuming; `validateDecision` has no transition whitelist | Fixed: D9 reworded; the missing whitelist added as D12. |

Round 2 reported only these two findings (it was asked to check the round-1 fixes, the
constraint, `ResumeAfterReceipts` and the README claims). It was a static review; TLC was run
here afterwards.
