# G12 action broker handoff — implementation complete, parent acceptance pending

Owned source edits only:
- packages/cli/src/graph-action-broker.ts
- packages/cli/src/graph-action-broker.test.ts (31 tests)
- packages/cli/src/daemon-graph-action-broker.test.ts (1 in-process registration/shared admission integration test)
- packages/cli/src/daemon.ts: type-only broker import, DaemonHandles.graphActionBroker(), closure-cached lazy broker construction over ctx.db/admissionFor(ctx)/strict repository policy gate. Parent concurrently added checkpoint assembly; preserved.

No core/protocol/G13 files, AGENTS, status/docs, commits/pushes or nested actors/Loop were modified or invoked. Parent owns graph-action-broker-boundary.test.ts and checkpoint code.

## Interface

Host: const broker = await handles.graphActionBroker(); broker.register(connectionObject, registration); await broker.handle(connectionObject, workerRequest, {signal});

register is synchronous and rejects reusing a connection object. It copies/freezes scope/run/full program identity/generation/owner/epoch/workspace and exact compiled node/effectSlot/action input. Captures trusted authorize/persist/handler/adapter method references. Request parsed/copied/frozen before first await; worker principal/grant/receipt/checkpoint/commandSpec cannot authorize. Missing slots, altered input, wrong scope/run/epoch/generation/full identity, unknown/ambiguous capability and freeze fail closed. Host authorize must synchronously throw on revocation; runtime rejects and observes accidentally Promise-returning callbacks.

Execution registrations: adapter+exact capability+ExecutionPlan; exact command+ExecutionPlan; workspace-specific trusted handler. Single G04 executeCandidateImplementation invocation wraps the adapter or registered shell command (existing runShellCommand). Policy is awaited again after G04 availability/import and immediately followed by synchronous original-binding authorization/fence/ledger markRunning then actual effect. Commands avoid G04's asynchronous feedback-file gap by using its wrapped adapter route. Workspace handler gets only frozen registered workspace and real signal. Adapter capabilities determine read/write; any supported writer capability requires write admission, unknown capability denied, selected exact capability is the only capability passed to G04.

Broker owns PER-ACTION admission, using existing shared GovernedExecution via daemon admissionFor(ctx). Do not wrap broker.handle in acquireGraphAdmission or a whole-run lease. No new semaphore, run scheduler, worker transport, checkpoint code or G14/G17 chain.

## G11 integration / failure semantics

Read G11-handoff.md and actual store source. Uses GraphActionStore.reserve/markRunning/recordOutcome/markUncertain; GraphAction type and real core SQLite. Every store call receives current revision with original registered generation/owner/full identity; no await between revision read and store's BEGIN IMMEDIATE validation/write. Concurrent external revision races reject via CAS, never adopt a new owner/generation. Confirmed replay fences before lookup; new generation preserves effect identity. Only reserve.created caller invokes. Existing intent/running/unknown returns nonretryable unknown; never calls retry. Admission errors before invocation resolve own intent as failed(actualTokens=0,retrySafe=false) where still fenced; no false unknown or physical lease retention. G11 conservatively charges failed reservations. If stale fencing prevents cleanup, old intent remains for trusted reconciliation.

Postinvoke throw, malformed result/receipt/usage, missing/late/unconfirmed stop, or ledger commit failure retains actual admission and conservatively marks unknown. If recording unknown also fails, durable running reservation remains and response is unknown; no re-invocation. Terminal failed alone is not no-effect evidence. Explicit trusted stopped failure can settle failed but always retrySafe=false. Success also requires trusted confirmStopped (bounded one-second wait) or command process-group stop evidence. Real cancellation reaches the actual adapter signal. Persistence mapper alone creates evidence/output references; result kind/workspace/revision validated and candidate_ready never fabricated. G16 freeze/publication remains unsupported.

Raw usage events are validated (including earlier values G04 would overwrite). Confirmed charge uses max(observed usage, mapper report, G04 final usage); unreported usage uses reservation. Unknown retains max(reservation, observed usage). Overrun is preserved and core accounting blocks new actions. Invalid usage follows requested G12 unknown/retained semantics.

## Validation

Every command used OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc4/home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc4.

PASS: pnpm --filter @osstack/cli exec vitest run src/graph-action-broker.test.ts src/graph-action-broker-boundary.test.ts src/governed-execution.test.ts
- 39 tests / 3 files: 31 own broker + 3 parent adversarial + 5 real GovernedExecution regressions.
- G12-focused-final.txt. Red evidence G12-red.txt (missing module), G12-usage-red.txt (raw malformed/overrun usage regressions).
- Real SQLite close/reopen confirmed replay; real Git command writes once; concurrent invokes1; stale-generation replay and post-G04 fencing; after-lock revoke; data snapshots; trusted workspace handler; malformed authority/capability; unknown blocking; terminal failure/no retry; cancellation retention; malformed persistence and injected SQL commit failure.

PASS: pnpm --filter @osstack/cli typecheck (G12-typecheck-final.txt).
PASS: pnpm --filter @osstack/cli build (G12-build-final.txt).
Import measurement: G12-import-cost.txt, cold transpiled broker import ~126.38ms. Daemon module uses only type import + lazy dynamic broker import; emitted daemon chunk confirmed dynamic import. No @osstack/graph or LangGraph heavy entry import.

ENVIRONMENT BLOCKED, MUST RERUN BY PARENT:
pnpm --filter @osstack/cli exec vitest run src/daemon-graph-action-broker.test.ts src/daemon-admission.test.ts src/daemon-policy-gate.test.ts
- All 12 tests fail at server.listen with sandbox EPERM before assertions. G12-daemon-tests.txt. Not skipped or marked passing. User explicitly allows parent to rerun Unix socket tests outside nested sandbox.

Parent may now review/accept and archive docs/evidence. No further G12 edits planned.
