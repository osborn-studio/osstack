# B1 finding dispositions (2026-10-24)

These are engineering dispositions for a fresh Haiku re-review, not a replacement model verdict.

## F1 — reproduced and fixed
A concurrent same-daemon reconcile converted a still-live send to unknown and discarded its eventual valid receipt. Added a service-local inFlight set around the bounded transport call and durable settlement. Reconcile returns in_flight unchanged during the bounded dispatch wait and durable settlement. finally removes the entry after settlement/error or its deadline; this does not attest physical provider stop. After timeout, exact read-only lookup is allowed even if send ignores abort; late send responses do not write the DB. Restart/crash recovery, timeouts and concurrent revocation remain conservative unknown; no retries or authority relaxation. Cross-process reconciliation still cannot infer another process's liveness and conservatively records unknown. The daemon owns one persistent service instance.

Regression `reconcile preserves an active send and its eventual receipt` failed before the change (unknown revision 5 instead of started revision 3), passed after. Initial full follow-up-delivery file: 49 passing; round3 adds explicit timeout-window coverage (51 passing). Existing revocation-race, timeout-late-receipt and SIGKILL tests remain passing. Raw successful run: B1-follow-up-test.log.

## F2 — reproduced and fixed
Scout terminal JSON now escapes DEL/C1, line separators and all Unicode Cf characters, including supplementary characters as two JSON surrogate escapes. Parsed JSON preserves exact original source text. Extended actual scout CLI output test with U+202E, U+2066, U+2069; observed failure before fix and success after. Full scout file: 16 passing. Raw successful run: B1-scout-test.log.

## F4 — original contract finding: existing downstream constraints; later repair-loop pin fixed
The initial bare-contract authority claim required no production change. Subsequent review identified and fixed a separate ignored execution-context config mutation across repair attempts; see the final addendum below. Read the following full symbols/files together:

1. `packages/protocol/src/delivery-contract.ts` — `DeliveryContractV2.superRefine` explicitly rejects local_verified with any action other than build/verify or any publication; PR completion requires draft_pr/review_pr; local/PR completion forbids merge/deploy authority; merged/deployed requires review_pr and existing_guarded_policy whose policy_ref matches the digest. The proposed none-scope push+merge contract cannot parse for any completion.
2. `packages/core/src/delivery-contract.ts` — `freezeDeliveryContract`, `assertFrozenDeliveryContract`, `assertDeliveryContractAdmission` all parse this schema; frozen digest and canonical brief are recomputed and checked. `packages/cli/src/deliver-command.ts` reads the bare contract and re-freezes it with freezeDeliveryContract, obtains host policy/check registry, then checks fresh admission before startGuardedGit.
3. `packages/cli/src/bin.ts` — `createDeliverCommandDeps.deliveryContractPolicy` obtains `guardedPolicySnapshot`, binds budget_ref to the policy SHA, and extracts the four budget fields. `startGuardedGitDelivery` obtains a fresh snapshot again, uses its SHA in routing, and passes the SAME four host-policy fields as `runtime.start({budget})`. The budget is rederived from the pinned policy instead of trusting CLI forwarded values. `requireAutoMerge` is required only for merged/deployed completion. Inspect full `startGuardedGitDelivery`, `guardedPolicySnapshot` and `createGuardedGitRuntimeForDb`.
4. `packages/cli/src/guarded-git-runtime.ts` — `start` parses routing/FrozenDeliveryContract, rechecks admission/policy digest/budget_ref, task/goal/actions/allowed_paths identity and publication target. `assertPolicy` checks current policy. `runLocal` creates execution context through the host dependency before LoopEngine construction; bin wires this to `createDeliveryExecutionContext` → `createHostExecutionContext`. Raw config path is a selector, not a bypass of the host wrapper. Inspect `GuardedGitRuntime.start`, `runLocal`, `assertPolicy`, and `engine`.
5. `packages/autonomy/src/engine.ts` — local_verified stops before git publication (`completeLimitedContract`), pr_opened stops after exact-head scoped PR creation, merged/deployed take corresponding paths. `assertPostDiffActionAuthorized` first rejects any action absent from frozen contract, then checks signed post-diff authorization for R3. `approvalActionScope` derives completion-limited effects. Runtime `openPullRequest` rechecks publication scope and current candidate head.

Actual verification: `packages/cli/src/guarded-git-runtime.test.ts` full file 24 passing (run alongside 16 scout tests, 40 total). Its `V2 guarded runtime host receipts` local_verified/pr_opened cases assert actual Loop evidence, exact push for PR only, no merge/check calls, final achieved completion and host receipts. `packages/protocol/src/delivery-contract.test.ts` tests schema rejection and missing action/merge policy constraints; successful rerun in B1-contract-test.log. Existing autograph engine tests additionally cover limited contract completion in `packages/autonomy/src/engine.test.ts`.

## F5 — explicit threat-model qualification required
Issuer help already says same-uid hostile processes are outside the authority boundary. Private 0600 files/0700 home and exact signature bindings protect RPC/untrusted-source authority creation, not a shell process already allowed to modify the operator's host registry and keys. Main ledger must state this explicitly. A model-driven shell with unrestricted same-uid host filesystem access is outside this boundary too. Production isolation requires separate uid/sandbox/key access controls; no claim of same-uid adversarial isolation. No silent key relocation or new credential ceremony introduced.

## F6 — intentional conservative unresolved state, operational limitation
No not-found/timeout result proves non-delivery, so neither revoke nor new idempotency key may rearm unresolved sends. Adding abandonment that unblocks another attempt could duplicate an externally delivered message. Preserve unknown and prevent resend, and document no terminal human-attested abandonment interface exists. Lookup scans at most 200 comments in the bounded provider interval and separate host deadlines default to 5000ms for send/preflight and 30000ms for read-only lookup (both capped at 30000ms). Positive exact provider receipt may resolve it. Otherwise this destination remains blocked; users must not edit DB or repeat delivery. This is an explicit unresolved-operation limitation, not a fabricated recovery guarantee.

## F7 — dependency exists; optional defense added by parent
Production `createDeliverCommandDeps` unconditionally defines deliveryContractPolicy. No actual missing-dependency path found in scout's real main composition. Parent additionally replaced assertion with typed refusal for defense in depth.

## F9 — external qualification still pending, no unsafe normalization workaround
Real GitHub body normalization is not established by fixtures. Exact-body comparison deliberately refuses ambiguous evidence. Preserve default-off host transport until dedicated sandbox qualifies send/lookup including CRLF, trailing whitespace and provider normalization. Do not claim actual GitHub qualification or weaken equality to marker-only matching. No real public send performed.

F3/F8 and shared daemon/bin changes are owned by parent and not edited here.

## Final scoped review addendum

Haiku 5.5 final review `reaudit-B1-final-result.json` returned PASS_SCOPED (exit 0, is_error false). No P0/P1/P2 remains within B1 and C4/C5; this is not a full integration or CI verdict.

F1: an orphaned persisted started state may yield an in_flight response, which only means start was recorded. After process restart, reconcile is required; that response alone never attests a live transport. The service-local guard covers bounded dispatch settlement only.

F2/C0: scout maps untrusted exception messages to a fixed error code. The real deliver policy gate now terminal-escapes C0/C1, DEL, line separators and Unicode formatting controls without changing authorization or exit decisions. Its actual policy-loader regression passes.

F4: guarded-git-runtime now persists the initial canonical execution-context config path, file identity and semantic digest, checking this pin before and after each host context construction. An actual Git-ignored config repair regression rejects the second construction (25 runtime tests pass). Dynamic source and policy checks remain fresh. There is no completion-time pin check; the receipt does not assert that this file stayed unchanged through completion.
