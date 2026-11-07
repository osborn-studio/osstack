------------------------------- MODULE bridge -------------------------------
(***************************************************************************)
(* osstack x Grok bridge: revision-chain model (bridge phase 4-B).         *)
(*                                                                         *)
(* Sources: docs/design/2026-11-01-osstack-grok-bridge.md S8.3-S8.5, S8.7, *)
(* S10.2-S10.3; docs/design/2026-11-05-bridge-shadow-reconciler.md S3-S4;  *)
(* packages/core/src/bridge/revision-chain.ts (decideChainStep),           *)
(* packages/core/src/state/engineering-revision-chain-ddl.ts and -store.ts.*)
(*                                                                         *)
(* One chain on one PR. Commits are integers: 0 is the root (the commit    *)
(* the root Mission published), the child that revises head c produces     *)
(* commit c + 1, and OutCommit is the only commit an outsider writes.      *)
(* Persisted state (the SQLite ledger, the Mission ledger, GitHub) survives*)
(* Crash; the publisher's in-memory progress does not.                     *)
(*                                                                         *)
(* The store, DDL and pure decision function are modelled as written. The  *)
(* phase-5 callers that do not exist yet (publishRevision, start-up        *)
(* recovery, the dispatch driver, human decisions) are modelled as the     *)
(* design describes them. Boolean constants switch individual guards off   *)
(* for the mutant configurations in mutants/; bridge.cfg sets all TRUE.    *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets, TLC

CONSTANTS
  Modes,              \* chain modes explored: {"live"}, {"shadow"} or both
  Reviewers,          \* registered reviewer identities (model values)
  MaxRounds,          \* hard cap on grant.rounds (design: 2)
  MaxAttempts,        \* push intents per child (retry after failed)
  MaxReviews,         \* bound on review submissions (state-space bound)
  MaxOutsiderWrites,  \* bound on outsider pushes / force pushes
  OutCommit,          \* the outsider's commit id
  \* Guards; TRUE = as implemented / designed. FALSE = seeded bug (mutants/).
  UseLease,           \* push uses --force-with-lease=<branch>:<expected_old_head>
  FenceChecksChain,   \* beforeRemoteMutation re-checks the chain (S8.7 step 4)
  ShadowGuard,        \* every "shadow never reserves" layer (store mode check,
                      \* DB live_only triggers, shadow grant shape, DB CHECK)
  CheckRounds,        \* every rounds layer (decision, store, DB CHECK)
  ReservePK,          \* reservation PK (repository, pr, head) + reserved_heads check
  AcceptOnlyConfirmed,\* a new head is accepted only via a confirmed push intent
  StrictConfirmedHead,\* caller passes only the confirmed intent extending published_head
  OnePendingIntent,   \* caller never records a second pending push intent per child
  ResumeAfterReceipts,\* a human resume waits until no push intent is pending or uncertain
  ChecksGrant         \* grant / write scope re-validated before dispatch and before each push

ASSUME Modes \subseteq {"live", "shadow"} /\ Modes # {}
ASSUME MaxRounds \in 1..2 /\ MaxAttempts \in 1..3 /\ MaxReviews \in Nat
ASSUME MaxOutsiderWrites \in Nat /\ OutCommit \in Nat /\ OutCommit > MaxRounds + 1
ASSUME \A f \in {UseLease, FenceChecksChain, ShadowGuard, CheckRounds, ReservePK,
                 AcceptOnlyConfirmed, StrictConfirmedHead, OnePendingIntent,
                 ResumeAfterReceipts, ChecksGrant} : f \in BOOLEAN

VARIABLES
  \* chain ledger (engineering_revision_chains / _reservations / _publication_intents / shadow decisions)
  mode, cState, stopReason, publishedHead, publishedBase, roundsUsed, grantRounds,
  res,            \* set of reservation rows [head, st, child]
  intent,         \* intent[c][a]: push intent attempt a of the child revising head c
  currentChild,   \* current_mission_id (child id = the head it revises), None if null
  shadowWould,    \* heads with a recorded would_reserve (shadow reserved_heads)
  \* Mission ledger (child Missions)
  childSt, stopObl,
  \* GitHub
  branch, base, prOpen,
  rv, fresh, everApproved, everDismissed,  \* per registered reviewer and commit
  deadlinePassed, grantValid, reviewCount, outsiderWrites,
  \* in-memory daemon state, lost on Crash
  pub, recovering, justReconciled,
  \* ghost variables for the invariants
  detected, pushWhileDetected, clobbered, chainPushed, pushedWhileClosed, actedWithoutGrant

chainVars == <<mode, cState, stopReason, publishedHead, publishedBase, roundsUsed, grantRounds,
               res, intent, currentChild, shadowWould>>
childVars == <<childSt, stopObl>>
reviewVars == <<rv, fresh, everApproved, everDismissed, reviewCount>>
envVars == <<branch, base, prOpen, reviewVars, deadlinePassed, grantValid, outsiderWrites>>
procVars == <<pub, recovering>>
ghostVars == <<detected, pushWhileDetected, clobbered, chainPushed, pushedWhileClosed, actedWithoutGrant>>
vars == <<chainVars, childVars, envVars, procVars, ghostVars, justReconciled>>

-----------------------------------------------------------------------------
None == -1
Root == 0
ChainCommits == 0..(MaxRounds + 1)
Commits == ChainCommits \cup {OutCommit}
Children == 0..MaxRounds
Attempts == 1..MaxAttempts

States == {"awaiting_review", "revision_reserved", "revising", "publishing",
           "ready_for_human", "closed", "awaiting_decision"}
InFlight == {"revision_reserved", "revising", "publishing"}
ChildStates == {"none", "running", "delivering", "pr_opened", "failed",
                "cancel_requested", "cancelled", "abandoned", "needs_reconciliation"}
ChildTerminal == {"pr_opened", "cancelled", "abandoned", "failed"}
IntentStates == {"none", "pending", "confirmed", "failed", "uncertain"}
ResStates == {"reserved", "dispatched", "void"}
ReviewVals == {"none", "APPROVED", "CR", "CR_EMPTY"}   \* CR = CHANGES_REQUESTED with feedback
Decisive == {"APPROVED", "CR", "CR_EMPTY"}
\* Stops that mean "someone else wrote the branch" (invariant 4).
DetectReasons == {"external_write", "head_regressed", "attribution_unknown"}

Last(s) == s[Len(s)]
Range(s) == {s[i] : i \in DOMAIN s}
IsPrefix(s, t) == Len(s) <= Len(t) /\ SubSeq(t, 1, Len(s)) = s
ChainHist(c) == [i \in 1..(c + 1) |-> i - 1]

Idle == [stage |-> "idle", c |-> 0, a |-> 1]

Released(c) == childSt[c] \in ChildTerminal /\ ~stopObl[c]
\* IF, not \/: TLC splits disjunctions inside actions and would evaluate Released(None).
CurrentReleased == IF currentChild = None THEN TRUE ELSE Released(currentChild)
Active(row) == row.st \in {"reserved", "dispatched"}
HasRow(h) == \E row \in res : row.head = h
VoidIf(row, h) == IF row.head = h /\ Active(row) THEN [row EXCEPT !.st = "void"] ELSE row
VoidRows(h) == {VoidIf(row, h) : row \in res}

ConfirmedHeads == {c + 1 : c \in {d \in Children : \E a \in Attempts : intent[d][a] = "confirmed"}}
NoPending == \A c \in Children, a \in Attempts : intent[c][a] # "pending"
\* settleIntent's binding check: the intent extends what the chain published, for its current child.
Bound(c) == cState = "publishing" /\ publishedHead = c /\ currentChild = c

-----------------------------------------------------------------------------
(* decideChainStep (revision-chain.ts). The reconciler reads the PR and    *)
(* applies the decision in one atomic step. This loses no behaviour: the   *)
(* store's revision CAS rejects a decision once the chain row has moved,   *)
(* so a read at t1 and write at t2 with the PR changing in between ends in *)
(* the same state as an atomic step at t1 followed by the PR change. The   *)
(* `moved` second read is therefore not modelled either.                   *)

Snap == [branch |-> branch, base |-> base, open |-> prOpen]

SnapHead == Last(Snap.branch)
IsDesc == publishedHead \in Range(Snap.branch)

\* opts.confirmed_push_head + store.validateDecision (confirmedPushHeads includes it).
Acceptable(h) ==
  /\ mode = "live"
  /\ \/ \E c \in Children, a \in Attempts :
          /\ intent[c][a] = "confirmed" /\ c + 1 = h
          /\ (StrictConfirmedHead => c = publishedHead)
     \/ (~AcceptOnlyConfirmed /\ IsDesc)
\* opts.pending_push_head
PendingHead(h) == \E c \in Children, a \in Attempts : intent[c][a] = "pending" /\ c + 1 = h

\* reduceReviewers: latest decisive review per registered reviewer on the head, expired ones dropped.
Part == {r \in Reviewers : rv[r][publishedHead] \in Decisive /\ fresh[r][publishedHead]}
Appr == {r \in Part : rv[r][publishedHead] = "APPROVED"}
Req == {r \in Part : rv[r][publishedHead] \in {"CR", "CR_EMPTY"}}
WithFb == {r \in Req : rv[r][publishedHead] = "CR"}
\* ready_for_human is not withdrawn when approvals only aged out and nobody dismissed.
ExpiryHold ==
  /\ \E r \in Reviewers : everApproved[r][publishedHead] /\ ~fresh[r][publishedHead]
  /\ \A r \in Reviewers : ~everDismissed[r][publishedHead]
ReservedHead(h) == IF mode = "live" THEN HasRow(h) ELSE h \in shadowWould

Dec(k, t, r, h) == [kind |-> k, to |-> t, reason |-> r, head |-> h]
NoDec == Dec("none", "none", "none", None)
StopDec(r) == Dec("stop", "awaiting_decision", r, None)
TransDec(t, r) == Dec("transition", t, r, None)
AcceptDec(h) == Dec("accept", "awaiting_review", "push_confirmed", h)
ReserveDec == Dec("reserve", "revision_reserved", "changes_requested", None)

Decide ==
  LET h == SnapHead IN
  IF cState = "closed" THEN NoDec
  ELSE IF ~Snap.open THEN TransDec("closed", "pr_closed")
  ELSE IF cState = "awaiting_decision" THEN NoDec
  ELSE IF h # publishedHead /\ mode = "shadow" THEN StopDec("attribution_unknown")
  ELSE IF h # publishedHead /\ ~Acceptable(h) /\ PendingHead(h) THEN NoDec
  ELSE IF h # publishedHead /\ ~Acceptable(h)
       THEN StopDec(IF IsDesc THEN "external_write" ELSE "head_regressed")
  ELSE IF Snap.base # publishedBase THEN StopDec("base_changed")
  ELSE IF h # publishedHead THEN AcceptDec(h)
  ELSE IF cState \in InFlight THEN NoDec
  ELSE IF Appr # {} /\ Req # {} THEN StopDec("reviewer_conflict")
  ELSE IF Appr # {}
       THEN (IF cState = "ready_for_human" THEN NoDec
             ELSE TransDec("ready_for_human", "all_participating_approved"))
  ELSE IF Req # {}
       THEN (IF ReservePK /\ ReservedHead(publishedHead) THEN NoDec
             ELSE IF WithFb = {} THEN StopDec("no_feedback")
             ELSE IF mode = "live" /\ CheckRounds /\ roundsUsed >= grantRounds
                  THEN StopDec("rounds_exhausted")
             ELSE ReserveDec)
  ELSE IF cState = "ready_for_human"
       THEN (IF ExpiryHold THEN NoDec ELSE TransDec("awaiting_review", "approval_withdrawn"))
  ELSE IF cState = "awaiting_review" /\ deadlinePassed THEN StopDec("review_deadline")
  ELSE NoDec

\* store.reserveInner + DDL (PK, engineering_reservation_active, reservation_child_exclusive_insert,
\* live_only trigger, grant CHECK).
StoreReserveOK ==
  /\ cState \in {"awaiting_review", "ready_for_human"}
  /\ IF mode = "shadow" THEN ~ShadowGuard ELSE (CheckRounds => roundsUsed < grantRounds)
  /\ ~\E row \in res : Active(row)
  /\ (ReservePK => ~HasRow(publishedHead))
  /\ publishedHead \in Children
  /\ CurrentReleased
  /\ \A row \in res : (row.child /\ row.head # publishedHead) => Released(row.head)

-----------------------------------------------------------------------------
Init ==
  /\ mode \in Modes
  /\ grantRounds \in (IF mode = "live" THEN 1..MaxRounds ELSE {0})
  /\ cState = "awaiting_review" /\ stopReason = "none"
  /\ publishedHead = Root /\ publishedBase = 0 /\ roundsUsed = 0
  /\ res = {} /\ intent = [c \in Children |-> [a \in Attempts |-> "none"]]
  /\ currentChild = None /\ shadowWould = {}
  /\ childSt = [c \in Children |-> "none"] /\ stopObl = [c \in Children |-> FALSE]
  /\ branch = <<Root>> /\ base = 0 /\ prOpen = TRUE
  /\ rv = [r \in Reviewers |-> [h \in Commits |-> "none"]]
  /\ fresh = [r \in Reviewers |-> [h \in Commits |-> TRUE]]
  /\ everApproved = [r \in Reviewers |-> [h \in Commits |-> FALSE]]
  /\ everDismissed = [r \in Reviewers |-> [h \in Commits |-> FALSE]]
  /\ deadlinePassed = FALSE /\ grantValid = TRUE /\ reviewCount = 0 /\ outsiderWrites = 0
  /\ pub = Idle /\ recovering = FALSE /\ justReconciled = FALSE
  /\ detected = FALSE /\ pushWhileDetected = FALSE /\ clobbered = FALSE /\ chainPushed = FALSE
  /\ pushedWhileClosed = FALSE /\ actedWithoutGrant = FALSE

-----------------------------------------------------------------------------
(* Reconciler cycle (listOpen skips closed and awaiting_decision chains).  *)

Reconcile ==
  /\ ~recovering /\ cState \notin {"closed", "awaiting_decision"}
  /\ LET d == Decide IN
     \/ /\ d.kind = "none"
        /\ UNCHANGED <<chainVars, ghostVars>>
     \/ /\ d.kind = "transition"
        /\ cState' = d.to /\ stopReason' = "none"
        /\ UNCHANGED <<mode, publishedHead, publishedBase, roundsUsed, grantRounds, res, intent,
                       currentChild, shadowWould, ghostVars>>
     \/ /\ d.kind = "stop"
        /\ cState' = "awaiting_decision" /\ stopReason' = d.reason
        /\ detected' = (detected \/ d.reason \in DetectReasons)
        /\ UNCHANGED <<mode, publishedHead, publishedBase, roundsUsed, grantRounds, res, intent,
                       currentChild, shadowWould, pushWhileDetected, clobbered, chainPushed, pushedWhileClosed,
                       actedWithoutGrant>>
     \/ /\ d.kind = "accept"
        /\ cState' = "awaiting_review" /\ stopReason' = "none" /\ publishedHead' = d.head
        /\ UNCHANGED <<mode, publishedBase, roundsUsed, grantRounds, res, intent, currentChild,
                       shadowWould, ghostVars>>
     \/ /\ d.kind = "reserve" /\ mode = "shadow" /\ ShadowGuard
        \* would_reserve: engineering_shadow_decisions only; a ready chain goes back to review
        /\ shadowWould' = shadowWould \cup {publishedHead}
        /\ cState' = IF cState = "ready_for_human" THEN "awaiting_review" ELSE cState
        /\ UNCHANGED <<mode, stopReason, publishedHead, publishedBase, roundsUsed, grantRounds, res,
                       intent, currentChild, ghostVars>>
     \/ /\ d.kind = "reserve" /\ (mode = "live" \/ ~ShadowGuard)
        /\ IF StoreReserveOK
             THEN /\ res' = res \cup {[head |-> publishedHead, st |-> "reserved", child |-> FALSE]}
                  /\ roundsUsed' = roundsUsed + 1
                  /\ cState' = "revision_reserved"
             ELSE UNCHANGED <<res, roundsUsed, cState>>   \* the store throws; nothing written
        /\ UNCHANGED <<mode, stopReason, publishedHead, publishedBase, grantRounds, intent,
                       currentChild, shadowWould, ghostVars>>
  /\ justReconciled' = TRUE
  /\ UNCHANGED <<childVars, envVars, pub, recovering>>

-----------------------------------------------------------------------------
(* Dispatch driver (phase 5) over store.dispatch / voidReservation /        *)
(* clearCurrentMission and their DDL triggers.                              *)

Dispatch ==
  /\ ~recovering /\ (mode = "live" \/ ~ShadowGuard) /\ cState = "revision_reserved"
  /\ (ChecksGrant => grantValid)                    \* S8.7.1: re-validated before every dispatch
  /\ \E row \in res :
       /\ row.st = "reserved"
       /\ CurrentReleased                                              \* current_child_release
       /\ \A o \in res : (o.child /\ o.head # row.head) => Released(o.head)  \* child_exclusive_dispatch
       /\ res' = (res \ {row}) \cup {[row EXCEPT !.st = "dispatched", !.child = TRUE]}
       /\ currentChild' = row.head
       /\ childSt' = [childSt EXCEPT ![row.head] = "running"]
       /\ stopObl' = [stopObl EXCEPT ![row.head] = TRUE]
  /\ cState' = "revising"
  /\ actedWithoutGrant' = (actedWithoutGrant \/ ~grantValid)
  /\ UNCHANGED <<mode, stopReason, publishedHead, publishedBase, roundsUsed, grantRounds, intent,
                 shadowWould, envVars, procVars, detected, pushWhileDetected, clobbered, chainPushed,
                 pushedWhileClosed>>

\* Any reason (child failed/cancelled, round completed, ...): a chain still in flight stops.
VoidReservation ==
  /\ \E row \in res :
       /\ Active(row)
       /\ res' = (res \ {row}) \cup {[row EXCEPT !.st = "void"]}
  /\ IF cState \in InFlight
       THEN cState' = "awaiting_decision" /\ stopReason' = "reservation_void"
       ELSE UNCHANGED <<cState, stopReason>>
  /\ UNCHANGED <<mode, publishedHead, publishedBase, roundsUsed, grantRounds, intent, currentChild,
                 shadowWould, childVars, envVars, procVars, ghostVars>>

ClearCurrent ==
  /\ cState # "closed" /\ currentChild # None
  /\ Released(currentChild)
  /\ ~\E row \in res : row.head = currentChild /\ Active(row)
  /\ currentChild' = None
  /\ UNCHANGED <<mode, cState, stopReason, publishedHead, publishedBase, roundsUsed, grantRounds,
                 res, intent, shadowWould, childVars, envVars, procVars, ghostVars>>

-----------------------------------------------------------------------------
(* Publication: store.recordIntent, then publishRevision (S8.7 step 4),     *)
(* settled through store.settleIntent.                                      *)

RecordIntent ==
  /\ ~recovering /\ mode = "live" /\ cState \in {"revising", "publishing"}
  /\ currentChild # None /\ childSt[currentChild] = "delivering"
  /\ \E row \in res : row.head = currentChild /\ row.st = "dispatched"
  /\ publishedHead = currentChild           \* intent_push_binding: expected_old_head = published_head
  /\ (OnePendingIntent => \A b \in Attempts : intent[currentChild][b] # "pending")
  /\ \E a \in Attempts :
       /\ intent[currentChild][a] = "none"
       /\ \A b \in Attempts : b < a => intent[currentChild][b] # "none"
       /\ intent' = [intent EXCEPT ![currentChild][a] = "pending"]
  /\ cState' = "publishing"
  /\ UNCHANGED <<mode, stopReason, publishedHead, publishedBase, roundsUsed, grantRounds, res,
                 currentChild, shadowWould, childVars, envVars, procVars, ghostVars>>

ConfirmIntent(c, a) ==
  /\ intent' = [intent EXCEPT ![c][a] = "confirmed"]
  /\ IF Bound(c)
       THEN /\ publishedHead' = c + 1 /\ cState' = "awaiting_review" /\ stopReason' = "none"
       ELSE UNCHANGED <<publishedHead, cState, stopReason>>
  \* settleIntent touches the intent and the chain only; the child's terminal transition is
  \* ChildPublished, a separate Mission-ledger write (a crash may fall between the two).
  /\ UNCHANGED <<mode, publishedBase, roundsUsed, grantRounds, res, currentChild, shadowWould,
                 childVars, envVars, ghostVars>>

UncertainIntent(c, a) ==
  /\ intent' = [intent EXCEPT ![c][a] = "uncertain"]
  /\ IF Bound(c)
       THEN cState' = "awaiting_decision" /\ stopReason' = "intent_uncertain"
       ELSE UNCHANGED <<cState, stopReason>>
  \* Every read-back mismatch blocks further pushes until a human decides (S10.2 item 4), whether
  \* or not it proves an outsider wrote the branch (PR closed or base moved also land here).
  /\ detected' = TRUE
  /\ UNCHANGED <<mode, publishedHead, publishedBase, roundsUsed, grantRounds, res, currentChild,
                 shadowWould, childVars, envVars, pushWhileDetected, clobbered,
                 chainPushed, pushedWhileClosed, actedWithoutGrant>>

FailIntent(c, a) ==
  /\ intent' = [intent EXCEPT ![c][a] = "failed"]
  /\ UNCHANGED <<mode, cState, stopReason, publishedHead, publishedBase, roundsUsed, grantRounds,
                 res, currentChild, shadowWould, childVars, envVars, ghostVars>>

\* Step 2: read the PR. Mismatch: intent failed, reservation void, chain to a human.
PreCheck ==
  /\ ~recovering /\ pub.stage = "idle"
  /\ \E c \in Children, a \in Attempts :
       /\ intent[c][a] = "pending" /\ Bound(c)
       /\ IF prOpen /\ Last(branch) = c /\ base = publishedBase
            THEN /\ pub' = [stage |-> "checked", c |-> c, a |-> a]
                 /\ UNCHANGED <<chainVars, childVars, envVars, recovering, ghostVars>>
            ELSE /\ intent' = [intent EXCEPT ![c][a] = "failed"]
                 /\ res' = VoidRows(c)
                 /\ cState' = "awaiting_decision" /\ stopReason' = "precheck_failed"
                 /\ detected' = (detected \/ Last(branch) # c)
                 /\ UNCHANGED <<mode, publishedHead, publishedBase, roundsUsed, grantRounds,
                                currentChild, shadowWould, childVars, envVars, procVars,
                                pushWhileDetected, clobbered, chainPushed, pushedWhileClosed,
                       actedWithoutGrant>>

\* A pending intent the publisher will not push (chain moved on, stopped, child cancelled).
DropStaleIntent ==
  /\ ~recovering /\ pub.stage = "idle"
  /\ \E c \in Children, a \in Attempts :
       /\ intent[c][a] = "pending" /\ ~Bound(c)
       /\ FailIntent(c, a)
  /\ UNCHANGED <<pub, recovering>>

\* Step 4 fence (beforeRemoteMutation + chain checks), immediately followed by step 5.
Fence(c, a) ==
  /\ intent[c][a] = "pending" /\ childSt[c] = "delivering" /\ ~stopObl[c]   \* runner.ts fence
  /\ (ChecksGrant => grantValid)
  /\ (FenceChecksChain => Bound(c))

Push ==
  /\ ~recovering /\ pub.stage = "checked"
  /\ LET c == pub.c
         a == pub.a
     IN \/ /\ Fence(c, a) /\ (~UseLease \/ Last(branch) = c)
           /\ branch' = IF Last(branch) = c THEN Append(branch, c + 1)
                        ELSE Append(ChainHist(c), c + 1)       \* plain force push
           /\ clobbered' = (clobbered \/ ~IsPrefix(branch, branch'))
           /\ pushWhileDetected' = (pushWhileDetected \/ detected)
           /\ chainPushed' = TRUE
           /\ pushedWhileClosed' = (pushedWhileClosed \/ cState = "closed")
           /\ actedWithoutGrant' = (actedWithoutGrant \/ ~grantValid)
           /\ pub' = [pub EXCEPT !.stage = "pushed"]
           /\ UNCHANGED <<chainVars, childVars, base, prOpen, reviewVars, deadlinePassed, grantValid,
                          outsiderWrites, recovering, detected>>
        \/ /\ Fence(c, a) /\ UseLease /\ Last(branch) # c
           \* lease rejected by the server: an outsider wrote the branch
           /\ intent' = [intent EXCEPT ![c][a] = "failed"]
           /\ res' = VoidRows(c)
           /\ IF cState \in InFlight
                THEN cState' = "awaiting_decision" /\ stopReason' = "lease_failed"
                ELSE UNCHANGED <<cState, stopReason>>
           /\ detected' = TRUE
           /\ pub' = Idle
           /\ UNCHANGED <<mode, publishedHead, publishedBase, roundsUsed, grantRounds, currentChild,
                          shadowWould, childVars, envVars, recovering,
                          pushWhileDetected, clobbered, chainPushed, pushedWhileClosed,
                          actedWithoutGrant>>
        \/ /\ ~Fence(c, a)
           /\ FailIntent(c, a)
           /\ pub' = Idle
           /\ UNCHANGED recovering

\* Step 6: read back.
ReadBack ==
  /\ ~recovering /\ pub.stage = "pushed"
  /\ LET c == pub.c
         a == pub.a
     IN IF prOpen /\ Last(branch) = c + 1 /\ base = publishedBase
          THEN ConfirmIntent(c, a)
          ELSE UncertainIntent(c, a)
  /\ pub' = Idle
  /\ UNCHANGED recovering

-----------------------------------------------------------------------------
(* Crash and read-only receipt reconciliation (S8.7 step 5).               *)

\* Only crashes that can lose publication progress are explored: with no pending intent and an
\* idle publisher there is no in-memory state to lose.
Crash ==
  /\ pub.stage # "idle" \/ ~NoPending
  /\ pub' = Idle /\ recovering' = TRUE
  /\ UNCHANGED <<chainVars, childVars, envVars, ghostVars>>

RecoverIntent ==
  /\ recovering
  /\ \E c \in Children, a \in Attempts :
       /\ intent[c][a] = "pending"
       /\ IF Last(branch) = c + 1 /\ prOpen /\ base = publishedBase THEN ConfirmIntent(c, a)
          ELSE IF Last(branch) = c THEN FailIntent(c, a)   \* never re-pushed automatically
          ELSE UncertainIntent(c, a)
  /\ UNCHANGED <<pub, recovering>>

RecoverDone ==
  /\ recovering /\ NoPending
  /\ recovering' = FALSE
  /\ UNCHANGED <<chainVars, childVars, envVars, pub, ghostVars>>

-----------------------------------------------------------------------------
(* Child Missions (contained-Mission runner; abstracted).                  *)

ChildStep(from, to) ==
  /\ \E c \in Children :
       /\ childSt[c] \in from
       /\ childSt' = [childSt EXCEPT ![c] = to]
  /\ UNCHANGED <<stopObl, chainVars, envVars, procVars, ghostVars>>

\* Executed and verified. The store proves the executor/verifier stopped before `verified`
\* (stop_obligation 1 only while executing/verifying), so a delivering child has none.
ChildDeliver ==
  /\ \E c \in Children :
       /\ childSt[c] = "running"
       /\ childSt' = [childSt EXCEPT ![c] = "delivering"]
       /\ stopObl' = [stopObl EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<chainVars, envVars, procVars, ghostVars>>
\* stopObl is the Mission's stop_obligation: set while the executor may still be running.
\* failed from running (stopObl TRUE) also stands for needs_reconciliation / stop_unknown: not released,
\* blocks every later dispatch, and becomes releasable only once the stop is proven.
ChildFail == ChildStep({"running", "delivering"}, "failed")
CancelRequest == ChildStep({"running", "delivering"}, "cancel_requested")
CancelDone == ChildStep({"cancel_requested"}, "cancelled")

\* The runner finishes a child whose push intent was confirmed.
ChildPublished ==
  /\ \E c \in Children :
       /\ childSt[c] = "delivering"
       /\ \E a \in Attempts : intent[c][a] = "confirmed"
       /\ childSt' = [childSt EXCEPT ![c] = "pr_opened"]
  /\ UNCHANGED <<stopObl, chainVars, envVars, procVars, ghostVars>>

ProveStop ==
  /\ \E c \in Children :
       /\ childSt[c] \in ChildTerminal /\ stopObl[c]
       /\ stopObl' = [stopObl EXCEPT ![c] = FALSE]
  /\ UNCHANGED <<childSt, chainVars, envVars, procVars, ghostVars>>

-----------------------------------------------------------------------------
(* Environment: reviewers, the outsider, base, PR state, time.             *)

\* Commits a review can matter for: the chain's published head (current for the chain) and the
\* PR's head (current for GitHub; stale for the chain while a push is unsettled or after an
\* outsider regression). Reviews on other commits are discarded by reduceReviewers and never
\* become relevant again, because published_head only moves forward (PublishedMonotone).
ReviewTargets == ({publishedHead, Last(branch)} \cap Range(branch)) \cap ChainCommits

\* COMMENTED leaves every reduced state unchanged (a stuttering step), so it is not listed.
Review ==
  /\ reviewCount < MaxReviews
  /\ \E r \in Reviewers, h \in ReviewTargets,
        s \in {"APPROVED", "CR", "CR_EMPTY", "DISMISSED"} :
       /\ rv' = [rv EXCEPT ![r][h] = IF s = "DISMISSED" THEN "none" ELSE s]
       /\ fresh' = [fresh EXCEPT ![r][h] = TRUE]
       /\ everApproved' = IF s = "APPROVED" THEN [everApproved EXCEPT ![r][h] = TRUE] ELSE everApproved
       /\ everDismissed' = IF s = "DISMISSED" THEN [everDismissed EXCEPT ![r][h] = TRUE] ELSE everDismissed
  /\ reviewCount' = reviewCount + 1
  /\ UNCHANGED <<chainVars, childVars, branch, base, prOpen, deadlinePassed, grantValid,
                 outsiderWrites, procVars, ghostVars>>

\* 24h review TTL: every review of r on h so far ages out (times are monotone).
ExpireReview ==
  /\ \E r \in Reviewers, h \in ReviewTargets \cup {publishedHead} :
       /\ fresh[r][h]
       /\ (rv[r][h] # "none" \/ everApproved[r][h] \/ everDismissed[r][h])
       /\ fresh' = [fresh EXCEPT ![r][h] = FALSE]
  /\ UNCHANGED <<chainVars, childVars, branch, base, prOpen, rv, everApproved, everDismissed,
                 reviewCount, deadlinePassed, grantValid, outsiderWrites, procVars, ghostVars>>

EnvStep(b, bs, p, d, g, w) ==
  /\ branch' = b /\ base' = bs /\ prOpen' = p /\ deadlinePassed' = d /\ grantValid' = g
  /\ outsiderWrites' = w
  /\ UNCHANGED <<chainVars, childVars, reviewVars, procVars, ghostVars>>

OutsiderPush ==
  /\ outsiderWrites < MaxOutsiderWrites /\ OutCommit \notin Range(branch)
  /\ EnvStep(Append(branch, OutCommit), base, prOpen, deadlinePassed, grantValid, outsiderWrites + 1)

\* Force push: back to a proper prefix (head regression), or a rewrite onto a prefix.
OutsiderForcePush ==
  /\ outsiderWrites < MaxOutsiderWrites
  /\ \E k \in 1..(Len(branch) - 1), rewrite \in BOOLEAN :
       LET p == SubSeq(branch, 1, k) IN
       /\ (rewrite => OutCommit \notin Range(p))
       /\ EnvStep(IF rewrite THEN Append(p, OutCommit) ELSE p, base, prOpen, deadlinePassed,
                  grantValid, outsiderWrites + 1)

BaseAdvance == base = 0 /\ EnvStep(branch, 1, prOpen, deadlinePassed, grantValid, outsiderWrites)
ClosePR == prOpen /\ EnvStep(branch, base, FALSE, deadlinePassed, grantValid, outsiderWrites)
DeadlinePass == ~deadlinePassed /\ EnvStep(branch, base, prOpen, TRUE, grantValid, outsiderWrites)
\* Grant expiry or revoked write scope (S8.7.1). The child is untouched; only the re-validation
\* before dispatch and before each push sees it. Explored only while the chain is in flight: in
\* any other state nothing re-validates the grant before the next dispatch, which re-checks it.
GrantExpire ==
  /\ grantValid /\ cState \in InFlight
  /\ EnvStep(branch, base, prOpen, deadlinePassed, FALSE, outsiderWrites)
\* A reopened PR must not revive a closed chain (the chain row is terminal). Explored for closed
\* chains, the case where a still-running publisher could otherwise push again.
ReopenPR ==
  /\ ~prOpen /\ cState = "closed"
  /\ EnvStep(branch, base, TRUE, deadlinePassed, grantValid, outsiderWrites)

\* Phase-5 driver: a failed re-validation stops the chain for a human.
GrantStop ==
  /\ ~grantValid /\ cState \notin {"closed", "awaiting_decision"}
  /\ cState' = "awaiting_decision" /\ stopReason' = "grant_invalid"
  /\ UNCHANGED <<mode, publishedHead, publishedBase, roundsUsed, grantRounds, res, intent,
                 currentChild, shadowWould, childVars, envVars, procVars, ghostVars>>

-----------------------------------------------------------------------------
(* Human decisions (phase 5; not implemented in the store yet).            *)

HumanResume ==   \* grant another round / continue
  /\ cState = "awaiting_decision"
  \* Without this, settleIntent('uncertain') on the then-unbound intent leaves the resumed chain
  \* running after an external write (TLC counterexample; mutants/resume-before-receipts.cfg).
  /\ ResumeAfterReceipts =>
       \A c \in Children, a \in Attempts : intent[c][a] \notin {"pending", "uncertain"}
  /\ \E g \in (IF mode = "live" THEN grantRounds..MaxRounds ELSE {0}) : grantRounds' = g
  /\ cState' = "awaiting_review" /\ stopReason' = "none"
  /\ deadlinePassed' = FALSE /\ grantValid' = TRUE /\ detected' = FALSE
  /\ UNCHANGED <<mode, publishedHead, publishedBase, roundsUsed, res, intent, currentChild,
                 shadowWould, childVars, branch, base, prOpen, reviewVars, outsiderWrites, procVars,
                 pushWhileDetected, clobbered, chainPushed, pushedWhileClosed,
                       actedWithoutGrant>>

HumanClose ==    \* abandon / take over manually
  /\ cState = "awaiting_decision"
  /\ cState' = "closed" /\ detected' = FALSE
  /\ UNCHANGED <<mode, stopReason, publishedHead, publishedBase, roundsUsed, grantRounds, res,
                 intent, currentChild, shadowWould, childVars, envVars, procVars,
                 pushWhileDetected, clobbered, chainPushed, pushedWhileClosed,
                       actedWithoutGrant>>

HumanResolveIntent ==   \* uncertain -> confirmed | failed, truthfully
  /\ \E c \in Children, a \in Attempts :
       /\ intent[c][a] = "uncertain"
       /\ IF c + 1 \in Range(branch) THEN ConfirmIntent(c, a) ELSE FailIntent(c, a)
  /\ UNCHANGED <<pub, recovering>>

-----------------------------------------------------------------------------
\* Every step except Reconcile clears justReconciled.
Other ==
  \/ Dispatch \/ VoidReservation \/ ClearCurrent
  \/ RecordIntent \/ PreCheck \/ DropStaleIntent \/ Push \/ ReadBack
  \/ Crash \/ RecoverIntent \/ RecoverDone
  \/ ChildDeliver \/ ChildFail \/ CancelRequest \/ CancelDone \/ ChildPublished \/ ProveStop
  \/ Review \/ ExpireReview \/ OutsiderPush \/ OutsiderForcePush
  \/ BaseAdvance \/ ClosePR \/ ReopenPR \/ DeadlinePass \/ GrantExpire \/ GrantStop
  \/ HumanResume \/ HumanClose \/ HumanResolveIntent

Next == Reconcile \/ (Other /\ justReconciled' = FALSE)

Spec == Init /\ [][Next]_vars

Symm == Permutations(Reviewers)

\* State constraint: a closed chain row is terminal (DDL trigger engineering_chain_terminal), but a
\* publisher or receipt may still be in flight. Closed states are expanded only while a push
\* intent is pending or the publisher is mid-step; afterwards nothing the chain owns can move.
Explore == cState # "closed" \/ pub.stage # "idle" \/ ~NoPending

\* Bounded search used only by mutants/store-many-pending-intents.cfg (its counterexample is deep):
\* prunes branches that end in a stop the trace does not need.
FocusPublish ==
  /\ Explore /\ ~deadlinePassed /\ grantValid /\ base = 0 /\ prOpen
  /\ \A c \in Children : childSt[c] \notin {"failed", "cancel_requested", "cancelled"}

-----------------------------------------------------------------------------
(* Invariants (design S10.2). Invariant 5 (spec inheritance) is phase 5.   *)

TypeOK ==
  /\ mode \in {"live", "shadow"}
  /\ cState \in States
  /\ publishedHead \in Commits /\ publishedBase \in {0, 1}
  /\ roundsUsed \in 0..(MaxRounds + 1) /\ grantRounds \in 0..MaxRounds
  /\ res \subseteq [head : Children, st : ResStates, child : BOOLEAN]
  /\ intent \in [Children -> [Attempts -> IntentStates]]
  /\ currentChild \in Children \cup {None}
  /\ shadowWould \subseteq Commits
  /\ childSt \in [Children -> ChildStates] /\ stopObl \in [Children -> BOOLEAN]
  /\ branch \in Seq(Commits) /\ Len(branch) >= 1 /\ branch[1] = Root
  /\ base \in {0, 1} /\ prOpen \in BOOLEAN
  /\ rv \in [Reviewers -> [Commits -> ReviewVals]]
  /\ pub.stage \in {"idle", "checked", "pushed"} /\ pub.c \in Children /\ pub.a \in Attempts
  /\ fresh \in [Reviewers -> [Commits -> BOOLEAN]]
  /\ everApproved \in [Reviewers -> [Commits -> BOOLEAN]]
  /\ everDismissed \in [Reviewers -> [Commits -> BOOLEAN]]
  /\ {deadlinePassed, grantValid, recovering, justReconciled, detected, pushWhileDetected,
      clobbered, chainPushed, pushedWhileClosed, actedWithoutGrant} \subseteq BOOLEAN
  /\ reviewCount \in 0..MaxReviews /\ outsiderWrites \in 0..MaxOutsiderWrites

\* 1. rounds_used <= grant.rounds <= 2
Inv1 == mode = "live" => (roundsUsed <= grantRounds /\ grantRounds <= 2)

\* 2. at most one reservation per (repository, PR, head)
Inv2 == \A h \in Commits : Cardinality({row \in res : row.head = h}) <= 1

\* 3. at most one in-flight child per chain (dispatched and not terminal with the stop proven)
Inv3 == Cardinality({c \in Children : childSt[c] # "none" /\ ~Released(c)}) <= 1
Inv3Active == Cardinality({row \in res : Active(row)}) <= 1

\* 4. after an external write is detected, no push until a human decision
Inv4 == ~pushWhileDetected

\* 6. after reconciliation every commit on the branch beyond the root has a confirmed push intent.
\* "Reconciled": the step just taken was a reconciler cycle, run after recovery with every push
\* receipt settled. A chain the reconciler stopped or closed is the human's (it may carry the
\* foreign commit it stopped on).
Reconciled == justReconciled /\ ~recovering /\ NoPending
Inv6 ==
  (Reconciled /\ cState \notin {"awaiting_decision", "closed"})
    => \A i \in 2..Len(branch) : branch[i] \in ConfirmedHeads
\* The chain only ever stands on commits it pushed and confirmed.
Inv6Published == publishedHead = Root \/ publishedHead \in ConfirmedHeads
\* Write-ahead: no chain commit is on the branch without a live (non-failed) intent.
WriteAheadIntent ==
  \A i \in 2..Len(branch) :
    branch[i] \in (ChainCommits \ {Root}) =>
      \E a \in Attempts : intent[branch[i] - 1][a] \in {"pending", "confirmed", "uncertain"}

\* The lease: a chain push never discards a commit someone else put on the branch.
LeaseSafety == ~clobbered

\* Nothing is pushed for a closed chain, and nothing is dispatched or pushed on an invalid grant.
NoPushAfterClose == ~pushedWhileClosed
GrantSafety == ~actedWithoutGrant

\* A shadow chain never reserves, dispatches, records an intent, spends a round or pushes.
ShadowNeverWrites ==
  mode = "shadow" =>
    /\ roundsUsed = 0 /\ res = {} /\ currentChild = None /\ cState \notin InFlight
    /\ \A c \in Children, a \in Attempts : intent[c][a] = "none"
    /\ ~chainPushed

\* published_head only moves forward, one confirmed revision at a time.
PublishedMonotone ==
  [][publishedHead' # publishedHead => publishedHead' = publishedHead + 1]_vars

-----------------------------------------------------------------------------
(* Coverage witnesses. Each is EXPECTED to be violated: checking one alone *)
(* (README, "Witnesses") proves the path it names is reachable, so the     *)
(* invariants above do not hold vacuously.                                 *)

W_Reserved == roundsUsed = 0
W_TwoRoundsReady == ~(roundsUsed = 2 /\ cState = "ready_for_human")
W_ThirdRequestStops == ~(roundsUsed = 2 /\ stopReason = "rounds_exhausted")
W_OneRoundExhausted == ~(grantRounds = 1 /\ stopReason = "rounds_exhausted")
W_LeaseFailed == stopReason # "lease_failed"
W_ExternalWrite == stopReason # "external_write"
W_HeadRegressed == stopReason # "head_regressed"
W_ReviewerConflict == stopReason # "reviewer_conflict"
W_IntentUncertain == stopReason # "intent_uncertain"
W_CrashAfterPush == ~(recovering /\ ~NoPending /\ Last(branch) # publishedHead)
W_RecoveredPush == ~(~recovering /\ publishedHead = 1 /\ \E a \in Attempts : intent[0][a] = "confirmed"
                     /\ \E b \in Attempts : intent[0][b] = "failed")
W_SecondRoundPublished == publishedHead # 2
W_ShadowWouldReserve == shadowWould = {}
W_ShadowStopped == ~(mode = "shadow" /\ stopReason = "attribution_unknown")

=============================================================================
