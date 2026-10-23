**Verdict: PASS for the scoped C6 implementation.** The prior blocker and the retry-intent orphan are fixed as described, and I found no false-pass or verified-evidence-loss flaw in the join, route, or publication path. Two concrete P2 defects remain in the G19 persist path, plus test gaps. This is a source-only read. I ran nothing.

## Prior findings, rechecked

- **P1 join throw on ledger failures is fixed.** Non-verification refs now fall back to a nonretryable stop error and never throw. Verification refs without a classification fall back to nonretryable INTERNAL_ERROR. The mismatch throw survives only when a classification exists and disagrees with the ledger. Route then yields stop with branch_failure. The unguarded prefix slice is also moot, since the loader regex-validates the ref first.
- **Retry intent orphan is fixed.** The allocated retry action is owned before check and reserve run. Any pre-invocation throw settles it failed under the still-live fence. A retired connection is covered because the binding comes from the retry argument. An expired or replaced fence leaves the intent row for G15, which matches your adjudication.
- **Publication no longer depends on route.** Commit is gated on complete join, no unresolved actions, no pending admissions, and running status. A join stopped at accounting or deadline budgets still publishes. Confirmed.
- **Lease renewal conflict** is accepted as intentional per your adjudication. I am not re-litigating it.

## Remaining P2 defects

**P2-A. Evidence size cap turns a completed, stopped invocation into a stuck unknown.**
File `packages/cli/src/graph-verification-store.ts`, publish path, and `persist` in `packages/cli/src/graph-verification.ts`.

The envelope embeds the full command stdout and stderr and the full candidate execution result. Canonical bytes are capped at 64 KiB after the physical effect. Command output is bounded at 16,000 units per stream, but JSON encoding inflates control characters to six bytes. ANSI color escapes in test output are routine, and CJK or emoji output is four bytes per character. Both streams at the limit can exceed the cap several times over. A verbose reviewer report has the same exposure.

When that happens, persist throws after invocation. The broker marks the attempt unknown, retains the lease, and writes no evidence. The retry path requires a failed attempt, so the only way out is G15 reconciliation, and the completed verification is lost. Not a false pass, but a deterministic loss of a legitimate result on common inputs.

Fix in persist, before publishing: measure the JSON byte length of each output stream, and replace over-budget streams with a truncated prefix plus the sha256 and byte length of the full stream. Keep exit code and termination intact so tests results remain computable. Do the same for the candidate summary on review, keeping the parsed report. Add a test that a tests run emitting escape-heavy output at the limit still reaches confirmed.

**P2-B. Review retry may be blocked by the per-run-id receipt guard, conditional on G04 run id derivation.**
File `packages/cli/src/graph-verification.ts`, the reviewer invoke wrapper.

Retries reuse the same registered action, so the same plan, task id, and receipts map. The wrapper rejects any run id it has seen before, and the comment states G04 derives session ids from the plan on retry. If the run id is also plan-derived, attempt two throws after the broker has already marked it running, and the attempt becomes unknown before any provider call. I cannot confirm how the loop package allocates run ids from these snapshots.

Fix that removes the dependency: key receipts by the current effect key instead of run id. Reject only a second invocation for the same effect key. In persist, look up by the ledger effect key and assert the receipt run id equals the execution run id. Add a test that retryAuthorized on a review slot produces a second, distinct receipt and reaches a settled outcome.

## Low severity

- **Attempt accounting ignores effect slot.** In the join service, the latest selector filters by node and slot, but the spent counter filters by node only. With one slot per node today this is harmless. If a node ever gains a second slot, spent overcounts and route stops early with branch_budget. Align the filters.
- **Release failure masks the preparation error.** In prepare, a failed lease release throws its own error and drops the original restore or verification failure. Attach the original as cause.
- **Repository stamp rejects hardlinked objects.** Every file under the git directory must have a single link. A local git clone hardlinks objects by default. This is correct for the independence goal, but it means restore must never clone with hardlinks. Worth a test assertion on the actual restore output.
- Previously noted items stand: the triplicated epoch cap, the synthetic candidate parse in core commit, the dead cancelled branch route, and the silent slot misconfiguration stop.

## Test gaps, scoped

- Pre-invocation admission refusal for one slot: evaluate returns stop with branch_failure and does not throw.
- Ledger failed with a verification ref but no envelope classification: fallback nonretryable, no throw.
- Ledger classification tampered to disagree with envelope: JOIN_FAILURE_MISMATCH.
- Retry allocated, then admission denied: attempt N+1 recorded failed with retry safe, and a second retryAuthorized succeeds.
- Retry under an expired lease: the intent row is left unmodified.
- Tests with a registered failing exit code: confirmed with passed false, route repair_required. This also proves the loop package leaves failure code unset on nonzero exit.
- Full-valid join with accounting blocked: publication created, route stops.
- Second evaluate after publication: same receipt, created false.
- The two P2 scenarios above.

## Integration concerns, not defects here

- G15 must be able to settle an intent-state row from a prior generation, since the retry path deliberately leaves one behind on fence expiry.
- Evaluate must finish within one host heartbeat period, per your documented G21 and G28 constraint.
- Host registration of restore and workspace lifecycle starts, epoch advance, and automatic retry scheduling remain G21 work.

Same-UID isolation and trusted host storage are unchanged from the prior review and remain documented limitations.