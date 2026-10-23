> 历史执行器交接，非最终验收结论。最终状态与可复核证据见 [C3 报告](../2026-09-14-graph-admission-completion.md)。早期系统临时目录日志已不可用；本目录的新验收日志为重新运行所得。

# G08 executor handoff

G08 storage contracts implemented in the existing isolated worktree. No commit or task-status update made. Read repository AGENTS.md, the Functional C2 decision/completion report, and admission supervisor.md. Migration tail was 24 at implementation; G08 appends **25**, `graph_run_identity_and_worker_leases`.

## Delivered

- `graph_runs`: fresh server-generated UUID, canonical full protocol scope, immutable source/input reference/template/program identity, protocol run-status projection, revision and current worker lease.
- `graph_requests`: unique full scope/key shared by start/resume/cancel, canonical protocol business digest, run FK and immutable request records. Same request replays the same run (current projection), including after revision advancement; changed business payload conflicts. Start replay also checks the supplied compiler/program identity.
- `graph_worker_leases`: generation history, owner, acquisition/expiry and previous-worker stop receipt. Initial generation is zero; first acquisition is one; no generation reset/reuse/release path. Renewals retain generation and advance revision.
- Identity fixes `executionModel=langgraph-functional-v1`, `durability=sync`, engine/checkpoint/template/registry/compiler/schema versions, spec/input/compiledProgram digests. Every lease/projection mutation compares the full persisted identity. SQLite triggers also prevent immutable identity changes and terminal run updates.
- Short `BEGIN IMMEDIATE` storage transactions combine lookup, unique request insertion, revision/generation CAS and history/projection writes. Separate connections cannot both win the same admission or stale CAS. Injected history-write failure rolls back the earlier run update.
- SQL and runtime safe-integer bounds cover generation, revision and epoch-millisecond timestamps. Inputs use the protocol bounded JSON check before strict schema validation. Empty/oversized identifiers, nonfinite/fractional counters, backward mutation time, expired worker mutations, wrong owners and exhausted counters reject.
- Takeover always requires matching prior run/generation/owner exit evidence, even after expiry. Confirmation cannot predate the last worker mutation or lie after the trusted current time. Terminal `ready`, `failed`, `cancelled` runs cannot resurrect. Other status values are projections; no transition map or node scheduler was added.
- `openDb` rejects future schema versions before journal changes/DDL, including read-only opens, and closes its connection on configuration/migration failure. Failed migration DDL rolls back.
- Explicit core exports publish the store, error and associated types. Per the supervisor's integration request, core also exports the parent-owned `resolveRepositoryScope` and `RepositoryScope`; its module was not edited here.

## API and trustworthy caller requirements

`new GraphRunStore(db)` uses an already-open daemon-owned database. `get(scope, runId)` is scoped and returns null outside the scope. `create(startRequest, programVersion, now)` allocates or replays an identity. `acquireLease`, `renewLease`, and `project` take a scope/run/identity/expected-generation/expected-revision/expected-owner fence. `projectRequest(resumeOrCancel, projection)` atomically records an already-authorized decision and its projection; it does not invoke, resume or cancel any worker.

This is a **trusted storage API**, not an authenticated transport or authorization service:

1. The daemon authenticates principal scope and the actual worker connection independently, verifies grants and current policy, and binds lease owner to a unique worker instance. Parsing a scope or owner does not establish identity.
2. `now`, expiry and stop confirmation are trusted host epoch milliseconds. Numeric validation cannot establish a clock's truth or prevent a malicious caller from backdating it.
3. `GraphStoppedWorkerEvidence` is a structured supervisor assertion with a durable evidence reference, not a signed/capability-authenticated receipt. The host must verify actual worker exit and separately stop/reconcile independent adapter/command descendants, block new actions and isolate old workspaces before passing it. A worker-provided object, boolean, PID absence, lease expiry or rejected invoke is insufficient authorization. G14/G15 own that integration.
4. Storage computes `inputDigest` with protocol `computeGraphInputDigest` (metadata and idempotency key excluded) and `specHash` as SHA-256 of `osstack.graph.spec.v1`, LF, canonical parsed spec JSON. Object keys sort; array order is preserved. Input artifact references must already identify immutable verified artifacts: the request digest hashes the reference, not bytes fetched from external storage. Trusted compilation supplies versions and `compiledProgramDigest`, covering ordered tasks, mappings, branches/epochs/retry expansion. G18 owns that compiler; this store cannot attest its truth.
5. Status comes from authoritative checkpoint/broker evidence; terminal sealing does not prove processes stopped. New projection writes require a live worker lease; administrative reconciliation, pre-worker cancellation and expired-worker control paths need their own evidence-backed daemon integration. Replay does not write or increment revisions and still checks generation/owner/program identity for resume/cancel requests.
6. G13 must perform generation checks and checkpoint/broker writes in the **same transaction**. A separate `get` followed by an external write is not a fencing guarantee. No public generic callback/async transaction API or scheduling authority is invented here.
7. The immutable `durability: sync` field is the admitted Functional execution contract. This card does not implement a Saver, checkpoint acknowledgment, action ledger, broker, physical exactly-once effects or power-loss guarantees. Existing SQLite connection synchronous policy remains unchanged.

## Real evidence

Evidence directory: `/var/folders/97/wmwg4qzx02j74c3n73nh438w0000gn/T/osstack-graph-admission-btizzez0/evidence`.
All commands used explicit temporary `OSSTACK_HOME`; every test database uses a temporary directory. No default or production database was opened.

| Evidence | Actual result |
| --- | --- |
| `G08-red.log` | Missing storage module/table and reproduced failed-open connection leak; 16 existing tests passed. |
| `G08-green-initial.log`, `G08-green.log` | Preserved intermediate failures: nullable SQL constraint, unavailable esbuild, Vitest import.meta.resolve incompatibility. Fixed without new dependencies. |
| `G08-green-2.log` | First complete green: 43 tests. |
| `G08-hardening-red.log` | Two real failures: read-only future schema acceptance and stop receipt predating a newer mutation. |
| `G08-hardening-green.log` | 47 passed after fixes, including SQL rollback and counter exhaustion. |
| `G08-request-red.log` / `G08-request-green.log` | Missing request-projection API, then 48 passed with shared start/resume/cancel idempotency. |
| `G08-concurrency-green.log` | 50 passed, including simultaneous identical requests, conflicting requests and lease CAS. |
| `G08-focused-final.log` | `pnpm --filter @osstack/core exec vitest run src/state/graph-runs.test.ts src/state/db.test.ts`: **50 passed**, exit 0. |
| `G08-typecheck-final.log` | `pnpm --filter @osstack/core typecheck`: exit 0. |
| `G08-core-final.log` | `pnpm --filter @osstack/core test`: **342 passed / 33 files**, exit 0. Includes the parent's repository-scope tests present at this snapshot. |
| `G08-core-build.log` | `pnpm --filter @osstack/core build`: exit 0; generated core exports available for parent integration. |
| `G08-import-cost.log` | Standalone transpiled ESM cold import: 16.12 / 13.70 / 13.91 ms. After already-eager core dependencies: 0.57 / 0.49 / 0.48 ms. Measured before root export. No LangGraph imports. |

Concurrency tests transpile storage files with the existing TypeScript compiler into a temporary directory and run independent real SQLite connections in worker threads. They synchronize starts, bound the readiness/lifecycle waits, await worker exit before accepting success, and terminate/join all workers in finally. Restart coverage closes and reopens a real file-backed DB; this is not a process-kill or power-loss recovery test. Migration coverage starts from the actual populated version-24 baseline, repeats opens, checks retained rows/integrity, rejects future versions and verifies failed-open closure/DDL rollback.

## Remaining integration

No known failing G08 check. Production graph execution remains unimplemented: authorization/admission, resource locks, stopped-worker receipt verification, checkpoint/ledger fencing, compiler attestation and daemon recovery belong to subsequent cards. No claim of C3/production acceptance or task-status completion is made here. Parent retains ownership of final integration, review, commits and task status.
