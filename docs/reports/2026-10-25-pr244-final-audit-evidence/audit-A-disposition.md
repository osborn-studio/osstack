# Haiku A findings: evidence and disposition

Review against original PR code 30fe5eb0, with small comment clarifications and four added regression tests. No authority relaxation or production timeout changes.

## A1 conditional P1: after-invoke receipt failure / uncertain stop

Not reproducible as a retry vulnerability in the actual callers. The wrapper intentionally does not assert physical stop. `packages/loop/src/executor.ts` sets `cancellation.invocationStarted = true` BEFORE adapter.invoke. Its catch calls stopAfterError, which independently delegates confirmStopped and accepts only a stopped:true proof with nonempty evidence inside the deadline. No proof yields cancellation_unconfirmed and cancellation.stop_confirmed=false. `candidate-execution.ts:isImplementationUnconfirmed` maps that to execution_unconfirmed; its contract explicitly forbids retry. Existing candidate-execution test "retains an unconfirmed worktree and stops later tasks/cycles, including an explicit retry after restart" covers the LoopEngine retry boundary.

Graph is stricter: graph-action-broker.ts beforeEffect persists markRunning and sets invoked=true before invoking the underlying adapter. Its execute path throws when the candidate has unconfirmed stop/failure; executeRequest catch marks the effect unknown, retains the lease, and returns reconciliationRef. It does not use the not-started branch for a receipt failure after invoke.

Added real `executeCandidateImplementation` regression in execution-context.test.ts: fail the second receipt write, adapter confirmStopped:false, max_iterations:3; assert execution_unconfirmed, invocation_started:true, stop_confirmed:false, one physical invocation, one prepared reference, aborted signal. Passed. Existing test also confirms the wrapper's confirmStopped delegation remains false after iterator cleanup. Added explanatory cleanup comment. Renaming the error alone would not strengthen the already separate stop protocol.

## A2 P2: boundary wording

Accepted documentation ambiguity, clarified source-context-fence comment. Synchronous fence attests admission of the AgentTask prompt immediately before adapter.invoke/next. It does not attest a later provider-wire boundary or promise revocation of a prompt already handed to the adapter. Existing receipts already explicitly label `evidence_boundary: agent_task_prompt_not_provider_wire` and `token_window_qualification: unqualified`.

Added an asynchronous adapter regression proving precisely that boundary: fence before admission, adapter awaits and authority changes internally, receipt still labeled AgentTask boundary rather than provider-wire evidence. No claim of per-provider delayed revocation support; implementing that would require a separate adapter API contract. Existing source-context tests cover revocation during all host awaits, final registry/source/ledger revalidation before admission, and host policy separation.

## A3 P2: identical restored evidence remains unknown / repeated revisions

Fail-closed continuity is intentional, not content-digest trust alone. A missed observation may conceal intermediate changes; a later equal digest cannot prove continuity. The existing test explicitly requires quarantine not silently clear, and the host exposes exact private acknowledgement bound to source, generation, revision, manifest/content digests, record revision and expiry. Auto-clearing would weaken that contract.

The repeated-revision claim is factually incorrect: the first re-poll after unavailable records proposed evidence once, and all following identical re-polls return the same row. `snapshot_quarantined` describes trust state, not a content-change claim. Added regression: initial baseline, read_timeout, identical evidence → one proposed row; five more polls do not change row/revision/events; exact acknowledgement restores ready. Passed. Added comment documenting continuity semantics.

## A4 P2: wall-clock regression blocks writes

Safety tradeoff preserved: no backward wall-clock step may extend stale snapshot trust. The high-water mark is persistent; writes resume when wall time catches up. The claim "only recovery is editing the database" is false. Added regression: observe at100, time99 blocks without changing revision, time100 recovers normally without DB edits, expiry still fails at expires_at_ms. Passed. Added comment stating recovery. Larger host clock errors require correcting host time, not weakening expiry or editing DB. Read-only status/events remain available.

## A5 managed-home gates

Outside this agent's ownership; root/C audit must supply upgrade-native-backend.ts, managed-home-guard.ts and ControlPlaneGuardError handling before closing this context request.

## A6 daemon worker-log shutdown

Outside this agent's ownership; root owns daemon changes / audit disposition. Do not mark closed from this report alone.

## A7 wrapper refs lifetime

No process-global/daemon registry owns these refs. `deliver-command.ts` constructs one wrapper per deliver invocation, runs one bounded LoopEngine then gathers refs. `guarded-git-runtime.ts` constructs context inside one local verification execution. `graph-contract-host.ts` registration.create constructs one wrapper per Graph context creation; graph-execution-context.ts seals to one invocation and rejects replay. Once that execution and its evidence gathering finish, the owner and refs are collectable. Retaining both phase references until collection is required for evidence. Comment clarifies per-host execution lifetime. No unbounded daemon-global map exists here (refs is an array, not a Map).

## A8 path/reason context

`attention-loop-source.ts:readAttentionLoop` canonicalizes repo and file, rejects relative escape, opens no-follow regular files bounded to1MiB, rechecks realpath/dev/inode and loop_id. Path is confined to the explicit repository; current three tests passed.

`local-data-source-registry.ts:ReasonSchema` is a fixed enum: config_missing/config_invalid/not_registered/registration_expired/verification_in_future/registration_stale/invalid_clock/source_unavailable/source_escape/source_changed/source_too_large/content_pin_mismatch/invalid_snapshot/config_changed/read_timeout/cancelled/busy/invalid_request/response_too_large. All match /^[a-z_]{1,64}$/; no digits or hyphens. No vocabulary mismatch.

## Validation

- CLI focused: 4 files,44 tests passed (`audit-A-cli-tests.log`), including all14 source-context tests,26 execution-context tests,3 attention-loop source tests,1 host-context test.
- Core ledger: 1 file,7 tests passed (`audit-A-core-tests.log`).
- No red-green bug claim: added tests validate and clarify already implemented safety behavior; all passed immediately.

## Supplemental files to feed reviewer

packages/loop/src/executor.ts; packages/loop/src/candidate-execution.ts; relevant candidate-execution.test.ts unconfirmed worktree regression; packages/cli/src/graph-action-broker.ts; packages/cli/src/graph-execution-context.ts; packages/cli/src/execution-context-host.ts; packages/cli/src/graph-contract-host.ts; deliver-command.ts wrapper creation/run section; guarded-git-runtime.ts wrapper creation section; packages/cli/src/attention-loop-source.ts; packages/cli/src/local-data-source-registry.ts; changed tests and comments.

### Locator map for follow-up review (line numbers may shift with parallel edits)

- A1: executor.ts `invocationStarted = true` line216; catch stopAfterError line268; cancellation_unconfirmed line285; confirmStopped proof line356. candidate-execution.ts status line83 and predicate99. candidate-execution.test.ts retained-worktree/no-retry test231. Graph broker beforeEffect/markRunning around370, unknown catch around436, candidate uncertainty rejection around620. execution-context.test.ts new test title `keeps observed-receipt failure execution-unconfirmed through the real candidate executor without retry`.
- A2: source-context-fence.ts `assertSourceContextDispatch` header; execution-context.ts receipt evidence_boundary and sync fence immediately before invoke; new test `attests adapter admission rather than claiming a later provider-wire authorization fence`.
- A3/A4: source-observations.ts `write`, `observe`, `unavailable`, `acknowledge`; source-observations.test.ts last two tests. source-observation-host.ts private GrantSchema / acknowledge method supplies full host authorization context.
- A5: supply upgrade-native-backend.ts + managed-home-guard.ts + control-plane-guard.ts, and the root agent's final bin/daemon handling tests.
- A6: supply daemon.ts final shutdown workerLogReads drain + worker-log-view.ts transaction/final authority recheck + root's local-ledgers-daemon integration test.
- A7: deliver-command.ts534–543; guarded-git-runtime.ts549–558; graph-contract-host.ts248–289; graph-execution-context.ts54 and66 enforce one invocation/replay refusal. Full files preferable where affordable.
- A8: attention-loop-source.ts23 path escape,28 no-follow,35 identity recheck,46 loop identity; local-data-source-registry.ts28 ReasonSchema full enum; source-observation-host.ts observe uses the parsed inspector reason.

## Second-round changes supersede earlier A3/A4 disposition

Haiku's first re-review correctly identified a forward-clock excursion then correction as a persistent high-water failure, and asked to suppress the first identical quarantine repoll. Both now fixed:

- observe compares accepted when proposed is null; identical restored bytes leave the unknown row unchanged, preserving quarantine without a spurious event.
- Clock correction is allowed only through existing exact private acknowledgement. Optional `clock_reset` in the host grant contains `expected_high_water_ms`, `not_before_ms`, `expires_at_ms` with a maximum60s interval. The core CAS checks the exact old high-water, requires actual backward correction and current time within that interval, plus existing exact source scope/evidence/digest/record revision checks. One transaction resets clock, appends clock_reset for every stream and quarantines all streams, then acknowledges only the separately approved current source. No other old trust is revived. Old acknowledgement revisions fail; a fault in any stream update rolls back clock and all events.
- `sources events` now exposes clock.high_water_ms and current_time_ms so an operator can construct the exact private grant without DB editing. Host grant remains private and not supplied as RPC data. Example grant addition: `clock_reset:{expected_high_water_ms:1790000000000,not_before_ms:1780000000000,expires_at_ms:1780000030000}` with real exact values from events and operator correction time; reuse existing `sources acknowledge SOURCE --repo ... --default-tenant --grant ID`.
- Final synchronous source-context fence checks persisted high-water both before source iteration and immediately before return. A high-water change during asynchronous validation now blocks dispatch.
- Tests: forward excursion+correction, exact grant expiry, unauthorized ordinary ack blocked, replay/stale revisions, other-stream quarantine, mid-transaction trigger failure rollback, real host private grant route, high-water final-fence race.
- Sticky unknown also includes freshness lapse/config loss/read timeout/busy; fresh identical content never automatically proves missed continuity.

A5 root agent has supplied compiled identity checks for direct DB/serve and deterministic guard exit78; include final bin and daemon snippets plus local-ledgers-daemon tests. A8 include supervision-service full binding handler in re-review.

## Third-round changes and exact scope

- Removed inspector's cross-request lastNow latch. Single inspection still rejects finalNow<sampled; persistent ledger plus final dispatch fence owns cross-request continuity. New same-service-instance test observes a year-forward expiry, corrects time, blocks ordinary observe, applies exact reset grant, resumes observe without service restart.
- A clock_reset audit now records old_high_water_ms/new_time_ms/grant_digest/not_before_ms/expires_at_ms/prior_reason on each existing stream event. Its JSON storage is migration46's existing events table. Pruning exempts clock_reset transitions permanently; no new runtime DDL or migration bypass. RPC event schema explicitly validates the metadata; pagination reports holes between retained permanent audit rows and the recent500 revisions. Test advances505 subsequent revisions and verifies permanent audit+gap. The grant digest hashes the complete private grant, including ID; no private grant ID/body is emitted.
- Empty-stream unavailable does not advance high-water (there is no accepted trust to downgrade and no row to acknowledge). Added empty-ledger forward excursion test.
- A real P→A return is a change worth recording, not suppressed: transition snapshot_returned_to_accepted clears proposed to null, retains quarantine, and subsequent identical polls are no-ops. Test confirms exact revision/event behavior.
- Busy/cancelled represent denied observation admission, not source continuity evidence; observe throws before ledger write for these reasons. Two concurrently stalled real inspections and a third busy call preserve exact ledger row/events. Actual timeout/stale/source errors retain conservative quarantine.
- Qualification8 is accepted: a trusted same-UID local socket operator can register an explicit existing default-tenant task + canonical repository directory; registration is not proof that Git/task contents authorize execution. attention.loop uses stored scope repo and rejects filesystem escape. It exposes snapshots only, never execute/recovery authority. Full registerScope and daemon routing supplied.
- Removed complete Loop Task leakage at the snapshot source: pending/in_progress now contain only task_id/capability, excluding prompt/context/evaluation before persistence/inventory; a source test contains PRIVATE prompt/context markers and proves neither escapes. Recovery view selects only identity/status columns, not payload bodies. Inventory's source facts now already contain metadata only.
- Direct-DB refusal is deterministic exit1 with concise stderr at cli-entry top-level, while serve guard refusal returns EX_CONFIG78. No requirement that every command use78; root supplies real child-process no-stack/no-DB test. Earlier conditional request for all direct commands78 is superseded by established entrypoint contract.

Validation final source: source-context18, attention-loop-source4, source-registry16, plus native/command/local-ledgers: combined87/87; core clock ledger12/12; strict CLI typecheck pass. Raw outputs supplied as host-run evidence, not reviewer execution.

## Fourth-round scope closure

The r3 reviewer explicitly allows two remaining limitations to be QUALIFICATION, and the product chooses those existing safety boundaries rather than inventing broader reset authority:

1. Clock reset acknowledges one existing stream using a freshly inspected, registered, readable snapshot. If all registrations are revoked/stale/unreadable, the operator must restore/re-verify one previously tracked registration before issuing the private reset grant. There is no unconditional global clock-reset command. This precondition is now stated in CLI help; recovery without DB editing does NOT mean recovery without fresh source evidence.
2. Source-context dispatch and acknowledgement private policy paths require an OSSTACK_HOME path with no symlink components; use the resolved path (for example /Volumes/AIMATE_WORK rather than ~/Developer). Observe/status/events do not enforce this canonical-path rule. The new source-context test verifies source_policy_unavailable and no ledger mutation for dispatch.

Bounded loop metadata is now enforced at source: at most16 pending and16 in-progress records; task_id128, capability64, loop_id256, path4096, updated_at64 characters; full JSON facts at most8192 bytes. Wait is not arbitrary text: LoopWaitReason is a strict fixed object with code discovery_deferred plus three nonnegative integer counters; supplied LoopState source proves this. Invalid oversized state yields an explicit unknown read failure, never a larger persisted snapshot.

Inventory additionally caps serialized JSON at262144 bytes. It shortens the emitted subject page until within budget and sets next_after to the final emitted subject, preserving continuation without duplicates. A single oversized legacy/corrupt subject fails with attention_inventory_too_large rather than returning an unbounded response. The regression fills13 subjects with30KB facts and proves byte bound plus disjoint resumable pages. This is a response bound, not a new retention policy.

withWrite source is now supplied: better-sqlite3 transaction wraps the entire callback. SQLite begins a deferred write transaction; its first clock SELECT then UPDATE retains one snapshot and acquires the write lock. Concurrent conflicting writer either serializes or receives SQLITE_BUSY; it cannot partially commit. Fault trigger regression proves rollback of all stream events and clock in the tested connection. No filesystem I/O/await occurs inside reset transaction.

Per-inspector concurrent-read limit is intentionally per service instance. The daemon has one service instance; separate host CLI/execution-context instances have separate bounded counters, not a cross-process global quota. No cross-process quota claim is made.

Validation for this delta: core35 tests passed (source12+observer23), source/loop/native focused run and typecheck recorded separately. No real-environment qualification has been promoted by these changes.

## Round 4 disposition
The only blocking item was documentation accuracy for canonical homes. CLI help and the qualification above now explicitly scope the rule to source-context dispatch and acknowledgement; observe/status/events are not claimed to enforce it. Loop facts 8192 bytes is the binding combined budget; individual maxima need not all fit together. Inventory 262144 is the pre-transport JSON budget; escaping can expand wire bytes but remains bounded. Reviewer executed no tests. Boundary/negative tests recommended by reviewer are nonblocking.

Final scoped Haiku result: PASS in reaudit-A-upgrade-final-A-result.json, corroborating r4 resolved production changes. Latest wrapper/source focused22/22 and CLI typecheck exit0. Test-only narrowing fix after A-r4 prompt does not alter production code. Final freeze hashes saved separately.
