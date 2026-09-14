# C2 executor experiment — public recovery alternatives

2026-09-13, Node 26.5.0. **Experimental assertions pass; `admitted: false`.** No M1 implementation or task status change. The executor changed only the new C2 probe, its fixture modules/tests, and this report. The supervisor's concurrent worker-entry/test changes are outside executor ownership. Existing G07 probe, manifests/pins, production source and node_modules were not edited by this executor; no control-plane DB, commit, push, merge, nested agent or loop was used.

The best distinct public candidate is the documented **Functional API (`entrypoint` + `task`)**, with stable task invocation order, task result persistence, and a trusted external effect store. It passes the tested recovery cuts while the unchanged StateGraph AND-join control still fails. This is a different execution model; the Functional join is a real task after `Promise.all`, not proof that StateGraph's native AND barrier has been fixed. A narrower public StateGraph repair also works after an ordinary resume has reached the stalled join.

## Reproduce and evidence

```sh
node --test scripts/fixtures/graph-c2-ledger.test.mjs scripts/fixtures/graph-c2-journal.test.mjs
node scripts/probe-graph-c2.mjs
# Intentional RED, exit 1: require the known failing control to recover its AND join.
node scripts/probe-graph-c2.mjs --red-control
```

The probe allocates a fresh retained evidence directory by default. Set `GRAPH_C2_EVIDENCE` to select one explicitly. This investigation used `/var/folders/97/wmwg4qzx02j74c3n73nh438w0000gn/T/osstack-graph-c2-ijsk2plt/evidence`.

Final matrix: **42 subprocess scenarios, 96 child processes, 26 actual SIGKILLs, 56 grouped assertions; all owned working fixtures cleaned.** Seven behavioral helper tests pass. Pins are asserted: LangGraph 1.4.15, checkpoint 1.1.5, core 1.2.11. Existing G07 regression also passes, retaining `productionReady: false`. **Sync is the candidate durability mode.** Async rows are supplemental observations using this synchronous-file journal, not proof of delayed production RPC/flush durability. Executor validation is on Node 26.5.0; other-runtime admission belongs to the supervisor.

Evidence files:

- `summary.json`: concise machine result, including `passed`, `admitted`, process/signal counts and cleanup.
- `experiments.json`: complete options/control observations and process reports.
- `<scenario>-<phase>-cut.json`: counts, external ledger, observed task RETURNs from public history, and public checkpoint tuple immediately after that child exits, before another process changes them.
- `<scenario>-journal.wire.json`: decoded whole public-call journal, including original ERROR writes. Other `*-wire.json` files archive effects, counts, pre-resume tuple, program identity and kill marker.
- `ledger-red.log`, `journal-red.log`, `journal-validation-red.log`, `run-gate-red.log`: helper TDD failures before implementation/fixes; `helpers-final.log` is GREEN.
- `baseline-red.log` and `red-control/`: genuine failure of the desired join=1 assertion on unmodified MemorySaver; exit 1.
- `initial-options.json`, `state-replay-experiments.json`, `functional-first.jsonl` and matching initial source snapshots: exploratory observations, not final acceptance runs.
- `matrix-attempt-*.log`: intermediate failures/successes. Attempt 1 had an incorrect concurrency=1 initial-output expectation. Attempt 4 exposed overlap between return persistence and downstream join execution. Its original working fixture was not archived before cleanup; the final ungated second-kill scenarios reproduce that cut with full snapshots. `matrix-run-gate-red.log` records the expected-error assertion changing when both parallel tasks reject with an AggregateError; the final assertion checks every constituent reconciliation reason. `matrix-final.log` is the final run.
- `g07-regression.json`: unchanged eight-process G07 control. Syntax checks and `git diff --check` pass. Repository Biome ignores these `.mjs` paths (`biome.log`: no files processed), so no Biome pass is claimed.

## Results

| Experiment | Verified result / limit |
|---|---|
| Unmodified MemorySaver, StateGraph concat reducer, native AND edge, immediate sibling error; sync/async/exit, concurrency 2 | Output plus ERROR for completed task; no notification in that task's writes. Null resume produces completed+recovered, completed body=1, join=0. All three durability modes retain the defect. |
| Same control, concurrency 1 | First invoke returns empty results with completed output pending; flaky has not run. Later null invocation completes the graph. Serial configuration does not demonstrate recovery from the injected failure because the first call never reaches it. |
| Direct `updateState(trustedResult, "completed")`, latest or explicit checkpoint identity | Join stays 0 and unfinished flaky no longer runs. Latest appends duplicate completed reducer output. Exact selection avoids that duplicate but still loses required progress. |
| `bulkUpdateState`, one trusted completed update at exact identity | Same missing-progress result. Installed declaration marks this method `@internal`; it is an experiment, not a stable supported recovery contract. |
| Null resume to stalled StateGraph, then `updateState({}, "completed")` | Actual native AND join runs once with complete, nonduplicated results; completed body does not rerun. Independent fixture ledger confirms the result, and existing public state is checked for exactly one matching result before the empty writer update. Original ERROR history is retained. |
| StateGraph repair, crash before repair checkpoint write / after repair checkpoint acknowledgment, sync and async | Four processes per case: partial failure, ordinary stalled resume, SIGKILL during repair, repair recovery. Before-put recovery repeats the public writer update; after-put recovery resumes the already-scheduled join. Native join=1 and complete results. Bounded single-writer fixture only, not concurrent/atomic repair admission. |
| Functional immediate exception / error after completed RETURN, sync and async | New-process recovery returns all three results, completed wrapper=1, join wrapper=1, one confirmed effect each. A repeat null resume does no more work. |
| Completed effect confirmed but task RETURN absent: kill in body / before saver receives RETURN | Wrapper re-enters to consult external confirmed ledger; completed effect body stays 1. This is **effect deduplication**, not literal task-body exactly-once. |
| Completed RETURN durable, join RETURN durable, before final checkpoint, after final checkpoint acknowledgment | Real SIGKILL followed by fresh-process recovery. Full result; cached completed wrapper remains 1; logical join effect=1. Completed graph null resume is a no-op. |
| Join effect confirmed before join RETURN | Join wrapper=2, logical confirmed join effect=1, full result. External ledger prevents repeating the already-confirmed effect. |
| Recovery-time second SIGKILL, gated | Initial sibling error; second process dies after recovered RETURN is saved; third completes. A test gate pins the cut before the join body. Completed wrapper=1 and join wrapper/effect=1. |
| Recovery-time second SIGKILL, ungated | Per-cut public tuple proves no joined RETURN, while ledger/counts prove joined effect already confirmed. Third process re-enters join wrapper (total 2), external joined effect stays 1. Do not equate afterWrites observation with absence of downstream execution. |
| External cooperative cancellation | Invoke rejects; fixture task explicitly observes its controller; child is drained/exited before recovery. New process completes, cached completed wrapper=1. This is application cooperation, not engine cancellation proof. |
| Task timeout and uncooperative cancellation | Negative controls: invoke rejects **before** the released user body records its effect. Test releases/drains that finite body before child exit. Recovery avoids repeating confirmed effects; rejection itself is not worker-exit evidence. |
| Cancellation followed by parent-issued SIGKILL | Child reports rejection while an uncooperative task awaits a delayed effect. Parent sends SIGKILL, waits for close, verifies no late-effect marker or recovered effect, then starts recovery. Two such parent-issued kills; remaining kills are real self-directed SIGKILLs at fixture boundaries. No thrown exception is counted as SIGKILL. |
| Effect begun, process killed before confirmation | External ledger remains started/unknown; wrapper refuses to repeat the effect, and the fixture broker blocks the sibling from starting a new effect. recoveredBody=0 and joinedBody=0. Explicit `blockedUnknown: true`, `reconciled: false`; this is not called a recovered graph. |
| Functional interrupt/resume across processes | Both branch tasks return, entrypoint interrupts, new process resumes matching interrupt ID with `false`; approval remains false, both branch wrappers stay 1, join runs once. |

## Public interface and trust boundaries

Read-only installed declarations/source were used to establish the exact pinned signatures. Live official [time-travel documentation](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel) describes node-attributed writer updates and forks; the installed signature is `updateState(config, values, asNodeString)`. The [Functional API documentation](https://docs.langchain.com/oss/javascript/langgraph/functional-api) describes task result reuse and null resume after failure. Public Pregel construction/custom channels were not needed; no private imports, patching, channel synthesis, write deletion or ERROR filtering was used.

`JournalSaver` extends public BaseCheckpointSaver and rehydrates **default unmodified MemorySaver through a validated allowlist of public put/putWrites/deleteThread calls**. It never reads MemorySaver storage fields. All persisted requests, getTuple responses and list results round-trip through the existing CheckpointCodec; absent getTuple stays undefined. The full record list is fsynced and renamed before returning; a failed persist is not retained in its in-memory record list. Method/argument rejection and failed-append non-resurrection have RED/GREEN tests. This journal is a small, bounded, single-writer fixture, not a DB adapter or evidence that MemorySaver survives restart by itself. No power-loss or multi-writer guarantees are claimed.

`effects.wire` is a separate **test-only deterministic effect store**, never derived from checkpoint receipts. A recorded started/unknown effect blocks replay and blocks new effects elsewhere in the fixture run; confirmed-result reads remain allowed. An earlier fixture only blocked the repeated effect (`unknown-before-run-gate.json`); the added run-gate RED/GREEN test and final matrix close that fixture gap. A confirmed row must match fixture run, effect and attempt. `completedWrapper`/`joinWrapper` count task-body entries including ledger lookup; `completedBody`/`joinedBody` count actual fixture effect execution. These counters deliberately distinguish cached task RETURN, wrapper re-entry and logical confirmed effects.

Every subprocess has an 8-second runtime timeout and bounded output. Owner token, parent PID, canonical path and non-symlink checks guard cleanup; cleanup occurs after child exit/close. Each normal run creates new working fixtures. Program identity checks bind this fixture's API, exact pins, compiler/schema label, fixed ordered task schedule and spec digest across processes. This is local test consistency, **not authentication or production identity enforcement**.

## Integration conditions, not implemented here

Supervisor notes were read before conclusion. Functional task replay is a viable public candidate for the restricted static graph, but admission remains explicitly false in the probe. A future integration must persist immutable execution-model, registry/compiler/template/schema versions and ordered schedule identity before resume; authenticate/fence workers; bind outputs to a trusted authoritative effect store; reconcile unknown effects; and confirm worker exit before lease transfer or cancellation completion while the broker blocks new actions. Fixed-checkpoint StateGraph repair additionally needs an atomic recovery pointer and concurrency/fencing design. Production G13 must await durable daemon acknowledgment; G14 must enforce the admitted durability mode; G15 preflight and broker must own run-level unknown gating. This experiment implements none of those M1 obligations and changes no task count.
