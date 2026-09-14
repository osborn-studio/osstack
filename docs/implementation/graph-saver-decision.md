# G07: public Saver and restricted checkpoint wire decision

> **C2 后续决定（2026-09-13）：** 原 StateGraph 反例仍有效。公开 Functional API + durability:sync 已完成独立故障矩阵，获准进入 M1 集成；不代表生产可用。见 [Functional 决策](../design/2026-09-13-graph-functional-runtime.md)及 [C2 验收](2026-09-13-graph-c2-completion.md)。下文保留 G07 原始结论。

2026-09-13. Tested pins: `@langchain/langgraph` **1.4.15**, `@langchain/langgraph-checkpoint` **1.1.5**, `@langchain/core` **1.2.11**. Executor runtime: Node **26.5.0**, macOS arm64. Supervisor owns independent runtime/adversarial/full-repository validation.

**Decision: the public Saver extension supports the restricted static JSON graph's storage seam, including cross-process completed-sibling recovery and interrupt/resume. Unconditional kernel admission is NOT established. A reproducible engine partial-abort counterexample remains a production recovery gate.** No engine patch, private import, production DB, checkpointer RPC or worker manager was introduced. A passing probe means its assertions (including recognition of the counterexample) passed; it explicitly reports `productionReady: false`.

## Sources and scope

The installed pinned package's public `dist/base.d.ts`, `dist/types.d.ts`, `dist/serde/base.d.ts`, `dist/index.d.ts` define the exact contract below. `dist/base.js`, `dist/memory.js` and `dist/serde/types.js` were inspected read-only for inherited behavior, reserved indexes and serialization types. The probe resolves only package-root exports and exported `package.json`; it asserts actual installed versions. It never reads or writes `MemorySaver` private storage. A separate unmodified public `MemorySaver` baseline reproduces the failure described below.

Official [checkpointer documentation](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) describes thread/namespace identities, newest-first history and retention of successful task writes when a sibling fails. Official [fault-tolerance documentation](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) supplies the recovery context. Live docs can evolve; installed declarations at the pins above govern this experiment. The public-interface conclusion is based on the local experiment, not an inference that all documented recovery scenarios have passed.

## Versioned method coverage

Types below use public `RunnableConfig`, `Checkpoint`, `CheckpointMetadata`, `ChannelVersions`, `PendingWrite` and `CheckpointTuple`.

| Public method at checkpoint 1.1.5 | Evidence and storage obligation |
|---|---|
| `getTuple(config): Promise<CheckpointTuple \| undefined>` (abstract) | Missing returns undefined; explicit ID and latest per thread/namespace; full tuple round trip in another process. Tuple includes `config`, `checkpoint`, `metadata`, optional `parentConfig`, and `[taskId, channel, value][]` pending writes. Never replace missing with an empty checkpoint. |
| `list(config, options?): AsyncGenerator<CheckpointTuple>` (abstract) | Full tuple equality with getTuple; descending IDs; `before.configurable.checkpoint_id` exclusive, `limit` including zero, metadata `filter`, thread/namespace/ID selection and omitted-field wildcard. Future RPC must page/bound history; generator itself is worker-local. |
| `put(config, checkpoint, metadata, newVersions): Promise<RunnableConfig>` (abstract) | Stores every checkpoint and metadata field, all `newVersions`, original parent identity and returns new identity. Exact put retry retains pending writes. Parent and fork history remain distinct. |
| `putWrites(config, writes: [channel, unknown][], taskId: string): Promise<void>` (abstract) | Separate from full checkpoint; persists even before put; retains task/channel/value and explicit derived index. Tested ordinary retry, task isolation (including commas), duplicate channels at different indexes and reserved overwrite. |
| `deleteThread(threadId): Promise<void>` (abstract) | Removes checkpoint and write rows across all namespaces for that thread; other thread survives. Destructive production authorization/retention is future work. |
| `get(config): Promise<Checkpoint \| undefined>` (inherited) | Tested delegation and missing/loaded result. No new transport method needed. |
| `getNextVersion(current: V \| undefined): V` (inherited) | Default numeric sequence undefined→1, 3→4. String input throws and requires an explicit monotonic override. String versions are preserved by storage, not silently coerced into numeric versions. |
| `getDeltaChannelHistory({ config, channels }): Promise<Record<string, DeltaChannelHistory>>` (inherited, **beta**) | Tested empty request and parent-chain seed/writes, excluding unrelated fork and target's own pending writes. This verifies the inherited method's seam only. **DeltaChannel/DeltaSnapshot are excluded from v1**, not certified by this test. Future bounded history/ancestor cycles and compatibility need separate admission. |
| `toJSON(): string` (inherited) | Framework diagnostic hook, not a persistent representation; facade does not serialize saver instances or runnable config callbacks. |
| `serde: SerializerProtocol`; `dumpsTyped(data): Promise<[string, Uint8Array]>`; `loadsTyped(type, data: Uint8Array \| string): Promise<unknown>` | `CheckpointCodec` structurally implements the public interface, tested typed round trip and rejection of unknown type. Test facade supplies it to `super(codec)` and uses the same codec for request, file and response boundaries. |

Checkpoint **v4** requires `v`, `id`, `ts`, `channel_values`, `channel_versions`, `versions_seen`. The probe preserves all six, an extra field, mixed numeric/string channel versions and per-node versions seen. Metadata includes `source`, `step`, `parents`, extra nested data, legacy/custom `writes` and optional beta `counters_since_delta_snapshot`. Unknown **JSON fields are retained**, not stripped. `assertCheckpointV4` rejects old/new unsupported versions and malformed required fields; it validates values already decoded by the codec and is not a standalone validator for executable in-process objects.

Only durable config identity crosses the test wire: `thread_id`, defaulted `checkpoint_ns`, and optional `checkpoint_id`. The parent pointer uses the previous checkpoint ID, not the most recent ID globally. Live runnable configs also contain functions, callbacks, saver instances and engine runtime values: serializing the whole config is neither required nor safe. Persisted graph identity/spec hash/registry version/engine version and authenticated scope must be bound outside this codec by future protocol/storage work.

## Pending writes and error channels

Key ordinary writes by `(thread, namespace, checkpoint, taskId, index)`, **not by channel** or a comma-concatenated string. `CheckpointPendingWrite` on reads omits the index, but storage must retain it. The public `WRITES_IDX_MAP` specifies:

| Public constant | Channel | Index | Retry policy |
|---|---|---:|---|
| `ERROR` | `__error__` | -1 | Replace earlier value for same task/index |
| `SCHEDULED` | `__scheduled__` | -2 | Replace |
| `INTERRUPT` | `__interrupt__` | -3 | Replace |
| `RESUME` | `__resume__` | -4 | Replace |
| `TASKS` | `__pregel_tasks` | Ordinary position | First committed value wins |
| Other channels | Including barrier and output channels | Ordinary position | First committed value wins |

The facade uses an own-property map lookup; it does not filter names beginning with `__`. Error and ordinary index zero can coexist. Repeated `putWrites` cannot change an already committed ordinary value, even if the retry changes its channel name. Two writes to the same channel at different indexes must both survive. Put retries do not clear writes; deletion is separate.

The actual engine error write is a plain `{message, name}` record. Actual interrupt writes carry a plain interrupt **object** including `id` and `value`; the invoke result's interrupt collection is an array. Resume writes include the matching ID/input bookkeeping and survive `false` input. All of these pass the codec unchanged. `new Error()`, thrown values lacking a JSON-compatible message/name, or arbitrary class state are not automatically normalized: registered wrappers must produce compatible data or the saver rejects and the graph fails. The probe verifies `getTuple`, `put` and `putWrites` transport rejection reaches `graph.invoke`.

## Restricted codec

`packages/graph/src/checkpoint-codec.ts` has no runtime engine import; the public checkpoint imports are type-only. The supervisor exposes it at the explicit `@osstack/graph/codec` subentry, compiled to `dist/checkpoint-codec.js` and used by the repository probe. It loads only node:util; the root package remains descriptor/type-only. The daemon still depends only on protocol and must not gain a graph dependency merely to reuse this worker codec.

Wire envelope: `["osstack-checkpoint", 1, value]`, serializer type `osstack-checkpoint-v1`. Null, boolean, finite number and strings are leaves. Containers are `["array", values]` and `["object", sortedKeyValuePairs]`. Opt-in bytes use `["bytes", lowercaseHex]`. User arrays resembling tags remain tagged arrays, eliminating byte-tag collisions. Object keys sort by JavaScript code-unit order. Negative zero normalizes to zero, as JSON does. A decode/re-encode produces the canonical wire; incoming JSON whitespace need not be canonical.

| Per-message ceiling (callers may only tighten) | Value |
|---|---:|
| Wire UTF-8 bytes | 1,048,576 |
| Logical depth (root 0) | 64 |
| Logical value nodes | 50,000 |
| String/key UTF-16 code units | 262,144 |
| One restricted byte value | 262,144 bytes |

Decode checks raw byte/character bounds before allocating decoded text, checks actual UTF-8 size, then scans nesting and structural token counts **before JSON.parse**. Tagged representation's preflight ceilings are `3 × maxDepth + 4` and `8 × maxNodes + 8`. Parsing therefore has a hard input/allocation ceiling even for malformed/unknown tags; logical limits are enforced while decoding. Hex size/syntax is checked before byte allocation. UTF-8 bytes use fatal decoding. Tests spy on JSON.parse to establish early rejection. Encode accounts for wire growth while emitting bounded chunks; object reflection operates on already-existing local objects, so this is not a process-memory quota for a caller that constructed a huge object before calling the codec.

Rejected: undefined (including array holes), nonfinite numbers, bigint, functions, symbols, cycles, class instances, custom prototypes, accessors, hidden/symbol/extra array properties, `__proto__`/`constructor`/`prototype` keys, duplicate or unsorted decoded keys, unknown tags/versions, unbounded depth/nodes/strings/wire and malformed bytes. Null-prototype records are accepted and decoded as ordinary safe records. Proxies are rejected using Node's intrinsic proxy check. Hooks and `toJSON` are never invoked.

Bytes are disabled by default. Opt-in accepts exact Uint8Array values without extra properties; Buffer, other typed arrays, subclasses and shared storage are rejected as state values. Raw wire Buffer/Uint8Array is accepted. Captured TypedArray intrinsic getters inspect raw storage without executing shadowed `buffer`, `byteLength`, `byteOffset` or `length` accessors; getter-counter regression tests cover both encode and decode. No loader, arbitrary constructor, engine-private class, JSONPlus revival or dynamic import is driven by persisted data.

## Cross-process result and smallest failure

Run after graph build:

```sh
node scripts/graph-test-env.mjs -- pnpm --filter @osstack/graph test
node scripts/graph-test-env.mjs -- node scripts/probe-graph-saver.mjs
```

The probe creates its own owned temporary home, writes an owner token, and starts eight **separate Node processes** sequentially with 30-second timeouts and bounded output. Each writer exits before the reader starts. All requests reload the bounded file and cross JSON wire boundaries in both directions. File replacement writes/fsyncs before rename. A random global canary exists only in the first graph process; the recovery process verifies its absence and reads the previous PID from disk. Empty storage is a negative control. Cleanup checks the owner token, parent PID, canonical path and symlink state, then removes only this invocation's fixture. The result reports each assertion, phase PID/exit code, actual package pins, final file digest and cleanup outcome; failed assertions produce a nonzero exit.

Successful graph: START fans out to `completed` and `flaky`; their AND edge leads to `join`. Failure is injected only after the completed task's **whole write batch**, including the barrier notification, has persisted. A second process resumes with null input. Observed counts: completed **1**, flaky **2**, join **1**; all three outputs present. Separate processes also persist an interrupt, recover its ID and resume with false.

**Smallest counterexample retained in `faults`:** use the same graph, but let flaky throw immediately. In these pinned packages, the other task can write `results=["completed"]` and then be aborted before its `join:completed+flaky:join` write. Saved tuples show output plus `__error__={name:"AbortError",…}` for that task. Resume returns both result values but never executes join; completed count is 1 and join count is 0. The probe asserts and records this result separately, and reproduces it using an unmodified public MemorySaver (public getTuple only), so it is not attributed to JSON conversion or the test facade. The initial discovery log also preserves the full persisted checkpoints/writes. This counterexample is currently an in-process fault subcase; the positive recovery proof above is cross-process. It does not prove every crash window or ordering behaves identically.

This is why “some output was stored” must not be equated with “the task completed.” The public saver receives writes and has no authoritative task-completion bit with which to reconstruct a missing engine-generated barrier notification safely. Do not silently discard the error, invent the missing write, rerun every sibling, or patch the engine to make the test green. **The supervisor must resolve/adjudicate this gate before claiming arbitrary failure recovery or complete kernel admission.**

| Alternative | Evaluation, not implemented |
|---|---|
| Upstream public release fix | Preferred if it fixes the minimal counterexample and the entire pinned compatibility matrix; requires deliberate pin change and rerun. No automatic upgrade. |
| Public node wrappers return structured branch-failure data | Avoids deliberate expected failures aborting a sibling; compatible with existing business-result design. Unexpected exceptions/cancellation/worker death remain unproved, so this alone is insufficient. |
| Public custom channels / explicit completion receipts | Could avoid reliance on generated AND notifications; needs separate proof that partial writes cannot masquerade as completion. Must not become private engine patching or arbitrary write filtering. |
| Bounded static scheduler | Matches the v1 static graph and can explicitly represent durable completion/barrier receipts; carries implementation and verification cost for retries, interrupts and replay. Concrete fallback if upstream/public seams cannot meet the crash matrix. |
| ADK evaluation | Alternative engine spike would need the same saver/serialization/process/failure matrix. No compatibility or recovery claim made without running it. |

A separate smallest serialization incompatibility is `codec.encode(new Send("node", {x:1}))`: public Send is a class and is intentionally rejected. Dynamic Send/DeltaChannel/message-class state are excluded from this static JSON v1 decision. Adding them requires an explicit versioned allowlist and new public-interface tests, not generic class revival.

## Remaining production obligations

The file facade is test-only, single-writer, synchronous and bounded to a small complete store. Its fsync/rename proof is process persistence, not power-loss durability or multi-process transaction isolation. There is no production auth, fencing, generation/idempotency/CAS enforcement, database schema, bounded RPC paging, cancellation reconciliation, migration, retention or worker management. These remain the planned M1+ work, along with the partial-abort admission gate. The daemon must remain core→protocol and validate scope/size/format before storage; it must not import the engine or deserialize executable classes.

## Supervisor runtime supplement

The graph codec/package tests passed on Node 20.20.2 and 22.22.1; the eight-process probe also ran on those runtimes and the declared graph floor Node 20.6.0. This does not certify all OSStack packages on every Node minor. Development pnpm 11.4.0 itself requires Node ≥22.13. Runtime and final source evidence are archived in `graph-kernel-evidence/`. Kernel C2 admission remains blocked by the retained partial-abort case, regardless of the spike task completion status.
