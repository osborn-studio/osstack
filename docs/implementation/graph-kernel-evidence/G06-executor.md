# G06 executor evidence

Implemented only the independent graph package boundary. No business graph,
listener, broker, checkpointer, database owner, or CLI integration is introduced.
The supervisor owns task status, independent review, full validation and commits.

## Delivered boundary

- `@osstack/graph` exports frozen `GRAPH_KERNEL` identity/version metadata and
  erased protocol types. Its emitted JS has no imports.
- `@osstack/graph/worker` explicitly exports the public LangGraph `Annotation`,
  `StateGraph`, `START`, `END` primitives and the same identity descriptor. It is
  an SDK capability seam, not an executable worker listener.
- ESM JS/types exports, `tsc` build/typecheck, public publishing metadata and the
  repository `prepare-npm-package.mjs` prepack hook follow package conventions.
  Tests build first because the lightweight boundary test imports emitted JS in
  a fresh Node process. The packed archive has both entrypoints/declarations,
  maps, LICENSE and package.json; no compiled tests. pnpm converts the protocol
  workspace dependency to `0.15.0` in the packed manifest.

## Exact dependencies and compatibility

Direct runtime pins are `@langchain/langgraph@1.4.15`, `@langchain/core@1.2.11`,
`@langchain/langgraph-checkpoint@1.1.5`, plus `@osstack/protocol@workspace:*`.
The sole direct development dependency is `@types/node@22.19.19`.
The supervisor fetched actual registry metadata and installed dependencies after
executor DNS failed; see [registry metadata](registry-metadata.json) and
[installation confirmation](dependency-installation-ready.txt). Public registry
records: [LangGraph](https://registry.npmjs.org/@langchain/langgraph/1.4.15),
[core](https://registry.npmjs.org/@langchain/core/1.2.11),
[checkpoint](https://registry.npmjs.org/@langchain/langgraph-checkpoint/1.1.5).
Installed manifests and lockfile integrity hashes agree with those records.

The recursive installed production closure, including available optional peers,
contains 35 package instances including graph/protocol, exactly one LangGraph
kernel, and no `@osstack/{core,loop,cli,agents}`, native SQLite or SQLite saver.
Both protocol and the LangGraph/core peer resolution use Zod **3.25.76**; the
repository's pre-existing Zod 4 elsewhere is unchanged. Key transitive pins are
SDK 1.11.0, LangChain protocol 0.0.19, langsmith 0.10.3, standard-schema 1.1.0,
cfworker/json-schema 4.1.1, js-tiktoken 1.0.21, p-queue 6.6.2/9.3.3,
p-timeout 3.2.0/7.0.2 and p-retry 7.1.1. The complete edges, paths and engine
ranges are in the temporary `G06-closure.json`; `pnpm-lock.yaml` fixes the closure.

LangGraph/checkpoint declare Node >=18 and core declares >=20. Installed optional
LangSmith OpenTelemetry peers narrow the Node 20 floor to **20.6.0**
(`^18.19.0 || >=20.6.0`); Node 22's engine floor is **22.0.0**. The graph package
declares >=20.6.0 accordingly. Runtime tests actually used **20.20.2**, **22.22.1**
and 26.5.0 on macOS arm64; 20.6.0/22.0.0 themselves were not executed. This is
not certification of every minor/platform or complete OSStack compatibility.
The repository's pnpm **11.4.0** separately requires Node **>=22.13**; Node 20
checks used the already-installed Vitest runner directly, not pnpm under Node 20.

SQLite remains daemon-owned. The supervisor's independent fresh-fixture native
`better-sqlite3@12.10.0` in-memory roundtrips passed on Node 20.20.2 (ABI 115) and
22.22.1 (ABI 127), as recorded in [SQLite compatibility](sqlite-runtime-compat.json).
Those checks do not imply native packaging/full application compatibility.

pnpm's resolution also attaches newly available cfworker/json-schema to the
existing MCP/Claude SDK optional peer snapshot and changes protobufjs's
`@types/node` resolution from 25.8.0 to 22.19.19. No corresponding runtime package
version was upgraded. These lockfile consequences are retained as generated;
the supervisor's agents/full-suite validation must cover them.

## RED, GREEN and fresh-process measurements

Raw evidence directory:
`/var/folders/97/wmwg4qzx02j74c3n73nh438w0000gn/T/osstack-graph-kernel-z3zisd4r/evidence`.
All CLI/tests inherited the explicitly supplied temporary `OSSTACK_HOME` ending
in `osstack-graph-kernel-z3zisd4r/home`; no default serving DB was opened.

- `G06-red.txt`: before implementation, the root test fails with
  `ERR_MODULE_NOT_FOUND` for dist/index.js and the worker suite fails on missing
  worker-entry.js. This follows writing the tests; no implementation existed.
- `G06-green.txt`, `G06-node20-green.txt`, `G06-node22-green.txt`: two tests pass:
  real Node root resolution with no dependency loads, and an actual typed tiny
  StateGraph incrementing 41 to 42 through the worker source boundary.
- `G06-final-validation.txt`: package build, typecheck and tests after reading
  supervisor follow-up. `G06-lint.txt`: four TS files pass Biome.
- `G06-frozen-lock.txt`: offline frozen-lockfile-only install passes, unchanged.
- `G06-pack.txt`: real pnpm pack/prepack succeeds; archive retained in evidence.
- `G06-loads.mjs` / `G06-load-summary.json`: five fresh processes per entry per
  runtime, import timing without loader instrumentation; public worker export
  executes the tiny StateGraph in each process. All child processes exit normally.
- `G06-*-modules.jsonl`: separate public `node:module.register` resolve/load hooks
  record parent/specifier/URL edges and loaded modules; `G06-*-cjs.json` captures
  public require.cache as a supplement. CLI help has its own resolution trace.

| Runtime | Root import median | Worker import median | Root files / CJS cache | Worker hook files / CJS cache | CLI version / help median |
|---|---:|---:|---:|---:|---:|
| 20.20.2 | 2.71 ms | 111.81 ms | 1 / 0 | 516 / 7 | 26 / 87 ms |
| 22.22.1 | 2.36 ms | 156.37 ms | 1 / 0 | 516 / 7 | 48 / 111 ms |
| 26.5.0 | 1.02 ms | 153.54 ms | 1 / 0 | 516 / 7 | 32 / 84 ms |

Module counts exclude builtins; the hook and CJS cache counts may overlap and
are not summed. Root traces contain only dist/index.js. Worker traces load
LangGraph but no OSStack control-plane packages or native SQLite. CLI traces
contain no graph/LangGraph modules. Node 26 baseline before installation was
32 / 85 ms; after was 32 / 84 ms, within the existing 150 / 500 ms budgets.
These are local samples with a warm filesystem cache, not daemon RPC/tick or
deployment benchmarks. CLI source and build output were not modified by G06.

Supervisor follow-up was read again before final validation. G07 should retain
the lightweight root and expose codec/Saver work through an explicit heavy
subentry; M1 still owns the production process, controlled RPC and database.
