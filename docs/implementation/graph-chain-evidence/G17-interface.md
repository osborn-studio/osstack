# G17 concrete assembly interface (before implementation)

Owned: daemon.ts narrow lazy/shutdown wiring; new graph-runtime.ts; graph-chain.integration.test.ts; dedicated scripts/fixtures/graph-chain-* files. No graph CLI/RPC or default graph instantiation.

`GraphRuntime({db,broker,checkpoints,programs,workerOptions?,drainTimeoutMs?})` owns GraphRunStore + concrete GraphReconciler + GraphWorkerManager on the daemon DB. `prepare(request,version):GraphRun`; `claim(run,owner,leaseExpiresAt):GraphRun` only generation zero. `start({request,run,programId,registration,authorize,leaseDurationMs?}):GraphRuntimeHandle` uses a fixed registration/full binding and a synchronous host authorize returning undefined. New generations beyond initial claim require the durable G15 takeover journal before launch. No automatic takeover/retry or budget reset.

`GraphRuntimeHandle` includes underlying G14 connection/binding/ready/result/exit/logs plus `stop(reason?):Promise<{worker:GraphWorkerExitEvidence,actionsSettled:boolean}>`. Runtime `stop(connection,reason?)`, `close()`, and `observedExit(connection)` expose actual manager OS receipts. `actionsSettled` only means actual broker promises drained; it NEVER proves external effects stopped. Host must independently verify G04 receipts and retained workspaces through concrete `runtime.reconciler.register/reconcile`.

Supervisor checks live scope, complete program identity, generation, owner, cancellation/terminal state, expiry and synchronous host revocation every call. Optional renewal uses one synchronous read+renew and stops before recovery; no async revision races. Each connection tracks real broker Promises. Stop retires both ports, aborts worker/broker and boundedly waits for exit and drain; disconnected ports retire. No whole-run admission.

`handles.graphRuntime({programs,workerOptions?,drainTimeoutMs?})` explicitly creates a runtime, sharing the same daemon broker/checkpoint service. Multiple explicit runtimes are tracked for shutdown; closing refuses new assembly and stops runtimes before DB close. No heavyweight graph SDK import in daemon process. Existing checkpoint bindings remain supported.

Tests use only trusted fixture wrappers around actual broker/checkpoint methods for deterministic persistence holds; no public fault knobs, MemorySaver or fake broker/backend. Parent remains owner of package exports/migrations/broker/checkpoints/G15/G16/execution code.

## Final amendments
- Daemon configuration is **single-use per daemon**. A second `handles.graphRuntime(configuration)` rejects `GRAPH_RUNTIME_ALREADY_CONFIGURED`; the host retains its first returned runtime. This avoids multiple independent supervisors over the same daemon.
- Parent migration29 `graph_worker_launches` is required. Manager's synchronous register callback consumes one launch per (run,generation) under BEGIN IMMEDIATE after program/input validation and a fresh synchronous full authorization check. Failed registration/spawn never releases that durable consumption. A fresh manager cannot relaunch a consumed generation. New generations require G15 takeover journal.
- Supervisor enforces original `createdAt + spec.limits.deadlineSeconds`, including while an actual broker action is in flight. Optional live renewal never extends the original deadline and performs synchronous fresh read+CAS without yielding; launch transaction disables nested renewal.
- `GraphRuntimeHandle` also exposes new G14 `finalExit`: actual exited or authenticated spawn_failed evidence, including a late event after bounded `exit` resolved unconfirmed. Runtime subscribes finalExit so `observedExit` advances to actual OS evidence, while prior stop/exit results remain immutable.
- `spawn_failed.phase='registration'` (including duplicate launch) is NOT proof no prior worker exists. Only parent G14 post-registration phase='spawn' evidence can support distinct G15 not_started proof; runtime does not manufacture it or auto-recover.
