# G18 actor handoff

## Owned implementation

Branch `codex/graph-runtime-foundation`. Only these four source files created/edited by this actor:

- `packages/graph/src/registry.ts` — SHA256 `53a5ae2a3c27a1e7e31f8cf21c0fd172eb81c231152139dd8bc7c172f18f7393`
- `packages/graph/src/registry.test.ts` — SHA256 `114f7fc317cdb2dc59e1ff23eb26bec85982de57f1f98dfe6fdcc789688c8a8d`
- `packages/graph/src/spec-compiler.ts` — SHA256 `c331605969e62639e20a1c2df7302e69e6b3f963615b209d0c6e91e36706f7f5`
- `packages/graph/src/spec-compiler.test.ts` — SHA256 `158a0398dd76457c81bfbb004e1700e0a8f8c029184cb2ed2593467ebf2239e4`

No index/package/protocol/CLI/core/worker-runtime/migration/docs edits, agents spawned, commits or pushes. Shared worktree changes reported by Loop include other contributors' work; they are not actor changes. The pre-implementation proposal is `/Volumes/AIMATE_WORK/tmp/gc6/G18-interface.md`.

## Exported interface

`registry.ts`: `GRAPH_REGISTRY`, `validateGraphRegistry`, types `GraphFieldKind`, `GraphNodeContract`, `GraphOperation`, `GraphRegistry`.

`spec-compiler.ts`: `GRAPH_COMPILER_VERSION`, `compileGraphSpec`, `validateGraphPlan`, types `GraphInputMapping`, `GraphPlanNode`, `GraphPlan`, `CompiledGraphSpec`.

`compileGraphSpec(spec: unknown, registry?: unknown)` returns a deeply frozen detached `spec`, domain-separated `specHash`, compiler/registry/schema version strings, `plan`, required `budget`, exact selfcontained ESM `source`, SHA256(source) `compiledProgramDigest`. No filesystem or execution during compilation. Parent owns package exports; use a lazy compiler subpath rather than loading validators/SDK through the root index.

Registry definitions/routes/costs are fixed and immutable. `validateGraphRegistry` permits trusted host version-label changes only; arbitrary tool/schema/cost/node/route changes fail closed. A semantic registry change requires code release. Input boundary is decoded plain JSON; accessors/functions rejected without evaluation, hostile in-process Proxy traps out of contract.

## Fixed plan and reservation

Each epoch 0..maxEpochs-1 reserves six nodes, in order: workspace, implement (epoch0)/repair (later), freeze, review, tests, join. IDs `e0.workspace`, `e0.implement`, `e0.freeze`, `e0.review`, `e0.tests`, `e0.join`; later e1/e2 use repair. Functional names `code-delivery-v1.` + node ID. Effect slot `main` is fixed. `maxLedgerAttempts` is 1 except review/tests = maxBranchAttempts. It is a reservation ceiling, not worker authorization.

Plan input mappings are typed `spec`, `start`, or preceding `node` outputs. Full-output `$` references are used by reserved joins; `evidenceRefs.0` is the fixed reserved repair feedback reference. `validateGraphPlan` validates required keys, output existence/type/reachability and exact fixed topology. It is not a generic DAG admission interface.

Worst-case starts: `epochs * (3 + 2 * branchAttempts)`.
Worst-case tokens: `epochs * (32768 + 16384 * branchAttempts)`.
Trusted registry ceilings: implement/repair 32768, review 16384, command tests/workspace/freeze/pure join 0. All 96 allowed epoch/attempt combinations tested at exact budgets and one below each required budget. Executors must enforce their registered token ceilings. Reader concurrency/deadline are host admission constraints, not wall-clock feasibility predictions.

## Executable program and G19/G20 connection

Emitted module exports `run(ctx)` using the existing worker context; GraphWorkerManager hashes its exact source, and worker-runtime supplies the enclosing actual public Functional entrypoint. `run` defines stable named ctx.task functions with maxAttempts:1 and invokes ctx.action for epoch0 workspace_create -> implement -> freeze -> ordered review/tests. It returns `{ candidate, review, tests }`. Parent supplies templateVersion `code-delivery-v1`, executionModel `langgraph-functional-v1`, durability `sync`, pinned engine/checkpoint versions, and request inputDigest in the registered program identity.

Worker requests contain existing strict WorkerActionRequest fields only, never logicalAttempt. Dynamic lease/receipt/candidate values are validated predecessor task results. Responses are checked for request/generation/scope/run/spec/epoch/node/slot correlation, confirmed state, exact output fields/kinds, revision/lease consistency; cached RETURN shape is revalidated. Unknown/failed outcomes stop, never choose a new slot or retry. Host-only retryAuthorized remains sole explicit retry authority.

G19 host must register exact node/epoch/slot/action contracts and trusted per-action workspace/executor/evidence resolution. Requested workspace refs do not authorize writes or create branch workspaces. `acceptanceRef` is used as `commandSpecRef` under an explicit trusted host resolution convention; no arbitrary shell/code enters GraphSpec. Candidate evidence is structurally validated here; host proves artifact/evidence truth independently.

G20 receives the ordered candidate/review/tests bundle for join/routing. The returned source currently executes **only the epoch0 scaffold**. Join and later repair epochs are reserved plan data; G18 does not dispatch them. Connecting Functional join/routing/repair execution requires parent integration into the compiler-owned fixed emitter with a new compiler version and recomputed exact-source digest. Do not append code and retain the old digest. Static later mappings identify candidate/feedback inputs, not an implemented repair policy. Full G21 code-delivery lifecycle, candidate restore/workspace release and publication are future work. No ready/publication result or G21 completion claim.

Parallel task calls are created in deterministic plan order. This scaffold does not provide G20 complete failure collection/routing, a new node FSM, automatic recovery, or production checkpoint durability proof. Production RemoteCheckpointSaver remains unchanged. Tests use actual Functional entrypoint/task execution with a schema-validating action fixture and no MemorySaver.

## RED / GREEN and exact validation

All invoked commands explicitly set `OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc6/home` and `TMPDIR=/Volumes/AIMATE_WORK/tmp/gc6`. No default DB opened.

- RED: `/Volumes/AIMATE_WORK/tmp/gc6/G18-red.log`: both suites failed for absent registry/compiler modules before implementation.
- Initial GREEN: `/Volumes/AIMATE_WORK/tmp/gc6/G18-green-first.log`: 37 focused tests passed.
- Expanded GREEN: `/Volumes/AIMATE_WORK/tmp/gc6/G18-green-expanded.log`: 57 focused tests passed.
- Final actual OSStack Loop: `/Volumes/AIMATE_WORK/tmp/gc6/G18-loop-KHCxyA/result.json`, `LOOP-STATE.json`, `STATE.md`; summary `/Volumes/AIMATE_WORK/tmp/gc6/G18-loop-final.log`. `sources:[]`, unique input task ID, `skipCompletedTasks:false`, **executedTaskCount=1**, **outcome=success**, all three required verifiers pass. Local command executor; no spawned coding/review agent.
- Execute command: `pnpm --filter @osstack/graph exec vitest run src/registry.test.ts src/spec-compiler.test.ts`: **57 tests pass**, including all 96 budget combinations, ESM import + actual Functional task execution, fixed task ordering/mappings, malformed predecessor output/correlation rejection, unknown no-retry behavior, registry/spec/mapping malformed data, snapshots, exact source hashing, version/determinism checks and no clock/random/accessor execution during compilation.
- Verifier 1: `pnpm exec tsc -p /Volumes/AIMATE_WORK/tmp/gc6/G18-typecheck.json`: focused strict check of the four owned files, pass.
- Verifier 2: `pnpm exec biome check packages/graph/src/registry.ts packages/graph/src/registry.test.ts packages/graph/src/spec-compiler.ts packages/graph/src/spec-compiler.test.ts`: pass.
- Verifier 3: `git diff --check -- packages/graph/src/registry.ts packages/graph/src/registry.test.ts packages/graph/src/spec-compiler.ts packages/graph/src/spec-compiler.test.ts`: pass. Since files are untracked, actor additionally scanned every owned file for trailing whitespace, pass.
- Initial package-wide graph typecheck (`G18-typecheck-first.log`) failed on two actor issues (fixed) and concurrent G19 `nodes/branch.test.ts` literal-type issues. No changes made to other owners' code. Final focused typecheck is green; parent owns current integrated package check.

## Acceptance boundary

This is a focused G18 handoff, **not full C6 acceptance**. Parent owns G19/G20 integration, full build/typecheck/tests, real host acceptance, Claude Fable5.1 review, evidence/docs updates and any commits. Loop success and diff checks do not substitute for those checks. No new dependency/version change or production saver substitution was introduced.
