# G21 actor handoff

Implementation work complete for parent architecture/Claude review and whole acceptance. No docs edited, commits, push, merge, or agents spawned. All execution commands used explicit OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/g21/actor-home and TMPDIR=/Volumes/AIMATE_WORK/tmp/g21. No whole-suite acceptance run.

## Production architecture

- Compiler `code-delivery-functional-v4` emits real Functional tasks across fixed epochs, with two explicit independent preparation nodes per epoch. Branch tasks throw for non-confirmed outcomes; all branch promises drain before throwing. Quality handoff is a real Functional interrupt, not a synthetic effect or worker verdict.
- `deliveryEpoch()` derives slots, preparation retry slots, token caps, and nextCost from the compiled plan/fixed registry. Worst-case epoch reserve remains 3+4*maxBranchAttempts starts; repair nextCost conservatively reserves the entire next compiled epoch including possible retries. A single branch retry costs preparation+invocation, with exact registry token cap.
- `GraphDelivery` selects trusted writer/reviewer adapters, acceptance commands and physical repositories. Writer clones use independent object storage and disabled Git global/system configuration. Preparation effects use broker ledger admission and the same source G10 lease; per-kind preparation API prevents hidden pair restores or nested admission deadlock.
- Broker `installActions` is host-only append-only installation on the live connection. Retry replacement requires exact immutable action payload/cap, safe failed prior action, released admission, and `retryAuthorized` allocating the next actual ledger attempt. New physical workspace/evidence stays bound to that attempt; old receipts are preserved.
- Migration 32 adds immutable `graph_delivery_epochs` permits. Epoch 0 requires pristine action history; future epochs require an immutable complete negative join, latest confirmed branch identities, no unresolved effects/held admission, live original run budget. Broker AND action store fail closed if compiler v4 lacks a permit and reject old epochs. No new node FSM.
- Host joins use current ledger/evidence, not Functional RETURNs. Failed verification branches remain blocked and unpublished, preserving candidate-key journal immutability across retries. Complete join reference contains both branch feedback and frozen candidate binding and is passed into repair.
- At quality handoff, actual child is stopped/drained; host verifies immutable join, then executes existing G15 takeover and resumes actual Functional interrupt. Host generation/owner is pinned from its own claim and changes only from its own successful G15 result. Fresh tokens do not bypass retirement/epoch fencing. Terminal publication uses the exact decision snapshot revision.
- Active worker uses existing `leaseDurationMs:60000` renewals; join runs after worker stop, so it does not race the heartbeat. Original createdAt/spec/deadline remain unchanged.
- Parent-provided `graph-delivery-receipts.ts` integrated for content-addressed, fsynced exact effect/generation/owner/workspace receipts. Freeze verifies historical writer stop receipt. Cached writer workspace mappings reconstruct from these receipts on each resumed generation.
- Unknown physical effects retain ledger/admissions, never resend or clean directories, and return reconcile with durable reconciliation_required when this host remains authorized. Revoked/foreign owner cannot project run state. Stop/ready seal graph run only; no task FSM completion, merge, push or deploy.

## Focused verification

- Final actual delivery integration: **6/6 passed**, 43.46s, `/Volumes/AIMATE_WORK/tmp/g21/delivery-final.log`. Direct success in both explicitly enforced and asserted ledger completion orders; repair success through actual child stop/G15 generation 2; malformed reviewer retry success with fresh physical workspace; bounded malformed failure; negative quality epoch-cap stop. Tests assert original source/spec/createdAt, exact preparation counts/caps, no failed task RETURN, immutable join counts/epoch refs, and worker launch generations.
- Graph compiler/template tests: **51/51 passed** (44 compiler +7 template cost/slot bounds).
- Focused core ledger/verification/epoch: **44/44 passed** (31 action +5 verification +8 parent epoch boundary).
- Existing G19/C6 regressions: **29/29 graph-verification** and **21/21 graph-verification-join**. Combined focused CLI run including parent broker5/adversarial4 at that time: **59/59 passed**, 192.39s.
- Parent extended adversarial: **6/6 passed**, including unknown writer/reviewer, token overrun, mutable caller options, foreign owner and revoked authority. Parent broker tests **5/5 passed** in regression run. Parent owns its receipt tests and further adversarial updates.
- Graph/core builds completed; graph/core/CLI typechecks passed during work. Final CLI typecheck rerun after optional workspacePath type correction. Biome changed owned source: 13 files checked, zero diagnostics; final one-line test type correction checked separately.

## Actual OSStack Loop

LoopEngine sources:[], explicit fresh inputTasks, skipCompletedTasks:false. State outside repository:
- `/Volumes/AIMATE_WORK/tmp/g21/actor-loop-state.json`
- `/Volumes/AIMATE_WORK/tmp/g21/actor-loop-state.md`
- `/Volumes/AIMATE_WORK/tmp/g21/actor-loop-result-r3.log`: executedTaskCount=1, task G21-actor-focused-20260915-r3, outcome success, all required verifiers pass.
- `/Volumes/AIMATE_WORK/tmp/g21/actor-loop-result-r4.log`: executedTaskCount=1, task G21-actor-focused-20260915-r4, outcome success, all required verifiers pass.
- Loop runner: `/Volumes/AIMATE_WORK/tmp/g21/loop-targeted.mjs`.

Earlier Loop r1/r2 correctly escalated after the receipt retry-slot lookup bug; fixed using explicit (nodeId,effectSlot), not arbitrary row ordering. Successful r3/r4 followed. Last active-lease option and stronger completion assertions were validated by the final direct focused integration; parent owns final Loop whole acceptance.

## Scope and handoff limits

No public CLI/RPC admission/resume/cancel API (G22/G23) or generalized daemon crash resume (G25) added. G21 exercises planned child stop/G15 resume in the same trusted host coordinator; old cached workspace mappings load from durable receipts. Full failure matrix, long artifact-I/O/renewal performance probes, schema freshness and full repository acceptance remain parent-owned. No remaining known focused-test failures at handoff.
