# G13 implementation handoff

Implemented in the existing isolated worktree. No G13 commits/pushes, task-status edits, AGENTS changes, nested agents, or Loop changes. G11 ledger files and G12/parent CLI files were not edited by G13. Migration27/core export were added only after G11-handoff.md existed and documented the shared transaction utility. The final code uses that internal utility without exporting it publicly.

## Exact integration surface

- `@osstack/graph/checkpointer`: `new RemoteCheckpointSaver(threadId: string, transport: GraphCheckpointTransport)` extends the installed public checkpoint 1.1.5 BaseCheckpointSaver. Graph root descriptor remains light; no runtime export added to root.
- `@osstack/protocol`: GraphCheckpointRequest/Response/TupleWire schemas and types; parseGraphCheckpointRequest/Response; GraphCheckpointTransport `(request) => Promise<response>`; byte/page bounds. Detailed wire shapes remain in G13-interface.md and generated schemas.
- `@osstack/core`: `new GraphCheckpointStore(db).execute(fence: GraphRunFence, request: GraphCheckpointRequest): {run: GraphRun, response: GraphCheckpointResponse}`.
- Each host binding fixes trusted scope/run/program/generation/owner. Refresh revision for each serialized operation, preserving that original worker generation/owner/program. Host authorization precedes store; store rechecks the complete live fence in BEGIN IMMEDIATE before reading or replaying cache. Adopt the returned run after mutation. No worker JSON scope or authority fields are accepted.
- Mutation request IDs are generated once before transport dispatch. A transport retry reuses the exact request/id. The saver propagates rejected transport operations and does not automatically retry unknown failures. Changed payload under an existing ID conflicts. Replay does not bump revision; fresh committed mutation does.

## Persistence/semantics

Migration27 adds graph_checkpoints, graph_checkpoint_writes, graph_checkpoint_requests in the daemon control-plane SQLite. No second DB or node scheduler. Core stores opaque bounded codec strings; it never imports graph/LangGraph or revives values/classes. Reads, complete put/putWrites batches, cache checks, and revision increments use G11 fencedGraphTransaction.

Remote encoding uses CheckpointCodec and validates decoded v4 checkpoint snapshots with assertCheckpointV4. Parent config, metadata, newVersions and pending writes are retained. Checkpoint IDs are immutable, and parent IDs must precede child IDs in storage order; unsupported v3 migration and deleteThread explicitly reject. Negative indexes match every entry of installed public WRITES_IDX_MAP; ordinary nonnegative task/index slots keep first-write semantics. Writes may precede their checkpoint. Error/resume false and final multi-channel batches roundtrip.

Limits: each codec string <=1 MiB; request/response frame <=8 MiB; stored tuple <=4 MiB including accumulated writes; <=4096 writes; <=16 tuples requested per page. Frames reject accessors/proxies/cycles and over-budget traversal before aggregate JSON serialization. Remote encoding stops accumulating oversized write batches early. Core pages also split at traversal/byte budgets. Public list follows every cursor, with namespace/before/checkpoint filtering, structural metadata equality (G07 evidence), matching-item limit, and cursor/order validation. Missing namespace lists all namespaces of the bound run only. SQLite BINARY order is mirrored by remote cursor comparisons.

## Validation (all OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc4/home, TMPDIR=/Volumes/AIMATE_WORK/tmp/gc4)

- Protocol build/typecheck: pass; tests **210 passed**; schema drift check pass.
  Logs: G13-protocol-build.txt, G13-protocol-typecheck.txt, G13-protocol-tests.txt, G13-schema-check.txt, G13-schemas.txt.
- Core build/typecheck: pass; full core **385 passed / 35 files**; final checkpoint focused **9 passed**.
  Logs: G13-core-build.txt, G13-core-typecheck.txt, G13-core-all.txt, G13-core-checkpoints.txt.
- Graph build/typecheck: pass; full graph **44 passed / 5 files**, including **18 remote saver tests**.
  Logs: G13-graph-tests.txt (includes build), G13-graph-typecheck.txt.
- git diff --check: pass. Checkpoint module cold import before core export: **15.94 ms**, G13-export-load.txt.
- Red evidence retained: G13-remote-red.txt, G13-remote-ipc-red.txt, G13-core-red.txt, G13-page-bounds-red.txt, G13-remote-bounds-red.txt.

The real child IPC fixture `scripts/fixtures/graph-checkpoint-server.mjs` owns file-backed GraphCheckpointStore/openDb. Requests and ACKs are delayed on the event loop. Before-commit SIGKILL pauses inside a SQLite transaction, after rows are inserted and before replay record/COMMIT; reopen proves all those rows absent. After-commit SIGKILL happens before ACK; reopen observes data, and exact-ID retry does not duplicate it. Tests cover checkpoint put, task RETURN, workflow final batch, injected request rejection, SQL rollback mid-batch/cache insertion, concurrent RPC writes, close/reopen, and Functional task error/replay/resume false.

## Observed boundaries for parent acceptance

1. Pinned LangGraph 1.4.15 rejects bare Command({resume:false}); accepted public form is Command({resume:{[interruptId]:false}}), exactly C2. The false value persists and replays.
2. An injected rejected RETURN RPC can coexist with a later completed batch: the SDK tracks multiple write promises. invoke rejects, but subsequent null resume can reuse committed completion. Do not interpret invoke rejection as global checkpoint rollback or as absence of an effect. This is explicitly tested.
3. Killing persistence before RETURN commit can re-enter the task body; after RETURN commit the cached result avoids re-entry. External effect intent/confirmed/unknown reconciliation belongs to G11/G12 ledger/broker, not this saver. No physical exactly-once claim.
4. ACK means SQLite COMMIT returned under existing WAL synchronous=NORMAL policy. No power-loss durability claim.
5. The IPC fixture kills the persistence process while invoking public Functional code in the test parent. It is real asynchronous RPC/SQLite/commit/ACK/crash coverage, not a production worker-lifecycle claim. G14 and production daemon/worker/broker G17/G25 recovery acceptance remain future. Parent owns authenticated daemon/socket integration and its tests; G13 did not edit or claim those results.

## G13-owned files

packages/protocol/src/graph-checkpoint.ts; graph-checkpoint.test.ts; explicit additions in index.ts/generate.ts/schemas.test.ts; two generated graph-checkpoint schemas.
packages/graph/src/remote-checkpointer.ts; remote-checkpointer.test.ts; checkpoint-ipc-fixture.ts; package.json checkpointer subpath.
packages/core/src/state/graph-checkpoints.ts; graph-checkpoints.test.ts; migration27 only in migrations.ts; explicit GraphCheckpointStore core export.
scripts/fixtures/graph-checkpoint-server.mjs.
