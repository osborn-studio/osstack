# Graph host-stall and macOS deployment follow-up

Status: fixes under validation; G29 remains in progress. These changes do not reconcile the existing production run or enable Graph admission.

## Reproduced failure

A real child process sends heartbeats every 20 ms while a host checkpoint callback blocks its event loop for 400 ms. With a 150 ms heartbeat threshold, the old host rejects the healthy worker with `WORKER_HEARTBEAT_EXPIRED` before processing heartbeats already in the IPC buffer. The regression fails before the fix and passes afterward.

The supervisor now schedules one `setImmediate` recheck after detecting a stale heartbeat. This gives the I/O poll phase an opportunity to receive queued messages. It rechecks current authority and expiry before making the final decision. Absolute graph deadlines, lease expiry, process stop verification, and heartbeat thresholds are unchanged. The existing real unresponsive-child termination test still passes.

On an isolated copy of the production frozen OSStack candidate, verification preparation completed in 16.8 seconds; the maximum observed host event-loop stall was 2.96 seconds. The original production preparation took about 70 seconds. This establishes a reproducible supervisor defect and a plausible production trigger, not a recovered log proving the exact cause of that historical exit.

## macOS deployment fixes

The CLI-generated LaunchAgent now declares `ProcessType=Interactive`, matching the existing daemon template and the verified serving configuration. The default launchd process class throttled worker imports to over 11 seconds, beyond the existing 10-second startup deadline; the Interactive diagnostic was about 1.25 seconds. The startup deadline is unchanged.

The contained-command fixture canonicalizes its temporary journal directory. macOS aliases under `/var` must resolve to `/private/var` before being passed to the existing canonical-root guard. This fixes the public Release fixture failure without weakening that guard.

## Verification

- Worker manager: 34 tests pass, including the new failing-before regression and unresponsive-child termination.
- Contained command: 31 tests pass using the normal macOS temporary directory.
- Service installer: 12 tests pass.
- Build completed. CLI typecheck passes after the temporary production diagnostic was moved out of the source tree; the diagnostic is not shipped.
- Default full-suite attempt stopped at a pre-existing adapter conformance test exceeding its 5-second deadline under concurrent load. A bounded-concurrency full-suite attempt also observed verification fixture timeouts under local load; final affected-suite and remote CI results remain required. No timeout was increased.

## Remaining release gate

Production remains on merged `d2483d1` with new Graph admission disabled. Trial `0b20f90b-1174-44ca-b237-15a0972ab3f5` is still `cancel_pending`: its fifth action failed before invocation and has no admission record. It consumed 1832 tokens in the earlier successful bounded writer. Worker exit and four released predecessor actions alone do not authorize a generic missing-admission bypass. The independent recovery review, required checks, independent approval, merge, deployment, and successful internal canary remain required before G29 is complete.

## Cancellation follow-up

Canonical admission now supplies a host-only positive cleanup callback when acquisition rejects without a lease or unresolved filesystem obligation. The broker uses it to atomically record a failed unstarted intent and a discharged admission; arbitrary rejection, duplicate admission, and uncertain lock cleanup supply no proof. Existing inventory rules remain unchanged.

A separate exact-v4 compatibility verifier recovers only the first epoch's five-action preparation pattern. It requires four confirmed/released predecessors, the exact failed/uninvoked tests-preparation outcome, journaled worker exit, a bound workspace receipt, canonical independent repository identity, and physical lock absence rechecked inside G15. It performs effect reconciliation and cancellation without unlinking locks, repeating actions, or changing existing action rows. Lost release acknowledgement retries verify the durable decision and refuse replacement locks.

A private snapshot of the actual production run passed this recovery: status became cancelled and all five action rows remained identical. The serving DB was never opened for mutation in that experiment. Production remains pending until the reviewed code is merged and deployed.

### Independent review and final focused checks

Claude Fable 5.1 independently reviewed the supervisor and recovery design, then the implementation. It approved subject to green recovery tests and explicit workspace binding. The follow-up pins both writer/freeze leases to `e0.writer`, documents the v4 host-only preparation mapping, requires `cancel_pending` on each proof pass, and tests lock appearance during commit, symlink substitution and lost project acknowledgement. All 15 public recovery tests pass. The host cleanup callback also refuses an already-active run when the duplicate request was cancelled before its first health check; its 8 tests pass. Core action/recovery tests: 81 pass. Whole-workspace build/typecheck and lint pass (seven existing lint warnings).

Local broad attempts are not counted as green: the serial run had seven failures (two source/build snapshots overlapped during development, two existing verification timeouts, one polling deadline, and two stopped-cancellation assertions). The finalized affected suites and exact-head remote CI must determine acceptance; per-test production thresholds are not relaxed to hide these failures. New process-heavy recovery fixtures use the same explicit 40-second setup/test bound as the other tests in their new file.

### Real provider validation after the fixes

A fresh isolated OSStack clone/home passed the real DeepSeek `deepseek-v4-pro` pilot at commit `531b1d460a946c156080d930b2fab325ef8a9da9`. Run `0d091cbf-8044-41c3-a121-c1c77a320b17` reached `ready` with all seven actions confirmed, no reserved tokens, and 2964 charged tokens (1832 writer + 1132 independent reviewer). Candidate `f85202e3c76403c934940a0bd349e1a66e5bb2c7` has artifact digest `19fe308d570d162188de7cab6b6580bae939e2ad98f6941da9901f0a51ac0c55`. Registered tests and independent review joined against that same candidate; the source repository stayed unchanged and request replay was stable. The negative reviewer rejected the original defect, and cancellation of a live inference preserved uncertainty instead of forcing release. All three pilot checks passed. This isolated validation does not itself resolve or upgrade the older serving run.

Fable 5.1 approved the final recovery delta. Its deployment review required a same-schema guard, online backup, normal control-plane authorization, and explicit blocked-recovery diagnostics. The follow-up installed maintenance entry addresses those controls and is under separate validation/review.

### Maintenance and test timing follow-up

The installed `graph-maintenance.js` entry passed its guard/schema/backup/cancellation integration test, including a reserved-home refusal, a future schema refusal, open admission refusal, stale revision refusal, missing cancel authority, required backup, unchanged actions and an independently readable intact backup. All 16 recovery/maintenance tests pass. Fable 5.1 approved the entry subject to these tests and typecheck; both passed. The release startup budget still applies to the new split entry.

Timing diagnostics isolated the local failures: one test combined six filesystem evidence writes and took 16.1 seconds against a 15-second bound; another combined two complete repositories. Their assertions are now separate parameterized cases, retaining the 15-second bound and all pass/fail/unknown, stop, command-registration and replay checks. The live-resume test completed its two real preparation pipelines at 14.5 and 30.9 seconds. Its per-phase observation window now matches the shared fixture's 20-second bound; its 45-second total bound and all production worker/lease/deadline limits remain unchanged. Diagnostic copies with expanded observation time were removed from source and are not shipped. Final revised timing cases and exact-head CI remain the acceptance evidence, not the diagnostic runs.
