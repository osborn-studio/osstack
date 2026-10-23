# G22–G24 follow-up adversarial review

**Verdict: PASS. Findings 1–4 are fixed in the reviewed current source. No new concrete blocker found in scope.**

Reviewer: the actual OSStack Loop Codex reviewer, not Claude. Read-only follow-up on 2026-09-15, HEAD `a37b0065ea097d272c099f840617b3e6ceaba2b4` plus current working tree. I re-read the original four findings, fixes-interface.md, and the latest parent-feedback.md. No tests, builds, agents, commits, or repository edits were performed. This report is the only requested output write.

## Disposition and codepaths

1. **FIXED — current registered-source policy remains authoritative after cloning.** `graph-rpc.ts:197–199` forwards the host policy callback; `graph-delivery.ts:88–89` binds policyRoot to the trusted repositoryPath, separately from the physical workspace. `daemon.ts:3847–3855` requires source policy and then applies a distinct physical-checkout policy as an additional restriction. Missing clone policy does not replace current untracked/newer source policy. Broker admission checks it at `graph-action-broker.ts:318–319`, with fresh invocation checks after workspace validation and awaited availability at `:474–480`. The reviewer wrapper additionally rechecks after its independent validation (`graph-verification.ts:276–289`). The three policy regressions in graph-review-findings.test.ts cover source revocation after workspace creation while availability waits, untracked policy, and source policy newer than baseRevision.

2. **FIXED — shutdown waits for actual database users.** `graph-runtime.ts:109–111,139–140` tracks action/dispatch AND checkpoint promises. Action tracking includes awaited broker persistence and admission-release finally. Runtime retirement blocks new authorized work; `:175–181` supplies the post-close database barrier separately from bounded stop observations. GraphDelivery delegates at `graph-delivery.ts:94`. `graph-rpc.ts:225–249` memoizes close and, even if cancellation fails, waits for entry.done and then the driver drain through nested finally blocks. The former 15-second fake completion is gone. `daemon.ts:4100–4104` waits for the public service and also closes/drains the experimental runtime before SQLite close at `:4131`. The shutdown test holds real driver prelaunch mkdir past the former deadline. The new graph-chain.integration.test.ts lifetime test at line 254 holds host work with a later SQLite read after bounded stop, verifying that the database barrier stays pending. Genuinely stuck local I/O may intentionally keep graceful shutdown pending. Waiting is not physical-stop evidence: unknown effects and their durable holds are preserved.

3. **FIXED — independently proven stopped review/tests cancellation settles under cancel authority.** `graph-rpc.ts:199` supplies cancel authority; `graph-delivery.ts:113–117,169–175` binds cancellation settlement to current ownership/cancel-pending state and passes it into verification. `graph-verification.ts:228–266` requires stopped evidence, exact effect identity, and reviewer identity, and persists nonretryable cancellation failure without a passing report. The real host-config identity verifier now checks read authority (`graph-rpc.ts:278–289`), while preparation/invocation still require execute authority. `graph-action-broker.ts:512–525` awaits commandPending for shell stop confirmation, fixing the command-assignment race. Its settlement accepts stopped nonretryable aborted verification failure with no result (`:356–380`); unproven stop remains unknown with retained admission (`:382–390`). Actual cancelled verification does not become passing quality. Already-completed quality is intentionally preserved when worker shutdown aborts the signal only afterward. The review/tests/unknown regressions inspect durable failed evidence, absent report/join, cancelled versus cancel_pending run status, and admission release only for proven stop. The host-config test separately exercises the production identity verifier after execute expiry with read/cancel retained.

4. **FIXED — unusable mutation acknowledgement remains delivery_unknown.** `graph-execution-command.ts:63–68,96–120` retains the sent mutation and converts absent, malformed, or mismatched success acknowledgement into exit 2/delivery_unknown with the exact original scope, idempotency key, digest, and retry_same_request; cancel/resume retain graphRunId. Definite server rejection remains separate. The new acknowledgement regression at graph-execution-command.test.ts:76 covers null, invalid result, and mismatched input digest; existing tests cover transport ambiguity, explicit rejection, and pre-send validation.

## Existing verification evidence and remaining scope

I inspected existing actor/parent logs; I did not execute these checks:

- fix-red.txt records 5 failed / 1 passed; fix-green2.txt records all 6 findings regressions passing.
- fix-focused-final2.txt completed during this review with 6 files / 98 tests passed, superseding the earlier focused 97/98 result. fix-g21-retry2.txt also records the isolated preparation-admission regression passing.
- fix-parent-tests.txt records 11 passing tests: shutdown 1, CLI mutation contract 7, host config 3. The older parent-focused-final.txt had only 6 CLI tests and is not evidence for the new acknowledgement test.
- Parent feedback reports selected shutdown/graph-chain lifetime checks and typechecking passing. I inspected the new lifetime test source; this is not an independent execution claim or a whole-suite pass.

**Full acceptance1 is invalid as final evidence:** it mixed cached old runtime code with new tests while fixes were being written. This PASS closes the scoped source findings, not final full acceptance. Parent must run full final2 after source freeze with coherent rebuilt dependencies, including GraphRpcService/CLI typechecking against the final protocol.

Latest parent protocol change was inspected at graph.ts:400–415: ready requires available delivery plus candidate/result/evidence, and uncertain statuses require delivery_unknown. Generated-schema equivalence and final build/test results remain parent final2 validation. During final hash verification, graph-rpc.ts changed from a combined return/assignment to separate memoized assignment and return in close(); I re-read that codepath and the latest source before recording the new hash. The lifetime semantics are unchanged.

Re-review is needed if final2 causes changes to policy binding/invocation, cancellation classification/authority, pending-promise retirement/drain, acknowledgement handling, or their protocol contracts. A validation-only rerun against the same reviewed source does not reopen the four findings. G25 full crash-matrix coverage is outside scope; no general architecture changes are requested.

## Source snapshot

SHA-256 at report creation. Principal implementation/test hashes were rechecked against the last inspection before writing. Supporting hashes identify relevant dependency context, not a whole-repository audit.

| File | SHA-256 |
| --- | --- |
| `packages/cli/src/graph-rpc.ts` | `ea1ead2f0e15bc9d205e638b65eeddf3d2dd89c729e3ad7f238679b59fce40a3` |
| `packages/cli/src/graph-delivery.ts` | `db2c7f2ebeb53ae19d6883709179de52cebf4ef24bf7a9fc15ca1286d554ad41` |
| `packages/cli/src/daemon.ts` | `7b7adbf59a20cb4aae3065593fa0147ee659df9d4a3b7c469d4ba2a092313fc4` |
| `packages/cli/src/graph-runtime.ts` | `2ee52f35705dc5187de3c40c37e44f77da59f4df811001627fd158bd24f099d5` |
| `packages/cli/src/graph-action-broker.ts` | `5755b3aef639e51bc8c47e80e4786828dfa8e2b1adc1d24f4edb7d508b00b72b` |
| `packages/cli/src/graph-verification.ts` | `002e624df0647cacb165703a3f8ca738f7e55a26573023e850f7e2c7a8dae71b` |
| `packages/cli/src/graph-execution-command.ts` | `9f562471a12d155b40dabcdfced8cc709a104c815a1e1d7ee31f9ab8b1c80841` |
| `packages/cli/src/graph-review-findings.test.ts` | `dd5b9a42948b2141d413f6bcfd94bc62283d14c26522a85f39d8f443e5b7b788` |
| `packages/cli/src/graph-shutdown.test.ts` | `0408625b3f4474811ec799c2681b490d08663ac7fac245004bac21de59d6fd32` |
| `packages/cli/src/graph-chain.integration.test.ts` | `88f970c746f0ed381c5a251b9acc7d076f31256d6b46761b963d6b6ca1c5a99c` |
| `packages/cli/src/graph-execution-command.test.ts` | `1d9044155d030ef60af77a6c740d0aabcfe706022398b6fd82f01797ff5fbdea` |
| `packages/cli/src/graph-host-config.test.ts` | `f921939b82643d2dc69266f7de9b04c44948ec67dcbf0d492b84c3dadfff5156` |
| `packages/cli/src/repository-policy.ts` | `4c39f971ab4ea27cc0bb715a63dd99295da542b7d29523bca7763f20c7e6c33a` |
| `packages/cli/src/graph-worker-manager.ts` | `577bea184d0ece264681cf44a985dd6f9bd9a2ed0b71d5e016d339954fd78a69` |
| `packages/cli/src/graph-checkpoint-service.ts` | `78a363171ac72475c7c09ec3125afd7a5a582f3db739a64087f505791312e46c` |
| `packages/core/src/state/graph-runs.ts` | `74cecc8aeeec533b65e9d98b9664ab0f0f8b3f5fcb47b4711816b9b41663b5d4` |
| `packages/protocol/src/graph.ts` | `c1972aa796cbbe2949ed112ea67bf21426b05aa9e069969014df178f76e5e112` |
