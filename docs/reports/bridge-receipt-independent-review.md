# Receipt recovery independent review

Reviewed changes: `4da09d92` (receipt recovery, runner routing and core receipt bookkeeping) and `c85598c2` (released-push rejection proof). The reviewer did not author those changes. This report does not independently approve the reviewer's production factory or invariant 6 implementation.

## P2: recovery depends on un-fetched remote objects

`readReceipt` in `contained-mission-revision-publication.ts:262` at `4da09d92` originally ran local `merge-base --is-ancestor new_head remote` before its remote range comparisons. The production receipt read adapter permits hardened reads but never fetches the observed remote head. If another writer advances the remote after the host's push, the new remote commit can be absent from the local object database. Git exits 128. Recovery then treats a provable receipt as a transient read failure on every attempt.

Reproduction uses two real Git repositories. Clone after the published revision, create a descendant only in the origin, and verify that the clone cannot resolve that object. Supply exact remote ranges from the origin. The original receipt reader still fails with `HARDENED_GIT_FAILED: git merge-base ... Not a valid commit name`.

Correction: production receipt adapters now provide `remoteIsDescendant`, a host-credential GitHub compare read that requires `status: ahead` and the exact expected merge base. The exact recorded range and its prefix in remote history remain mandatory. Callers without that port retain the local ancestry check. Production cumulative comparisons also page beyond the per-revision 64-commit bound, so an external descendant cannot make a valid 64-commit receipt permanently unreadable.

The real-Git missing-object regression failed before the correction and passes after it. Existing contradictory-ancestry and exact-prefix regressions still pass. The correction requires independent review; this report records the original finding and its reproduction.

## Released push classification

No additional actionable finding in `c85598c2`. `explicitlyRejectedPush` (`contained-mission-revision-publication.ts:475` at that commit) only fails a released push when nonzero exit, unchanged remote head and structured porcelain rejection for the exact destination ref agree. Transport/authentication stderr alone stays uncertain. It therefore does not mistake a delayed accepted push for a proven rejection. A later remote head and exact receipt remain subject to recovery rather than another push.

## Other inspected boundaries

- No release record settles as never released; a released process without stop proof remains unresolved.
- Receipt reads do not issue a push or acquire App A credentials.
- Recovery compares the journaled range and rechecks the current ledger before confirmation. Confirmation, child outcome, reservation and evidence use one transaction.
- Transient reads and cancellation do not create a second publication attempt.
- Owner checks remain at ledger writes; K1–K6 crash tests cover the confirmation/check boundary.

Validation: the live/recovery/receipt-adapter targeted suite passed 174 tests before the additional 65-commit production-reader test. That added test and final typecheck are recorded with the correction commit.

## Separate invariant 6 review correction

The parent's independent review found that the first invariant 6 hook returned on `reconciliation_incomplete` before independent base/ref/protected-set checks. Three tests with real released pending ledger rows reproduced missing stop/cancel actions. The hook now follows those independent safety checks. Only commit-coverage judgment is deferred; a changed base, PR route or protected set still stops and cancels the in-flight child.
