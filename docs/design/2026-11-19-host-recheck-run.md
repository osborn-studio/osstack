# U4b B7d: host recheck run on the new head

Date: 2026-11-19. Status: approved by the owner on 2026-11-19; all nine decisions in §8 were accepted as recommended. No code, test or migration is part of this change.

Baseline: branch `feat/local-failure-recheck-ledger` at `0b5bd10b` (B7b, PR #478, on main `556d7ccb`). Every `file:line` below refers to that commit unless it is marked **[B7c]**, which means branch `feat/local-failure-merge-interlock` at `46737965` (local only, not merged).

Parent contract: [verify-failure intake](2026-11-16-verify-failure-intake.md), called "the intake design" below. This document does not change it. Where the intake design already answers a point, it is quoted.

## 0. The gap

The recheck ledger passes a row only when three inputs are present together (`packages/core/src/bridge/recheck.ts:88`):

- (a) a new accepted verification result on the new head with the same skill, profile and check set (`recheck.ts:91-123`);
- (b) a complete, successful latest Actions attempt on the new head (`recheck.ts:125-135`);
- (c) a host recheck proof whose outcome is `passed` and whose head, base, profile digest and trusted source digest equal the pinned values (`recheck.ts:136-144`).

The proof is a branded in-memory object. Its only issuer is `issueHostRecheckProof` (`packages/core/src/bridge/recheck-host-proof.ts:22`). The module is blocked from the package exports (`packages/core/package.json:70-71`), a static test keeps every other source file from naming it (`packages/core/src/bridge/recheck.test.ts:98-117`), and it has no production caller. Nothing runs the profile on the new head either. `recheck_passed` is therefore unreachable outside tests.

B7d adds the missing producer: one host run of the pinned verification profile on the new head, a durable record of it, and the only production path that issues the proof.

Three further facts shape the design.

1. **The diagnosis journal cannot carry this run.** A new intake row requires `rounds_used < rounds` on the chain (`packages/core/src/state/engineering-local-failure-intake-ddl.ts:80`, and again at start, `:127`). The local dispatch already increased `rounds_used` (`packages/core/src/state/engineering-revision-chain-store.ts:580`), so with a one-round grant the trigger refuses. The diagnosis grant check also requires the request head to equal the head written in the grant (`packages/core/src/bridge/diagnosis-admission.ts:80-81`), which is the old head. Host receipts are tied one-to-one to a diagnosis request (`packages/core/src/state/engineering-diagnosis-ddl.ts:122-123`).
2. **The proof does not survive a restart.** It lives in a `WeakSet` (`recheck-host-proof.ts:19`). The ledger stores only the receipt id and digest (`packages/core/src/state/engineering-local-failure-recheck-store.ts:225-226`), and `evaluate` recomputes the row from the inputs of each call (`:205-227`), so an input that is not presented again is cleared. The proof must be re-issuable from durable data.
3. **A failed host run cannot seal the ledger row.** A proof whose outcome is not `passed` is only "missing" (`recheck.ts:136-144`). The table allows `awaiting_decision` only with one of two reasons and a recorded result id (`packages/core/src/state/engineering-local-failure-recheck-ddl.ts:98`). The failure state of the host run needs its own durable home.

## 1. Trigger and binding

### 1.1 What the intake design already fixes

Step 9 of the intake design (§4, table row 9) says the new head must get a complete new result for the original skill, profile and checks, that Actions must be green, and for route B: "B 同时要 host profile 成功及 Watcher 原云环境复验成功". The failure stops are `reverify_pending / verify_recheck_missing`, `awaiting_decision / verify_recheck_failed` with "零第二次自动修复", and `verify_recheck_binding_changed`. §4.1 says the merge hold stays until there is a trusted passed result for the current head and base "及相应主机复验". These are not redesigned here.

The intake design does not say who starts the host recheck or under which authority. That is the new part.

### 1.2 Precondition

A recheck run may be reserved only when all of these hold, checked in one immediate transaction:

- A ledger row exists for the dispatch and is `reverify_pending`. The ledger row itself already requires the dispatch, the chain event `local_repair_push_confirmed` for that dispatch and child, and the chain at that head (`engineering-local-failure-recheck-store.ts:76-87`).
- The chain's `published_head` equals the row's `new_head_sha` and the chain's `published_base` equals the row's `base_sha`.
- The original result is still registered and not withdrawn (same check as `DiagnosisStore.admit`, `packages/core/src/state/engineering-diagnosis-store.ts:331-332`).
- The authority of §1.4 verifies now.
- Shared root admission and budget admit the run (§2.3).

### 1.3 Binding

The run row copies, and never accepts from a caller, these values from the ledger row: `recheck_id`, `dispatch_id`, `root_mission_id`, `child_mission_id`, `chain_id`, `repository`, `repository_id`, `pr_number`, `new_head_sha`, `base_sha`, `skill_id`, `skill_version`, `skill_blob`, `skill_manifest_digest`, `profile_id`, `profile_digest`, `trusted_source_digest`, `original_result_id`, `original_source_seq`, `failed_check_id` and the original check set. The ledger pinned them from the digest-checked original contract (`engineering-local-failure-recheck-store.ts:104-148`). The run adds the chain revision, the tree of the new head, the grant id and digest, one `invocation_id`, a journal reference and the container cap.

**One launched run per ledger row.** The ledger has one row per dispatch (`engineering-local-failure-recheck-ddl.ts:44`), and the first release allows one repair per root chain, so this is one launched recheck run per root chain. A run that provably never crossed the launch fence does not count as launched (§5.2).

### 1.4 Who may trigger it, and under which authority

Only the host process that owns the control-plane database may start a run. The run has no decision kind, no webhook or bot entry and no remote answer path; its only entries are the host's own tick and one local-socket method with operator scope that `decisions.answer` refuses (§3.4, amended 2026-11-23).

Two readings of the authority are possible.

- **Reading 1: the existing signed V2 grant is enough.** The grant already opts in the profile, its digest, its trusted source and a per-run time limit (`packages/core/src/bridge/revision-local-failure-grant.ts:19-30`). The new head was published by this host under that grant after operator approval. Against it: the grant's wording is one diagnostic per head (`:29`), the diagnosis check ties the run to the grant's own head (`diagnosis-admission.ts:80-81`), and the file header says a new capability needs a newly signed preview (`revision-local-failure-grant.ts:9-11`).
- **Reading 2 (recommended): an explicit recheck opt-in inside the signed grant.** Add an optional object `local_failure.recheck = { enabled: true, timeout_seconds }` to the V2 grant. When it is absent the host does not run a recheck and the row stops at `awaiting_decision / verify_grant_missing`. When it is present, a new pure check `verifyRecheckGrant` verifies the signature, principal, scope, validity window and wall-clock window exactly as `verifyDiagnosisGrant` does (`diagnosis-admission.ts:68-72`), verifies the profile pin (`:83-89`), and replaces the head rule with: root mission, repository, PR, branch, base ref and base sha equal the grant, and the run head equals both the chain's `published_head` and the ledger's `new_head_sha`.

Reading 2 keeps the rule that the owner signs each capability once, costs the owner no extra step per PR, and makes the recheck time limit an explicit signed number. Its cost is one small contract PR (node D1).

With either reading the trigger is the same: **the host starts the run automatically, once, when it opens the ledger row after the confirmed push.** Every later attempt for the same row is an explicit operator command on the host (§5.2). The automatic start sits behind a protected host configuration switch that defaults to off, in line with the intake design's rule that a missing decision means closed.

## 2. Where it runs, isolation and budget

### 2.1 Runtime: reuse B3 unchanged

The run uses the same library path as the diagnosis run (`packages/cli/src/contained-mission-diagnosis.ts:75-316`):

- The installed profile is loaded from the host by the pinned binding (`packages/cli/src/contained-mission-verification-profile.ts:140`) and revalidated before use (`:67`). The payload of an external result never supplies a command.
- The candidate is read from the immutable commit `new_head_sha`, tree and file bytes from the same Git object (port contract at `contained-mission-diagnosis.ts:35-36`).
- `prepareContainedProfileImage` builds the image from the candidate and the trusted profile files and checks provenance (`packages/cli/src/contained-mission-profile-execution.ts:33-66`). It accepts only 128 MiB memory, 1 CPU, 64 pids and at most 120 seconds (`:42`).
- `runPreparedContainedProfile` refuses a plan with runtime blockers and refuses to run the same plan twice (`:79-85`). Output above 1 MiB per stream is a blocker (`:61`).
- The container has no network, a read-only root, all capabilities dropped, no new privileges, user 65534 and a 16 MiB `/tmp` (`packages/agents/src/contained-command.ts:100-107`). Before the start it checks the trusted namespace and the working directory (`:237-247`) and enforces the output caps while streaming (`:226-230`, `:249-255`).
- A stopped run carries a `docker_removed` stop receipt (`contained-command.ts:190`). The recheck applies the same identity and stop-receipt checks as the diagnosis (`contained-mission-diagnosis.ts:235-252`).

No new isolation mechanism is added. No limit is raised. The run needs a reachable Docker daemon on the host; osstack does not start Docker.

### 2.2 Journal: a new table, same four states

Because of fact 1 in §0, the run gets its own journal table `engineering_local_failure_recheck_runs` (migration 63) with the intake journal's lifecycle: `reserved → running → stopped`, with `stop_unknown` between when the stop is not proven. The transitions, the owner fence, immutability of bound columns and the "no delete, no replace" triggers copy the intake table (`engineering-local-failure-intake-ddl.ts:103-132`). The alternative, relaxing the intake triggers so that a row can exist after the round is used, would weaken the diagnosis rules for every caller and is not recommended.

### 2.3 Budget

| Item | Value | Source |
|---|---|---|
| Launched runs | 1 per ledger row | §1.3 |
| Reservation attempts | at most 3 per ledger row, the first automatic, the others by operator command | §5.2 |
| Container time cap | `local_failure.recheck.timeout_seconds` from the grant; the profile's own timeout must not exceed it, and cannot exceed 120 s | `contained-mission-profile-execution.ts:42` |
| Output | the profile's stdout and stderr limits, each at most 1 MiB | `contained-mission-profile-execution.ts:61`, `contained-command.ts:196` |
| Memory, CPU, pids | 128 MiB, 1, 64 | `contained-command.ts:106` |

The container time comes from the same pool as everything else on the chain: the grant's `budget.max_container_seconds`. Today `checkRootAdmission` subtracts the child allocations and the intake debit from that cap (`packages/core/src/state/engineering-root-admission.ts:77-82`). B7d adds a third term, the recheck debit, computed like the intake debit: a stopped run counts its used seconds and any other run counts its whole cap (`engineering-root-admission.ts:36-41`). The existing writers then see the recheck debit too, so no writer can spend the same seconds twice.

The recheck is separated from the repair budget in two ways. It never consumes a round, and it never touches the executor budget. It shares only container seconds and the wall-clock window.

Nothing reserves recheck time when the repair is dispatched. If the pool is empty when the recheck is due, the run is refused with `verify_budget_exhausted` and waits for the owner (decision 4).

### 2.4 Exclusion

An unsettled recheck run is a new kind of root activity. While a run is `reserved`, `running` or `stop_unknown`, review, Actions-repair and local-failure writers are refused with `verify_chain_busy`, and the recheck is refused while any of them is active. This reuses `readRootActivity` and `checkRootAdmission` (`engineering-root-admission.ts:15-33`, `:61-69`) with one more holder. It prevents another writer from moving the head under a running recheck.

## 3. From the run to the ledger

### 3.1 The "new accepted result on the new head"

Two readings are possible.

- **Reading A (recommended, and what the intake design says):** input (a) is the Watcher's own new result. The intake design, §8.1 step 5: "主机同 profile 在 C 通过；Watcher 在原云环境以同技能和断言复验 C，写新 passed 对象并关联原结果". It arrives as a check run of the verification App, is read by the bounded reader (`packages/cli/src/contained-mission-verification-reader.ts:112`) and is accepted into the source ledger (`packages/core/src/state/engineering-verification-source-store.ts:28-58`). The host run produces only input (c).
- **Reading B:** the host run itself becomes the accepted result. This would need the host to write a check run as the verification App, or a second kind of source row. The intake design rules the first out: the publishing token never reaches the host's PR checkout or model executor (§3.2), and producer identity comes from the GitHub API, not from the payload. Reading B is rejected.

Under Reading A the host recheck and the cloud recheck stay independent, which is the point of requiring both. The consequence is stated plainly in §8: `recheck_passed` also needs the Watcher's publisher (node B8) before it is reachable in production.

### 3.2 Recording the run

When the container has stopped with a valid stop receipt, one transaction does all of the following, as the diagnosis does (`contained-mission-diagnosis.ts:289-315`):

1. Settle the journal row to `stopped` with the outcome, the used seconds, the stop proof reference and digest, and the evidence digest.
2. Store the typed receipt in the same row: the canonical `LocalVerificationReceipt` JSON, its canonical digest from `localVerificationReceiptDigest` (`packages/core/src/bridge/local-failure.ts:143`), the run identity digest, and a receipt id `vrr_<uuid>`. Once written these columns are immutable.
3. Write the run's conclusion (§4).

The receipt outcome maps to the proof outcome as follows.

| Run observation | Receipt outcome (`contained-mission-diagnosis.ts:56-60`) | Proof outcome |
|---|---|---|
| exited, exit code 0, started, not OOM | `passed` | `passed` |
| exited, non-zero exit code | `reproducible_failure` | `failed` |
| timeout | `timeout` | `blocked` |
| cancelled | `cancelled` | `cancelled` |
| OOM, output limit, namespace rejected, runtime error, not started in the container | `infrastructure_error` | `blocked` |

Only `passed` can satisfy the ledger (`recheck.ts:138`).

### 3.3 Issuing and checking the proof

The run store in `@osstack/core` gets one method, `hostProof(recheck_id)`. Inside a transaction it:

1. reads the run row for that ledger row and requires `stopped` with outcome `passed`;
2. recomputes the canonical digest from the stored receipt JSON and requires it to equal the stored digest (the same re-check as `DiagnosisStore.consumeReceipt`, `engineering-diagnosis-store.ts:468-472`);
3. requires the run's head, base, profile digest and trusted source digest to equal the ledger row, and the chain's `published_head` to equal that head;
4. requires the original result to be still registered and not withdrawn;
5. calls `issueHostRecheckProof` with the receipt id, receipt digest and those four values.

This method is the only production caller of the issuer. The static test in `recheck.test.ts:98-117` is changed to allow exactly this one file. Because the proof is rebuilt from the row on every call, a restart loses nothing (fact 2 in §0).

The database also checks the proof, so that a mistake in process memory cannot pass a row. Migration 63 adds a trigger on the ledger table: an update that sets `host_receipt_id` is refused unless a run row exists for the same `recheck_id` with that receipt id, that receipt digest, state `stopped` and outcome `passed`. Adding a trigger does not rebuild the table.

### 3.4 Why no remote or bot path can produce it

- The issuer is unreachable from outside `@osstack/core` (`package.json:70-71`) and the only caller reads its inputs from a row, not from arguments.
- The row can only be written by the daemon owner (owner fence copied from `engineering-local-failure-intake-ddl.ts:72-74`, `:120-121`), inside the run library, after a stop receipt from the local Docker daemon.
- The run library and the collector are libraries with no caller in `daemon`, `bin`, `cli-entry` or any `*-rpc` file until the wiring node. A static test enforces this, in the same way as `packages/cli/src/contained-mission-diagnosis-guards.test.ts:5-23`.
- The wiring node (D5) adds two entry points only: the host's own tick, and an operator command that requires read, write and operator scope on the host, as publication approval does (`packages/cli/src/contained-mission-local-failure-approval.ts:10-14`). Neither is a decision kind. The Grok Bot channel only receives notices.
- **Amendment (2026-11-23, [grant renewal note](2026-11-20-local-failure-grant-renewal.md) §4.3, owner decision 8 of 2026-11-20).** The operator command reaches the host through one local-socket method, `mission.rearm_local_failure_recheck`. It arms a request in the daemon's memory and returns; the host's own tick then starts the run. The run therefore still has no decision kind, no webhook or bot entry and no remote answer path: `decisions.answer` answers `local_only` for the re-arm and never forwards it. The method cannot produce the proof: it writes one chain event and no run row. The implementation is described in [the re-arm note](2026-11-23-local-failure-recheck-rearm.md).
- Text from a PR, a check run or a bot is never an input to the run. The command, image, fixtures and limits come from the installed profile (intake design §5.1).

## 4. Failure and uncertainty states

The ledger row stays `reverify_pending / verify_recheck_missing` in every case below except the last row of the table, so the merge gate holds: the gate releases only for `recheck_passed` on the current head (**[B7c]** `packages/core/src/bridge/verification-gate.ts:73-76`, `:90-91`). The run row carries its own conclusion, shown to the operator. Codes marked *new* do not exist yet; the others are reused.

| Case | Journal state | Run conclusion | What happens next |
|---|---|---|---|
| Recheck opt-in absent from the grant | no row | `awaiting_decision / verify_grant_missing`, recorded as a chain event | Nothing runs. Owner renews the grant, then operator command. |
| Grant invalid or expired, principal or scope gone | no row | `awaiting_decision / verify_grant_invalid` (chain event) | Same. |
| Another writer active on the root | no row | `awaiting_decision / verify_chain_busy` (chain event) | Operator command later. No polling. |
| Container budget exhausted | no row | `awaiting_decision / verify_budget_exhausted` (chain event) | Owner decision. |
| Profile not installed, digest differs, or runtime blocker | no row, or `stopped / not_started` | `awaiting_decision / verify_profile_unavailable` | Owner fixes the host installation, then operator command. |
| Image preparation fails, or the fence fails before the start | `stopped / not_started`, 0 seconds | `awaiting_decision / verify_recheck_not_started` *(new)* | Attempt does not count as launched. Operator command, at most 3 attempts in total. |
| **Run failed:** profile exits non-zero | `stopped / reproducible_failure` | `awaiting_decision / verify_recheck_host_failed` *(new)* | Final. No second run, no second repair. |
| **Run timed out**, with proven stop | `stopped / timeout` | `awaiting_decision / verify_infrastructure_error` | Final in the first release (decision 5). |
| OOM, output limit, namespace rejected, runtime error, with proven stop | `stopped / infrastructure_error` | `awaiting_decision / verify_infrastructure_error` | Final in the first release (decision 5). |
| Stop not proven, identity or stop receipt mismatch | `stop_unknown` | `awaiting_decision / verify_stop_unproven` | Whole cap and the exclusion are kept until a stop is proven. No relaunch. |
| **Host crashed mid-run** | `running` at restart → `stop_unknown` | `awaiting_decision / verify_stop_unproven` | Same as above (§5.2). |
| **Head moved during the run** | settled truthfully from the stop receipt | `awaiting_decision / verify_stale_head` | No proof is issued (§3.3 step 3). The ledger also ignores a row whose chain head differs (`engineering-local-failure-recheck-store.ts:198-204`). No run for the other head. |
| Base changed | no row, or settled truthfully | `awaiting_decision / verify_base_changed` | Same as head moved. |
| **Original result withdrawn** before the start | no row | `closed / verify_withdrawn` (chain event) | Nothing runs. The intake design: after a push a withdrawal is recorded and blocks automatic continuation; it does not roll back the remote. |
| Original result withdrawn during the run | settled truthfully | `closed / verify_withdrawn` | No proof is issued (§3.3 step 4). |
| Recheck result (input a) withdrawn or superseded | unaffected | unaffected | Ledger reports the result missing (`engineering-local-failure-recheck-store.ts:172-194`); the gate re-checks currency (**[B7c]** `engineering-local-failure-recheck-store.ts:179`). |
| **Duplicate trigger** | existing row returned | unchanged | The table allows one active or launched row per `recheck_id`; a second trigger gets the existing row and launches nothing. A prepared plan also runs once (`contained-mission-profile-execution.ts:84-85`). |
| Run passed | `stopped / passed` | `host_passed`, reason null | Proof becomes available. The ledger passes only when (a) and (b) are also present. |

Nothing in this table retries automatically. The only automatic action in B7d is the first start.

A host failure is deliberately not written into the ledger row as `verify_recheck_failed`. That code means the Watcher's new result failed, and the table requires a result id for it (`engineering-local-failure-recheck-ddl.ts:98`). Changing that check would mean rebuilding the table. The hold is the same either way.

## 5. Crash recovery and idempotency

### 5.1 What is written before the run starts

1. **Reservation.** One immediate transaction: precondition (§1.2), grant check, root admission with the cap, insert of the run row in `reserved` with the bindings, the invocation id and the cap. It commits before anything is launched, as in the diagnosis (`contained-mission-diagnosis.ts:143-167`).
2. **Launch fence.** After the image is prepared and the fence is re-checked, the row moves to `running` with `started_at`, outside any other transaction (`contained-mission-diagnosis.ts:183-187`; intake rule at `engineering-local-failure-intake-store.ts:88-98`).
3. **Container journal.** The executor writes `binding.json` before creating the container and `launch.json` before starting it (`contained-command.ts:201-202`, `:234`).

### 5.2 What a restart does

Recovery runs once at start, in one transaction, and mirrors `recoverDiagnoses` (`contained-mission-diagnosis.ts:317-344`).

| Row found | Action |
|---|---|
| `reserved` | Settle as `stopped / not_started` with zero seconds. Conclusion `verify_recheck_not_started`. The cap returns to the pool. |
| `running` | Mark `stop_unknown / verify_stop_unproven`. The cap and the exclusion stay. |
| `stop_unknown` | Leave as it is. |
| `stopped` with a receipt | Nothing. The collector issues the proof again from the row on its next pass. |

A restart never launches. An attempt that ended `not_started` used no container and proves nothing about the code, so it does not use up the one launched run; a new attempt needs the operator command and there are at most three reservation attempts per ledger row. A run that crossed the launch fence is final.

Idempotency keys: `recheck_id` for the run (one active or launched row), `invocation_id` for the container (unique), receipt id and digest for the proof. Settling the journal and storing the receipt are one transaction, so there is no state in which a stopped run has no receipt. Evaluating the ledger twice with the same three inputs writes nothing (`engineering-local-failure-recheck-store.ts:229`).

## 6. What stays out

- **No second repair round.** A failed recheck, by the host or by the Watcher, creates no dispatch and no Mission. The intake design: "再次失败 → `awaiting_decision / verify_recheck_failed`，零第二次自动修复".
- **No automatic merge.** B7d only makes `recheck_passed` reachable. The gate still requires a counted User approval on the live head and ends at `ready_for_human` (**[B7c]** `verification-gate.ts:93-95`). `evaluateMergeGates` is not touched.
- No trigger for the Watcher's cloud recheck, and no check run written by the host. That is B8.
- No change to the profile runtime limits, to the diagnosis journal or to the ledger's columns and states.
- No recheck for any head other than the one the dispatch published.
- No remote, RPC or bot path that starts a run, re-arms one or issues a proof.
- No sandbox run. The end-to-end evidence stays in B9.

## 7. Node split

Each node is one PR against `main`. B7b (#478) must be merged before D2. B7c must be merged before D5.

| Node | Content | Main files | Migration | Acceptance tests |
|---|---|---|---|---|
| D0 | This document and the owner's decisions | `docs/design/2026-11-19-host-recheck-run.md` | no | Link check, governance tests |
| D1 | Recheck opt-in in the grant and `verifyRecheckGrant` (only under Reading 2) | `packages/core/src/bridge/revision-local-failure-grant.ts`, new `packages/core/src/bridge/recheck-admission.ts`, export in `verification-intake.ts` | no | A grant without the field parses and verifies exactly as before, with an unchanged signing input. With the field: wrong head, base, branch, profile digest, trusted source, expired window, wrong principal and a timeout above the opt-in are each refused. A V1 grant never gains the capability. |
| D2 | Run journal, shared budget and exclusion, proof issuance | new `packages/core/src/state/engineering-local-failure-recheck-run-ddl.ts` and `-run-store.ts`, `engineering-root-admission.ts`, `migrations.ts`, `recheck.test.ts` guard, schema constants in `packages/cli/src/attention-read-model.ts:22` and `upgrade-native-port.ts:20` | **63** | State machine and immutability triggers. One active or launched row per ledger row; at most three attempts. Review, Actions and local-failure writers are refused while a run is unsettled, and the reverse. Recheck debit reduces the shared pool; `stop_unknown` keeps the whole cap. `hostProof` returns a proof only for `stopped / passed` with matching digest, bindings and chain head, and null after a head move or a withdrawal. The ledger trigger refuses a `host_receipt_id` without a matching run row. Upgrade from 62 creates the objects and launches nothing. Only the run store names the issuer. |
| D3 | Run and recovery library, not wired | new `packages/cli/src/contained-mission-local-failure-recheck-run.ts` and guard test | no | With fake `prepare` and `run` ports: pass, non-zero exit, timeout, OOM, output limit, namespace rejected, stop unknown, identity mismatch, each ending in the state of §4. Fault points after reserve, after the launch journal, mid-run and before the receipt, each followed by recovery, never launch twice. Head move and withdrawal during the run issue no proof. A duplicate trigger returns the existing row. Static guard: no caller in daemon, bin, cli-entry or RPC files. |
| D4 | Collector, not wired: opens the ledger row after a confirmed push, gathers (a), (b) and the proof, calls `evaluate` | new `packages/cli/src/contained-mission-local-failure-recheck-collect.ts`, an adapter that produces `ActionsAttemptFact` | no | The row passes only with all three inputs. Any one missing leaves it pending with the right `missing` list. Presenting the inputs again after a restart gives the same row. A contract text whose digest differs from the source row is ignored. An incomplete or ambiguous Actions read is "missing", never success. |
| D5 | Wiring: automatic first start behind the protected switch, operator re-arm command, recovery at daemon start, the run's conclusion in the close-out view, notice to the owner on every `awaiting_decision` | `packages/cli/src/contained-mission-runner.ts` near `resumeConfirmedLocalPublication` (`:246`), host command module, close-out reader, guard tests | no | Switch off: nothing starts. Switch on: exactly one automatic start per ledger row. Re-arm needs operator scope and is refused for a launched run and after three attempts. No RPC or decision kind reaches the run or the proof. The close-out view shows the run's reason while the gate still holds. |

D1 and D2 are independent. D3 needs D1 and D2. D4 needs only B7b and can be built in parallel with D2 and D3. D5 needs D3, D4 and B7c. If D2 is too large for one review, split the root admission change from the table; the migration stays with the table.

## 8. Owner decisions (accepted 2026-11-19)

The owner accepted all nine decisions as recommended on 2026-11-19. The last column keeps the reason the alternative was not taken.

| # | Decision | Decided | Why not the alternative |
|---|---|---|---|
| 1 | Authority for the run: existing grant (Reading 1) or explicit recheck opt-in in the signed grant (Reading 2) | Reading 2 | Reading 1 saves node D1 but stretches "one diagnostic per head" to a second head without a signature that says so. |
| 2 | Automatic first start, or operator command for every run | Automatic first start, behind a host switch that defaults to off | Operator-only is safer by one step but every repaired PR then waits for a person before it can become mergeable. |
| 3 | Recheck time limit | `timeout_seconds` in the opt-in, at most 120; suggested value: the same as `diagnostic_timeout_seconds` | A separate, larger limit needs B3 to support it first. |
| 4 | Reserve the recheck seconds when the repair is dispatched | No in the first release; size `max_container_seconds` to cover diagnosis, repair and recheck | Reserving at dispatch guarantees the recheck can run but changes merged B6a code. |
| 5 | After a launched run ends as timeout or infrastructure error with a proven stop, allow one more run by operator command | No in the first release: a launched run is final | Allowing it avoids a dead end after a Docker fault, but it is a retry of a real execution and needs its own count and tests. |
| 6 | Attempts that never launched | Do not count as the launched run; at most 3 reservation attempts; the second and third only by operator command | Counting them makes a restart at the wrong moment a permanent dead end for the PR. |
| 7 | Where a host failure is recorded | In the run row; the ledger row stays pending and the gate holds | Sealing the ledger row needs a rebuild of the migration-62 table. |
| 8 | Reading A for input (a): the Watcher's new result, never the host run | Reading A | Reading B contradicts the intake design's producer rules. |
| 9 | New reason codes `verify_recheck_host_failed` and `verify_recheck_not_started` | Both accepted | Reusing `verify_recheck_failed` would mix a host failure with a Watcher failure. |

With these decisions recorded, nodes D1 to D5 are unblocked in the order given in §7.

## 9. What could not be verified

- Nothing was built or run for this document: no install, build, test or Codex job. All statements about behaviour come from reading the source at the commits named at the top.
- B7c was read from an unmerged local branch. Its hand-over note says the gates were not re-run after its rebase.
- Whether adding an optional key to the strict V2 grant schema leaves the signing input of existing grants byte-identical. The parser builds the signing input from the parsed preview (`revision-local-failure-grant.ts:78-83`), so it should, but this needs a test (D1).
- Whether a host stop reconciler exists that can move a `stop_unknown` row to `stopped`. The intake store names one (`engineering-local-failure-intake-store.ts:106-109`) but I did not find its caller. Without it, a `stop_unknown` recheck keeps the root excluded until a person acts.
- Whether production implementations exist for the ports the diagnosis library takes (`readCandidate`, `loadInstalledProfile` host, image options, Docker socket and journal root). The diagnosis library has no production caller (`contained-mission-diagnosis-guards.test.ts:5`), so D5 may have to supply them.
- `ActionsAttemptFact` has no producer. The existing Actions reader is built around failure hints and one registered job (`packages/cli/src/contained-mission-local-failure-reader.ts:98`, `:203-212`). What "the latest Actions attempt is green" covers (the registered job only, or every workflow on the head) and how its digest is formed are not defined in code. D4 must define this; it may deserve a short design note of its own.
- How the Watcher learns that it must verify the new head, and when. That belongs to B8, which is not built. Until then input (a) cannot arrive in production and `recheck_passed` stays unreachable even with B7d complete.
- How the upgrade gate treats unsettled journals from schema 59 on. The B5 hand-over note says it holds the upgrade while an intake is not stopped; I did not re-read that code. D2 should apply the same hold to unsettled recheck runs.
- The mechanism by which decision notices are answered remotely was not traced. §3.4 states the requirement and the guard tests; D5 must confirm that no existing answer path can reach the new entry points.
- The default grant validity is 24 hours (`packages/core/src/bridge/revision-grant.ts:13`). Whether a typical recheck falls inside the window of the grant that authorised the repair is an operational question; when it does not, the run stops at `verify_grant_invalid` and waits for a renewal.
- Docker is stopped on this machine by the owner's choice. No real recheck can run here until the owner starts it.
