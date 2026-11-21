# U4b R: renewal and upgrade of a version 2 grant, and the recheck re-arm transport

Date: 2026-11-20. Status: accepted; the owner accepted the nine decisions of §8 on 2026-11-20 (record in §8.1). No code, test or migration is part of this change.

Baseline: `main` at `b4d11955`. Every `file:line` below refers to that commit. Two local branches are named without line numbers: **[W2]** is `feat/local-failure-grant-issuing` at `73c0bc54` (first issuance of a version 2 grant, not merged) and **[W2b]** is `feat/local-failure-grant-readers` at `73a3079a` (version-aware readers, not merged).

Parent contracts: [verify-failure intake](2026-11-16-verify-failure-intake.md) ("the intake design"), [host recheck run](2026-11-19-host-recheck-run.md) ("the recheck design") and [route wiring](2026-11-20-local-failure-route-wiring.md) ("the wiring design"). This document adds rules they left open. It asks for one sentence of the recheck design to be amended (decision 8) and changes nothing else in them.

Words used here. A **V1 grant** is a signed revision grant of version 1 (review revisions only). A **V2 grant** is a V1 grant plus the `local_failure` opt-in; by the owner's decision a V2 chain also carries review revisions and the rounds are shared. A **renewal** replaces the grant of an existing live chain with a newly signed grant that names the chain in `renews`. An **upgrade** is a renewal from V1 to V2; a **downgrade** is a renewal from V2 to V1.

## 0. The gap

1. **A V2 chain cannot be renewed.** `buildRenew` and `RevisionChainStore.replaceGrant` parse the chain's grant with the V1 parser and answer `chain_grant_unreadable` (`packages/cli/src/contained-mission-grant.ts:378`, `packages/core/src/state/engineering-revision-chain-store.ts:373`). **[W2]** also refuses a V2 preview that carries `renews`.
2. **A V1 chain cannot be upgraded**, and a Mission that ever had a live chain answers `chain_exists` at first issuance (`contained-mission-grant.ts:361`). So V2 is reachable only for a PR that never had a chain.
3. **The recheck design depends on a renewal that does not exist.** Its §4 gives "Owner renews the grant, then operator command" as the only exit for `verify_grant_missing` and `verify_grant_invalid`. The default validity of a grant is 24 hours and the maximum is 7 days (`packages/core/src/bridge/revision-grant.ts:13-14`), so an expired grant in the middle of the route is the ordinary case, not a rare one.
4. **Even with a renewal, the recheck would refuse it.** `verifyRecheckGrant` returns `verify_grant_invalid` when the run head equals the grant's head (`packages/core/src/bridge/recheck-admission.ts:61`). A renewal signed after the repair was pushed binds the new head, which is the run head.
5. **Several rows bind the exact old grant** (§2.5). A renewal at the wrong moment turns a waiting step into a permanent refusal.
6. **The operator re-arm of the recheck has no transport.** The recheck design says the run "has no RPC, webhook or bot entry" (its §1.4, §3.4). Every operator action that exists is a `mission.*` method on the local socket, and only the daemon may write the run row.

## 1. What exists today

| Fact | Where |
|---|---|
| V1 renewal: allowed in `awaiting_review`, `ready_for_human`, or `awaiting_decision` with a refreshable stop reason; no pending or uncertain push intent | `engineering-revision-chain-store.ts:366-380`, `contained-mission-grant.ts:369-380` |
| V1 renewal keeps repository, PR, branch, base, scope and `protected_set_digest`; binds the chain's current `published_head` and `published_base`; needs a new `grant_id` and `renews = {chain_id, revision}` | `engineering-revision-chain-store.ts:378-379`, `contained-mission-grant.ts:391-394` |
| V1 renewal never lowers rounds or a budget limit; "terms may be raised, never silently lowered" | `engineering-revision-chain-store.ts:380-381`, `contained-mission-grant.ts:383` |
| The database repeats part of this: rounds never shrink and the binding cannot move | trigger `engineering_chain_grant_monotonic`, `packages/core/src/state/engineering-revision-grant-ddl.ts:9` |
| The wall-clock budget counts from the chain's `budget_json.origin`, which a renewal does not reset; the cap is 168 hours | `packages/core/src/bridge/diagnosis-admission.ts:41`, `revision-grant.ts:19` |
| Signing path: preview over RPC, signature by the host command with the issuer key the daemon never holds, acceptance over RPC | `contained-mission-grant.ts:6-9`, `:188` |
| The diagnosis requires the request head to equal the grant's head | `diagnosis-admission.ts:80` |
| The local dispatch already tolerates a V2 grant with `renews` if it names this chain | `packages/cli/src/contained-mission-local-failure-dispatch.ts:83` |
| One local repair per root, whatever the rounds | `packages/core/src/state/engineering-local-failure-dispatch-store.ts:167-170` |

## 2. Rules

### 2.1 Direction

| From → to | Rule |
|---|---|
| V1 → V1 | Unchanged, byte for byte. No node of this note may edit an existing V1 test to pass. |
| V2 → V2 | Allowed under §2.2 to §2.4 (decision 1). |
| V1 → V2 (upgrade) | Allowed as a renewal whose preview is V2, in its own later node (decision 3). It must pass every renewal rule and every first-issuance V2 rule of **[W2]** (route switch on, repository grammar, opt-in terms). The intake design says an existing grant cannot be upgraded automatically; a newly signed preview is not automatic. |
| V2 → V1 (downgrade) | Never (decision 4). Dropping the opt-in is lowering a term. The owner withdraws the local route by abandoning the chain or by turning the route switch off. |

### 2.2 What a V2 renewal may change in the opt-in

The inherited V1 fields follow the V1 rules of §1 without change. For `local_failure` (`packages/core/src/bridge/revision-local-failure-grant.ts:22-37`), decision 2:

| Field | Rule | Reason |
|---|---|---|
| `enabled` | Stays `true` | Downgrade is refused |
| `profile_id`, `profile_digest`, `trusted_source` (the pin) | May change only while the chain has no intake row at all. From the first intake row on, the renewal must carry the identical pin | The recheck ledger pins profile and trusted source from the original contract, and the recheck requires the grant pin to equal it (`recheck-admission.ts:63-68`). A changed pin after a diagnosis would make the recheck unrunnable, and it would allow a second diagnosis of the same head, because the "one per head" rule is keyed on head and profile digest (`engineering-local-failure-intake-ddl.ts:67`) |
| `diagnostic_timeout_seconds` | May be raised, never lowered; the budget rule of the schema still applies | Same rule as budgets |
| `max_diagnostics_per_head` | Stays `1` | Literal in the schema |
| `recheck` | May be added. Once present it may not be removed. `timeout_seconds` may be raised up to 120, never lowered | Adding it is the exit for `verify_grant_missing` |

A renewal request that names no opt-in term keeps the chain's opt-in exactly as it is, as the V1 path does for rounds and budget.

Refusal codes: lowering or removing a term is `grant_not_monotonic` (existing). A pin change after the first intake is `grant_opt_in_changed` (new). A V2 preview for a V1 chain before the upgrade node exists is `grant_upgrade_unsupported` (new).

### 2.3 When a renewal is allowed

The V1 conditions of §1 apply. A V2 renewal and an upgrade add one condition, checked inside the same write transaction as the replacement: **the root has no local-failure work in motion.** Using the holders of `readRootActivity` (`packages/core/src/state/engineering-root-admission.ts:15-33`):

- no intake in `reserved`, `running` or `stop_unknown`;
- no recheck run in `reserved`, `running` or `stop_unknown`;
- no local-failure child that is executing, and none whose publication process was released and is not yet confirmed or proven unwritten.

A local-failure child that is waiting for a person at the publication gate does not block a renewal (decision 5, accepted); any other unsettled local-failure child blocks it. Refusal code: `grant_renewal_busy` (new).

Why: the intake triggers compare the chain's grant text with the row's at insert and again at start (`engineering-local-failure-intake-ddl.ts:80`, `:126`). A renewal between the two refuses the start, and the head has then used its one diagnosis. A renewal under a running container would leave a run that started under one signature and settles under another.

A row in `stop_unknown` therefore blocks every renewal until the stop is proven. That matches both parent designs: the whole cap and the exclusion are kept until then.

### 2.4 Head binding and the two admission checks

A renewed grant binds the chain's `published_head` and `published_base` at the time of the preview, as V1 does. Two consequences.

**Diagnosis.** Because the diagnosis requires the request head to equal the grant's head (`diagnosis-admission.ts:80`), a V2 chain whose head was moved by a review revision can no longer diagnose a failure until it is renewed. This is today's behaviour, not a new rule; a renewal is the way to rebind the head. No change.

**Recheck.** `verifyRecheckGrant` must accept a renewed grant (decision 7). New head rule, replacing the single inequality at `recheck-admission.ts:61`:

- the run head equals the chain's `published_head` and the ledger's `new_head_sha` (unchanged);
- if the grant's head differs from the run head, nothing more is required (the grant was signed before the repair; today's case);
- if the grant's head equals the run head, the grant must carry `renews.chain_id` equal to the chain of the ledger row. A first-issued grant on the run head is still refused.

The check needs the chain id as one more input. Everything else in the function stays: signature, principal, validity window, wall clock, base, profile pin, timeout.

### 2.5 Rows that bind the old grant

| Row | How it binds | After a renewal |
|---|---|---|
| Intake, stopped | Immutable copy of the old grant text, id and digest (`engineering-local-failure-intake-ddl.ts:110`) | History. Nothing reads it against the chain again, except the dispatch below |
| Intake, not stopped | Start requires the chain's grant text to equal the row's (`:126`) | Cannot occur: §2.3 refuses the renewal |
| Diagnosis request `eligible`, not yet dispatched | Dispatch requires the intake's grant digest to equal the digest of the chain's current grant (`engineering-local-failure-dispatch-store.ts:153`) | Today: `verify_grant_invalid` for ever, and no second diagnosis of that head. Decision 5 |
| Dispatch with a child waiting at the publication gate | The publication fence requires the dispatch's grant digest to equal the digest of the chain's current grant, and the grant to be inside its window (`:110-114`) | Today: `verify_publish_authority_invalid` for ever; the root's one repair is lost. Decision 5 |
| Recheck ledger row | No grant column | Unaffected |
| Recheck run, stopped | Immutable grant id and digest | History. `hostProof` does not read the grant |
| Recheck run, new attempt | Reserved under the chain's current grant (`engineering-local-failure-recheck-run-store.ts:142-143`, `engineering-local-failure-recheck-run-ddl.ts:63`) | Works: the next attempt binds the renewed grant, given §2.4 |
| Review reservation and review child | V1 rules in `replaceGrant` (`engineering-revision-chain-store.ts:388-412`) | Unchanged |

### 2.6 Carrying work forward (decision 5)

Two waits in the table above end in a dead end exactly when the owner does what the stop asks for:

- an eligible diagnosis that could not be dispatched because the budget or the rounds were too low, or the grant had expired; the owner renews with more, and the dispatch then refuses the digest;
- a repair child waiting for the candidate approval while the grant expires; the approval window is 15 minutes but the wait for a person is not bounded, and the default grant lives 24 hours.

Rule (accepted with decision 5): in these two places the exact-digest test becomes a succession test. A row bound to an earlier grant of a chain is honoured under the chain's current grant when the row's chain is this chain, the current grant is V2 and carries `renews` for this chain, and its pin equals the pin stored in the intake row. A chain's grant changes only through `replaceGrant`, so every earlier grant of a chain is an ancestor of the current one. All other checks at both places stay as they are and are made against the current grant: signature, principal, scope, validity window, wall clock, head, base, source not revoked.

What the owner sees before signing: the host command lists the work the renewal carries forward (an eligible diagnosis, a child waiting for approval, a pending recheck with its attempts). This list is displayed, not signed. The signed `renews.revision` pins the chain row, which changes on dispatch, on a confirmed push and on every chain transition, but not when an intake or a run row is written; §2.3 is therefore checked again inside the write.

A renewal never approves a candidate. The approval stays a separate act of a person (wiring design, decision 2).

### 2.7 Unchanged, stated so nobody assumes otherwise

- **Rounds are shared and the local repair is single.** Raising rounds from 1 to 2 after the local repair gives a review revision one more round. It does not allow a second local repair (`engineering-local-failure-dispatch-store.ts:167-170`).
- **The wall clock is not reset.** A chain lives at most `max_wall_clock_hours` from its origin, at most 168 hours, however often it is renewed.
- **The protected set is kept.** A renewal carries the old `protected_set_digest`; a changed protected set stops the chain and is not refreshable.
- **The principal may change within the scope.** A renewal is requested by the current principal and session, which is the exit for "principal or session gone".
- **The route switch.** With `OSSTACK_LOCAL_FAILURE_REPAIR` off, **[W2]** stores no V2 grant. A V2 chain can then be neither renewed nor downgraded and stays at its current grant until the switch is on again (decision 9).

## 3. Signing path and remote answers

A V2 renewal uses the V1 path and nothing else:

1. `mission.revision_grant_renew_preview` gains the same optional `local_failure` terms that **[W2]** added to `mission.revision_grant_preview`. No new method.
2. The host command `mission grant-revisions --chain` shows the preview, the opt-in field by field as "old → new", and the list of §2.6. It asks for the typed phrase `RENEW LOCAL-FAILURE <digest>` and signs with the issuer key.
3. `mission.grant_revisions` verifies the signature against the remembered preview, rebuilds the preview from live facts, and calls the store. No method accepts a renewal without a signature.
4. `decisions.answer` keeps answering `local_only` for `grant_revisions` and `grant_local_failure_repair` on every engineering source (**[W2]**). The decision list offers the renewal for a V2 chain again (**[W2]** removed it), marked as needing a local signature, with the host command as the only alternative.
5. The chain event `grant_replaced` gains the version and a summary of the opt-in (profile id, profile digest, whether recheck is present, which terms changed).

Text from a PR, a check run or a bot is never an input to a preview. The opt-in terms come from the command line of the person at the host.

## 4. The re-arm transport

### 4.1 What the re-arm is

The recheck design allows at most three reservation attempts per ledger row; the first is automatic and the others need "an explicit operator command on the host" (its §1.4, §5.2). The library takes this as `runRecheck(ports, recheckId, "operator", signal)` (`packages/cli/src/contained-mission-local-failure-recheck-run.ts:73`). An attempt after a refusal that wrote no row is also an operator attempt.

A re-arm grants nothing. The signed grant already authorises the recheck, its profile and its time limit. A re-arm cannot push, cannot change code, cannot pass the ledger (that also needs the Watcher's result and green Actions), cannot start a second launched run and cannot exceed three attempts; the database enforces the last two. It asks the host to try once more what the owner signed.

### 4.2 Options

| Option | For | Against |
|---|---|---|
| A. A `mission.*` method with read, write and operator scope that `decisions.answer` refuses with `local_only` | Same pattern as the candidate approval (wiring design, decision 2). No new mechanism. Proportionate to what a re-arm can do | Contradicts the literal sentence "no RPC reaches the run". Any holder of an operator-scope credential on the local socket can call it |
| B. A re-arm ticket signed with the issuer key, verified by the daemon | A credential alone is not enough | A second signed object with its own schema, nonce and tests, for an action weaker than the candidate approval, which is not signed |
| C. The renewal itself re-arms | No new entry at all | Forces a new grant for every retry, also when the grant is fine (root busy, image preparation failed). Mixes two acts in one signature |
| D. A host command that writes the database directly | Literally no RPC | Only the daemon owner may write the run row, and a development or operator CLI must not open the serving database |

### 4.3 Recommendation: option A, with these rules

- **Method.** `mission.rearm_local_failure_recheck { credential, mission_id, expected_attempt, decision_id }`. `mission_id` is the root. `expected_attempt` is one more than the number of run rows and must match, so a replay cannot use two attempts.
- **Authority.** Read, write and operator scope on the Mission's scope, refreshed at the call, as `approveLocalFailureRepair` requires (`packages/cli/src/contained-mission-local-failure-approval.ts:10-14`). The method exists only with the route switch on.
- **Not answerable remotely.** It is not a decision kind. `decisions.answer` returns `local_only` for it. The decision list shows a waiting recheck as an item with the host command `mission recheck-rearm` as the only alternative and no allowed answer.
- **It arms; it does not run.** The handler checks, in one transaction: a live open chain, a ledger row in `reverify_pending` for this root, no unsettled run, no launched run, fewer than three attempts. It appends the chain event `local_recheck_rearm_requested` and returns. The service's recheck tick (D5b) then calls `runRecheck` once with the trigger `operator`. A local RPC must not wait for an image build and a container.
- **Short-lived.** An armed request is held in memory, is void after 15 minutes and after a daemon restart, and there is at most one per ledger row. This keeps the recheck design's rule that a restart never launches.
- **The grant is not its concern.** The method does not verify the grant; `runRecheck` does, and refuses with today's reasons. A renewal does not re-arm by itself: the two steps stay separate, as the recheck design wrote them.
- **Amendment.** The recheck design's sentence becomes: the run has no decision kind, no webhook or bot entry and no remote answer path; its only entries are the host's own tick and one local-socket method with operator scope that `decisions.answer` refuses. This is the one change to an approved design and it needs the owner's word (decision 8).

## 5. Exits this note creates

| Stop | Exit |
|---|---|
| Diagnosis refused: grant expired, or principal or session gone | Renew (no rows are bound yet) |
| Diagnosis refused: head was moved by a review revision | Renew; the new grant binds the current head |
| Eligible diagnosis not dispatched: budget, rounds or expiry | Renew with the missing term (decision 5, node R4) |
| Child waiting for approval, grant expired | Renew, then the approval (decision 5, node R4) |
| Recheck `verify_grant_missing` | Renew adding `recheck`, then re-arm |
| Recheck `verify_grant_invalid` | Renew, then re-arm |
| Recheck `verify_budget_exhausted` | Renew with more container seconds, then re-arm |
| Recheck `verify_chain_busy`, `verify_profile_unavailable`, `verify_recheck_not_started` | Re-arm (after the cause is gone) |
| Wall clock used up at 168 hours | None. Abandon or take over the chain |
| Any `stop_unknown` | None until the stop is proven; no renewal either |

## 6. What stays out

- No second local repair, no second launched recheck, no fourth attempt.
- No change to the V1 grant, its signing input or its tests; no change to the V2 schema (the opt-in keeps its fields).
- No change to `evaluateMergeGates`, the profile limits, the ledger or the journals.
- No path that stores a grant without a host signature, and no remote path that answers a renewal, an upgrade or a re-arm.
- No automatic renewal and no renewal proposed by a bot.

## 7. Node split

One PR per node against `main`. **[W2]** and **[W2b]** must be merged before R1. Every node keeps V1 behaviour identical and leaves existing V1 tests unedited.

| Node | Content | Main files | Migration | Acceptance |
|---|---|---|---|---|
| R1 | Core rules: version-aware `replaceGrant` for V2 → V2, the opt-in rules of §2.2, the activity rule of §2.3, the database guard of decision 6, `grant_replaced` payload | `engineering-revision-chain-store.ts`, new pure rules module beside `revision-local-failure-grant.ts`, `engineering-revision-grant-ddl.ts`, schema constants | next free number, one trigger, decision 6 | V1 renewal results, codes and writes are unchanged. V2 → V2 with identical opt-in passes. Each of: pin change after an intake row, lowered timeout, removed recheck, V2 → V1, wrong `renews`, same `grant_id`, lowered rounds or budget is refused with its code. Pin change with no intake row passes. Each unsettled intake, run and executing child refuses with `grant_renewal_busy`. The trigger refuses the same cases when the store is bypassed. Upgrade of the schema launches nothing |
| R2 | Service and host command: V2 renewal preview, typed phrase, acceptance, decision list and `decisions.answer` | `contained-mission-grant.ts`, `contained-mission-grant-command.ts`, `contained-mission-grant-terms.ts`, `decisions/list.ts`, `decisions/answer.ts` | no | A V2 renewal without a valid host signature is refused. A request without opt-in terms keeps the opt-in byte for byte. The preview shows old and new opt-in. Switch off: `local_failure_repair_disabled`, nothing stored. `decisions.answer` never forwards it. A V2 preview for a V1 chain answers `grant_upgrade_unsupported`. The V1 renewal flow is unchanged |
| R3 | Recheck head rule for a renewed grant (§2.4) | `recheck-admission.ts`, its caller in the run library | no | A first-issued grant behaves exactly as today, including refusal when its head is the run head. A renewed grant on the run head passes only with `renews` for this chain. A renewed grant for another chain is refused. Every other refusal of D1's test list still holds |
| R4 | Carrying work forward (§2.6), decision 5 | `engineering-local-failure-dispatch-store.ts` (dispatch and publication fence), host command list | no | First: trace whether a child halted at `verify_publish_authority_invalid` can resume; if not, the rule covers only a child still at the gate. Then: an eligible diagnosis dispatches after a renewal that raises the missing term; a child at the gate publishes after a renewal and a fresh approval; a grant of another chain, a V1 grant, a changed pin, an expired renewed grant are each refused; without a renewal both places behave as today |
| R5 | Upgrade V1 → V2, decision 3 | as R1 and R2 | no | A V1 chain becomes V2 only with a signed V2 preview that names the chain and with the switch on. Rounds used, budget origin, allocations and published head are kept. A chain with a review reservation or an unsettled review child follows the V1 renewal rules. After the upgrade a failure on the bound head can be diagnosed once |
| D5c | Re-arm method and host command (§4.3), close-out view, notices | `contained-mission-rpc.ts` (one method), the route assembly, new host command, `decisions/list.ts`, `decisions/answer.ts`, guards | no | Switch off: the method is absent. Without operator scope: refused. Wrong `expected_attempt`, a launched run, three attempts, an unsettled run, a row that is not pending: each refused, nothing armed. An armed request runs once with the trigger `operator`, is void after 15 minutes and after a restart. `decisions.answer` answers `local_only`. No other RPC or decision kind reaches the run or the proof |

R1 and R3 are independent. R2 needs R1. R4 and R5 need R2. D5c needs R2, R3 and D5b.

## 8. Decisions for the owner

| # | Decision | Recommendation | If the alternative is taken |
|---|---|---|---|
| 1 | May a V2 chain be renewed as V2 | Yes, by the V1 path: preview over RPC, host signature, `local_only` in `decisions.answer` | Without it a V2 chain that expires can only be abandoned, and the recheck design's stops have no exit |
| 2 | What a renewal may change in the opt-in | §2.2: the pin only before the first intake row; timeouts only upwards; recheck may be added, never removed | Freezing the pin always is simpler, but a mistyped digest then costs the PR its chain for ever. Leaving the pin free allows a second diagnosis per head and can make the recheck unrunnable |
| 3 | May a V1 chain be upgraded to V2 | Yes, as node R5 after R1 to R3, with a signed V2 preview | Without it no PR that already has or had a chain can ever use the local route |
| 4 | May a V2 chain be downgraded to V1 | No | Allowing it needs rules for every row that binds the opt-in, for a benefit the switch and `abandon` already give |
| 5 | Does a renewal carry waiting work forward (§2.6) | Yes, for the eligible diagnosis and the child at the publication gate, as node R4 | Simpler and stricter, but a grant that expires while a person is asked to approve loses the root's only repair, and raising a budget cannot unblock the dispatch it was raised for |
| 6 | A database trigger for the opt-in rules (version, pin after an intake, recheck not removed) | Yes, one trigger in a new migration, as the rounds rule has today | Store-only checks need no migration, but the existing rule for rounds is guarded in the database "whatever the writer does" |
| 7 | The recheck head rule for a renewed grant (§2.4) | Accept a grant on the run head only when it carries `renews` for this chain | Without it "renew, then operator command" always ends in `verify_grant_invalid` |
| 8 | The re-arm transport | Option A of §4: `mission.rearm_local_failure_recheck` with operator scope, `local_only` in `decisions.answer`, arming only, void after 15 minutes or a restart; the recheck design's sentence is amended as in §4.3 | A signed ticket (B) is stronger than the action needs and stronger than the candidate approval. Re-arm by renewal (C) costs a signature per retry |
| 9 | The switch is off and a V2 chain expires | Keep the **[W2]** rule: no V2 grant is stored with the switch off, so the chain cannot be renewed until the switch is on | Allowing a renewal with an unchanged opt-in while the switch is off keeps review revisions alive on such chains, but breaks the accepted W2 statement "no path stores a V2 grant with the switch off" |

### 8.1 Decision record (2026-11-20)

The owner accepted all nine decisions on 2026-11-20, each as recommended in the table above. The owner's words: "九项都按建议来，文档开 PR，继续跑".

| # | Decided |
|---|---|
| 1 | A V2 chain may be renewed as V2 by the V1 path: preview over RPC, signature only by the host command, `local_only` in `decisions.answer` |
| 2 | On renewal the opt-in follows §2.2: the pin may change only before the first intake row; timeouts only upwards; recheck may be added, never removed |
| 3 | A V1 chain may be upgraded to V2, as node R5 after R1 to R3, with a signed V2 preview |
| 4 | A V2 chain is never downgraded to V1 |
| 5 | A renewal carries waiting work forward (§2.6) for the eligible diagnosis and the child at the publication gate, as node R4 |
| 6 | The opt-in rules are guarded by one database trigger in a new migration |
| 7 | The recheck accepts a grant on the run head only when it carries `renews` for this chain (§2.4) |
| 8 | The re-arm transport is option A of §4: `mission.rearm_local_failure_recheck` with operator scope, `local_only` in `decisions.answer`, arming only, void after 15 minutes or a restart; the recheck design's sentence is amended as in §4.3 |
| 9 | With the switch off the **[W2]** rule stays: no V2 grant is stored, so a V2 chain cannot be renewed until the switch is on |

With these decisions recorded, nodes R1 to R5 and D5c are unblocked in the order of §7. The record does not settle the points of §9; R4 still starts with the trace named in its row.

Already decided before this note and not reopened: a V2 grant is a V1 grant plus the opt-in; a V2 chain carries review revisions with shared rounds; one switch for the route; the candidate approval is a `mission.*` method refused by `decisions.answer`.

Choices I made that the owner may overrule without a decision row: the three new refusal codes, the typed phrase `RENEW LOCAL-FAILURE <digest>`, the method and command names, the 15 minutes.

## 9. What could not be verified

- Nothing was built or run for this document beyond the gates in §10. Every statement about behaviour comes from reading the source at `b4d11955` and the two local branches.
- **[W2]** and **[W2b]** are unmerged. I read the grant service at `954a509d` and `73a3079a`; the task names `73c0bc54` as the current W2 head, which I did not diff against them. Line numbers are therefore given only for `main`.
- The review fences of a V2 chain (launch, push, review deadline) are being made version-aware in another node. This note assumes they accept a valid V2 grant, renewed or not; I did not read that work.
- Which states a local-failure child passes through at the publication gate, and whether a child already halted at `verify_publish_authority_invalid` can be resumed. `resume_grant` needs a `publish_target` that such a child does not have (wiring design, §4 flag 3). R4 must trace this first.
- Whether a diagnosis request that was refused before any intake row (expired grant, wrong pin) is tried again after a renewal, or needs a new result from the Watcher. §5 rows 1 and 2 assume a later registration can run; W3 and W4 own that behaviour.
- Whether the candidate approval record binds anything of the grant. I found no grant field in `contained-mission-local-failure-approval.ts` by search, not by reading the whole file.
- Whether any remote client holds an operator-scope credential on the serving host. If one does, option A lets it re-arm by calling the method directly; `decisions.answer` is not the only way to the socket. The same holds for the candidate approval already accepted.
- Whether a host reconciler can move a `stop_unknown` intake or run to `stopped`. Both parent designs list the same doubt. Without one, such a row blocks renewal for good.
- The number of the next free migration. Schema 63 is the latest on `main`; other open branches may take 64 first.
- Docker is stopped on this machine by the owner's choice. No node here can be exercised against a real container.

## 10. Gates for this document

`pnpm test:deterministic-rules` passes. In `packages/governance`, `vitest run` passes. After the decision record was added and the branch rebased onto `28c8cf16`: `pnpm lint`, the inventory check and `pnpm test:deterministic-rules` pass. The three relative links in this document point to existing files. Nothing else was run; this document claims no implementation, container run or sandbox result.
