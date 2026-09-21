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
