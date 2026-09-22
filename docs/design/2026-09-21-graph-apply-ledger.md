# Experimental Graph apply authority and conservative recovery — P04b

Baseline: 1b6c0f4. Migration39 adds apply intent/resolution tables; migration38 and historical compiler v4 are unchanged. This batch is the control-plane storage lifecycle, not a registered executor or filesystem applier. P05 provider and P06 physical apply remain absent. No paid requests or production DB access.

## Authority and lifecycle

GraphActionStore remains the only effect, attempt and budget authority. `beginApply` binds the previously committed invocation request and proposal response to an immutable apply intent: request/proposal/manifest digests, before-tree, expected target-tree, journal ref/digest. Run/effect scope, original action generation, current epoch, original deadline, run stopping/uncertainty, budget blocks and held host admission are checked in one BEGIN IMMEDIATE transaction. Generation is stored from the host run, never rewritten by recovery.

Only the first insertion returns **applyAuthorized=true**. That flag grants one opportunity to perform the already-authorized physical apply; `changed` is revision bookkeeping and must not be used as the apply token. Replay, lost ACK and missing receipt grant no new writes. A journal must already be durable before this call, and the host must verify grant, paths, preimages, modes/links and physical write lease. SQLite cannot perform these checks and hashes are not authorization. The token is a serialization decision, not a filesystem sandbox or cryptographic capability.

| Stored evidence | Action / accounting | Permitted next action |
| --- | --- | --- |
| No apply intent | Existing invocation state | Host may independently validate/prestage and call beginApply |
| Intent, no resolution | running; original reservation retained | Only the original gate winner may finish; restart cannot repeat writes |
| applied resolution | confirmed implementation_complete, existing accounting settled atomically | Host cleanup, proof-checked release-only recovery; never reapply |
| quarantined resolution | unknown or cancel_pending; reservation and observed maximum retained | Stopped-proof physical cleanup/inspection only; no retry, freeze, join, or terminal success |

Both tables are append-only with PK, FK, bounded JSON and UPDATE/DELETE/duplicate-INSERT guards, including INSERT OR REPLACE. A single resolution table makes applied and quarantined mutually exclusive. `getApply` is a fenced evidence read, including historical-generation inspection; never permission to apply.

## Completion and isolation

`completeApply` accepts only a trusted host's verified final tree, journal/proposal binding, evidenceRef and actual token usage. It derives workspace/result fields from the original action, validates GraphResult, and writes applied resolution plus confirmed action in the SAME transaction through the existing accounting helper. Reported usage is never allowed to hide previously observed usage. Null usage retains reservation and blocks further action; over-cap usage is charged and blocks further action. Exact completion replay changes nothing. Original deadline expiry alone does not erase an already performed effect, but the fence and current ownership must remain valid.

Receipt self-consistency is not physical integrity: a host could report the expected tree over a partially changed workspace. Only P06's verifier can establish actual contents, including untracked/ignored changes. Core does not open or authenticate journal files, provider proofs or stop references. The host retains the same physical write lease from request through apply receipt. Model completion and SQLite completion do not themselves release physical ownership.

Any pending/quarantined apply blocks **new** action admission and startup for the entire run, including slots reserved before apply. Existing running-slot replay remains informational. Generic recordOutcome/recordUnstartedOutcome may not settle an effect with an apply intent; generic markUncertain must route through quarantineApply. This prevents a non-retryable failed outcome from hiding partial writes. Existing verification join, epoch advance and terminal projection gates reject running/unknown/cancel_pending actions and unreleased admissions; their historical snapshot formats stay unchanged. All apply-resolution writes advance run revision atomically with the action, so prior snapshots become stale.

`quarantineApply` writes immutable quarantine evidence plus unknown/cancel_pending action together. Cancellation and observed usage are sticky. It never rolls forward/back or releases budget. A live host can still record quarantine after accidental admission release; this only tightens isolation and cannot grant writes.

## Crash recovery and resource release

Normal live-fence calls cannot settle historical generation effects. Existing admin GraphRecoveryStore uses an exact snapshot and trusted synchronous stopped-worker/executor/workspace verifier, also after lease expiry. Recovery distinctions:

1. **Unresolved apply**: an `unknown` verdict atomically creates quarantine resolution if missing and records uncertainty/recovery decision. Intent generation, before/target tree and journal remain untouched. An applied/not_applied verdict cannot turn this into success, failure or retry.
2. **Already committed apply**: `applied` recovery is permitted ONLY when action is already confirmed and an immutable applied resolution exists. Existing canonical outcome comparison must equal the original settlement; changed tokens, result or evidence are rejected. This creates a recovery decision for existing verifyRelease/completeRelease cleanup; it never re-applies or charges again.
3. **Quarantined apply**: after a persisted unknown recovery decision, verifyQuarantineRelease checks the fresh snapshot, exact effect, quarantined resolution and trusted proof. Host then stops/cleans up physical resources; completeQuarantineRelease rechecks proof and records admission release. Lost release ACK is replayable. State stays unknown/cancel_pending and the token reservation remains. New ownership may inspect historical evidence but cannot rerun, settle or seal it.

GraphAdmissionStore is daemon-internal bookkeeping for actual resources, not a proof authority or worker API. Future activated host wiring must use these recovery paths and call completion only after its physical release callback succeeds. Quarantine releases resources without claiming a final business outcome; explicit abandonment/write-off or verified rollback is still future work. A run may remain logically unresolved without permanently holding execution resources. Physical host quarantine must also prevent reuse of that workspace by other runs; the SQL blocker is run-scoped and does not authenticate path aliases or cross-run workspace ownership. The future host recovery verifier must explicitly recognize the new profile and its actual executor evidence, rather than reuse a v4 verifier without adaptation.

Do not edit an old proposal's generation or recompute its hash to fit a new worker. A later roll-forward/rollback design needs its own versioned physical verification proof; there is no such automatic path in this batch.

## Failure windows and activation gates

Independent Node processes exercise SIGKILL before gate, inside gate transaction, after gate before writes, after first of three physical test-file operations, after all operations before receipt, inside completion transaction, and after receipt before ACK. Restart twice must never repeat physical mutations after a committed gate. A full filesystem result without a committed receipt is still quarantined. The fixture writes real temporary files, but is not the production applier and does not demonstrate path/symlink security or actual Git-tree verification.

SQLite WAL synchronous=NORMAL remains unchanged. Process-death tests are not power-loss tests; provider activation still requires an explicit durability policy and validation. No registry, broker provider registration, compiler version or CLI entrypoint activates these experimental APIs.

Next: P05 exact one-shot bounded provider request with no automatic retry; P06 actual journal, preimage/path/inode checks, staged files, full-tree verification and same-lease apply; then cumulative review and new compiler/profile enrollment with real create/replace/delete end-to-end. Preserve historical schema parsers and v4 recovery. Do not report the overall multifile feature complete before these gates pass.
