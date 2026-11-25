# Bridge 5-F: does the TLA model have to cover the local-failure route and V2 grant renewal?

Status: proposed, 2026-11-25. Three owner decisions are open in §5. No model change has been made yet.

Context: the phase 5 threshold (`2026-11-06-bridge-same-pr-revision.md` §5.6, last paragraph) requires that "the live TLA model has no TLC counterexample". The model is `docs/design/specs/bridge.tla`, last revised on 2026-11-07. Main has since added two things the model does not describe: the U4b local-failure route and version 2 grant renewal. The 2026-11-25 audit (`docs/plans/2026-11-25-sandbox-drill-checklist.md` §0) asked whether the model must be extended before 5-F is cited to open `OSSTACK_BRIDGE=1`. This note answers that question and proposes a scope. File references are to main `091b9cd5`.

## 1. What the model covers today

`bridge.tla` models one revision chain on one PR. It has exactly one way to write to the PR branch: a review revision child takes a per-head reservation (`Inv2`), becomes `current_mission_id`, records a push intent, pushes with a lease, and confirms the intent. The invariants (README table) are stated over that path: `Inv1` rounds, `Inv2` reservations, `Inv3` one live child, `Inv6` and `Inv6Published` for the remote branch and confirmed intent ranges, `WriteAheadIntent`, `LeaseSafety`, `NoPushAfterClose`, `GrantSafety` and `ResumeSafety`.

## 2. How the local-failure route differs

The local-failure route is a second writer to the same branch, and it bypasses all three of those structures:

- **No reservation and no `current_mission_id`.** A local-failure child takes no reservation and is never the chain's current child. Mutual exclusion with review children is enforced outside the chain row: by `checkRootAdmission` (`engineering-root-admission.ts:76`), by `reserveInner` returning `chain_busy` (`engineering-revision-chain-store.ts:733`), and by two SQL triggers (`engineering-local-failure-dispatch-ddl.ts:57-59`, `:66-73`).
- **A separate intent ledger.** The push intent is a `verify_repair_push_intent` event on the child (`contained-mission-local-failure-publish.ts:200-201`), not a row in the chain's intent table. On confirmation, `confirmLocalRepairPush` advances `published_head` directly (`engineering-revision-chain-store.ts:664-690`).
- **A separate invariant-6 path.** The live ledger check accepts exactly one repair commit by splicing it into the chain of confirmed ranges (`contained-mission-bridge-ledger.ts:114-150`). A released but unconfirmed repair gives `reconciliation_incomplete` (`:106-108`).
- **Rounds.** A repair uses one round through `allocateChild` (`engineering-revision-chain-store.ts:602`). The cap is checked only in the dispatch store (`engineering-local-failure-dispatch-store.ts:192`), not in `allocateChild` itself.
- **Cancellation.** Cancel-on-stop and close (`syncLiveChild`, `cancelChild`) look only at `current_mission_id` (`contained-mission-bridge-live.ts:34-36`, `contained-mission-bridge-assembly.ts:106-110`). A local child is therefore not cancelled by those paths; it relies on its own publication fence.

**What this leaves unchecked.** If any of these hand-written guards were wrong, the model would not notice. It cannot represent a second concurrent writer (`Inv3`, `LeaseSafety`), a `published_head` that no confirmed intent explains (`Inv6Published`, `Inv6`), a round spent outside `allocateChild`'s caller checks (`Inv1`), or a repair push after close or stop (`NoPushAfterClose`). The TypeScript tests cover each guard one by one. No exhaustive interleaving check covers the two writers together.

## 3. How V2 grant renewal differs

`replaceGrant` (`engineering-revision-chain-store.ts:369-450`):

- Renews from `awaiting_review`, `ready_for_human` and halted states.
- Refuses with `grant_renewal_busy` while an intake is open, a recheck is running, or a local child is past "waiting" (`engineering-local-failure-renewal-facts.ts:7-13`).
- Refuses `intent_unsettled` only for chain-table intents (`:381`). A `verify_repair_push_intent` is excluded only indirectly, through the busy rule.
- Fixes the profile pin once an intake exists, and refuses a downgrade from V2 to V1.

The model's `HumanResume` (`bridge.tla:639-655`) still matches V1 renewal in outline, with three known differences:

- The code also renews from `awaiting_review` and `ready_for_human`.
- The code refuses when a terminal child's stop is unproven.
- The code rewrites `stop_reason` to `child_halted`.

Nothing about V2, intakes or the local child is modelled. The safety question that renewal raises, "can a renewal swap the pin or reset the deadline while a repair is approved or pushing?", rests entirely on the busy predicate.

## 4. Open finding 10 (5-F, specs README)

Close paths in the model keep `stopReason` and may leave reservations active. The store does the opposite: on close it clears the reason and voids every active reservation. In the code, a closed chain is terminal: the live scan never resumes it (D7). So the model's extra active reservations can only block behaviour the code would also never reach. That makes this abstraction conservative for the safety invariants, but it is undocumented and the README still lists it as open.

## 5. Recommendation and owner decisions

**Recommendation: extend the model, at bounded scope, before citing 5-F to open the gate.** The threshold requires the live TLA model to have no counterexample. With an unmodelled second writer on the same branch, that statement would hold only for the review route. The route the drill exercises (a `verify-*` failure repaired once and pushed to the same PR) is exactly the local-failure route.

The proposed extension is one node: Codex writes the model, and TLC runs locally under the heavy lock. Java 26.0.1 and `tla2tools.jar` v1.7.4 are present, and the jar's SHA256 matches the README. The node would:

1. Add local-repair actions with crash points: `LocalDispatch` (requires `awaiting_review`, no active reservation, no current child, `roundsUsed < rounds`, at most once per root), `LocalApprove`, `LocalRecordIntent`, `LocalPush` (lease on `published_head`), `LocalConfirm` (advances `published_head`) and `LocalHalt`.
2. Strengthen the invariants:
   - `Inv3` becomes "at most one writer child among the current child and the local child".
   - `Inv6`/`Inv6Published` accept the single repair splice.
   - `Inv1` counts the repair round.
   - `NoPushAfterClose` and `LeaseSafety` cover the repair push.
3. Replace `HumanResume` with a `RenewGrant` action:
   - It matches the code's source states, the `child_halted` rewrite and the unproven-stop refusal.
   - It carries a V2 flag, a pin and a busy guard.
   - New invariant `RenewalSafety`: no renewal changes the pin after an intake, or the deadline, while a local repair is approved or has an unsettled intent.
4. Close finding 10 by making close void reservations and clear the reason, as the store does.
5. Add model mutants for the new guards: drop the dispatch exclusion, drop the round cap on dispatch, drop the busy guard, and confirm without a lease.
6. Run the bounded configuration first, then the main configuration, recording the evidence as in `model-checks.json`.

| # | Decision | Options | Recommended |
|---|---|---|---|
| M1 | TLA scope for the gate | (a) extend the model as above before opening the gate; (b) change the threshold wording so the TLA evidence covers the review route only, and the local-failure route rests on the TypeScript fault-injection and mutant evidence | (a) |
| M2 | Finding 10 | (a) model the store's close exactly (part of the M1 node); (b) keep the abstraction and record the conservativeness argument in §4 as accepted | (a) if M1 = (a), otherwise (b) |
| M3 | F9 wording (found in 5-F node 2) | §5.6 expects a 403 on push to settle the intent as `failed`. The code keeps a released push that failed with an authorization error `uncertain` unless it has structured proof that the push was rejected before any update (`explicitlyRejectedPush`, `contained-mission-revision-publication.ts:516-525`); a token revoked before release does give `failed`. (a) amend §5.6 to match the code; (b) change the code | (a): the code's rule is the safer one, since stderr alone does not prove nothing was written |

The gate stays closed whichever way these go. Choosing (b) for M1 changes the acceptance criteria, which the threshold paragraph says requires the owner's explicit change to the design.
