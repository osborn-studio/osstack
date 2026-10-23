#!/usr/bin/env node
// TEST ONLY: synchronous JSON file transport, one writer process at a time.
// This is not the production daemon, a DB adapter, RPC server or worker manager.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertIsolatedHome, createGraphTestEnv } from './graph-test-env.mjs';

// Resolve only published package exports, in the graph package's dependency scope.
const requireGraph = createRequire(new URL('../packages/graph/package.json', import.meta.url));
// Repository script is outside graph's package scope. Honor its declared ESM
// import targets; createRequire.resolve would select unsupported CJS conditions.
const graphManifestUrl = new URL('../packages/graph/package.json', import.meta.url);
const graphManifest = JSON.parse(readFileSync(graphManifestUrl, 'utf8'));
const importGraphEntry = (entry) => import(new URL(graphManifest.exports[entry].import, graphManifestUrl).href);
const { MemorySaver, ERROR, INTERRUPT, RESUME, SCHEDULED, TASKS, WRITES_IDX_MAP } =
  await import(pathToFileURL(requireGraph.resolve('@langchain/langgraph-checkpoint')).href);
const { Annotation, StateGraph, START, END, interrupt, Command, BaseCheckpointSaver, GRAPH_KERNEL } =
  await importGraphEntry('./worker');
const { CheckpointCodec, assertCheckpointV4 } =
  await importGraphEntry('./codec');
const { Send } = await import(pathToFileURL(requireGraph.resolve('@langchain/langgraph')).href);
const codec = new CheckpointCodec({ allowBytes: true });
const assertions = [];
const observations = {};
const versions = Object.fromEntries(['langgraph', 'langgraph-checkpoint', 'core'].map((name) => [name, requireGraph(`@langchain/${name}/package.json`).version]));
assert.deepEqual(versions, { langgraph: '1.4.15', 'langgraph-checkpoint': '1.1.5', core: '1.2.11' });
assert.deepEqual(versions, { langgraph: GRAPH_KERNEL.version, 'langgraph-checkpoint': GRAPH_KERNEL.checkpointVersion, core: GRAPH_KERNEL.coreVersion });
async function check(name, run) {
  try { await run(); assertions.push({ name, passed: true }); }
  catch (error) { assertions.push({ name, passed: false, error: String(error) }); throw error; }
}
const config = (thread, ns = '', id) => ({ configurable: {
  thread_id: thread, checkpoint_ns: ns, ...(id === undefined ? {} : { checkpoint_id: id }),
} });
const selection = (input) => {
  const fields = input?.configurable ?? {};
  const selected = {};
  for (const name of ['thread_id', 'checkpoint_ns', 'checkpoint_id']) {
    if (fields[name] !== undefined) { assert.equal(typeof fields[name], 'string'); selected[name] = fields[name]; }
  }
  return { configurable: selected };
};
const identity = (input) => {
  const fields = input?.configurable;
  assert.equal(typeof fields?.thread_id, 'string');
  assert.ok(fields.thread_id.length);
  assert.equal(typeof (fields.checkpoint_ns ?? ''), 'string');
  if (fields.checkpoint_id !== undefined) assert.equal(typeof fields.checkpoint_id, 'string');
  return config(fields.thread_id, fields.checkpoint_ns ?? '', fields.checkpoint_id);
};
const key = (input) => {
  const c = identity(input).configurable;
  return [c.thread_id, c.checkpoint_ns, c.checkpoint_id ?? null];
};
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const readWire = (file) => {
  assert.ok(statSync(file).size <= 1_048_576, 'file allocation bound');
  return codec.decode(readFileSync(file));
};
function persist(file, value) {
  const bytes = codec.encode(value);
  const temporary = `${file}.next`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
}

class TestOnlyPersistentSaver extends BaseCheckpointSaver {
  constructor(file, failMethod) { super(codec); this.file = file; this.failMethod = failMethod; }
  rpc(request) {
    // Simulates BOTH serialization boundaries. No reference from the caller is
    // retained; every request reloads the file, including within one process.
    const input = codec.decode(codec.encode(request));
    if (input.method === this.failMethod) throw new Error(`injected saver ${input.method}`);
    const store = existsSync(this.file) ? readWire(this.file) : { checkpoints: [], writes: [] };
    const tuple = (row) => ({
      config: row.config, checkpoint: row.checkpoint, metadata: row.metadata,
      ...(row.parentConfig === null ? {} : { parentConfig: row.parentConfig }),
      pendingWrites: store.writes.filter((w) => equal(w.key, row.key)).map((w) => [w.taskId, w.channel, w.value]),
    });
    let response = null;
    if (input.method === 'getTuple' || input.method === 'list') {
      const fields = input.config.configurable ?? {};
      const options = input.options ?? {};
      const rows = store.checkpoints.filter((row) =>
        (fields.thread_id === undefined || row.key[0] === fields.thread_id)
        && (fields.checkpoint_ns === undefined || row.key[1] === fields.checkpoint_ns)
        && (fields.checkpoint_id === undefined || row.key[2] === fields.checkpoint_id)
        && (!options.before?.configurable?.checkpoint_id || row.key[2] < options.before.configurable.checkpoint_id)
        && Object.entries(options.filter ?? {}).every(([k, v]) => equal(row.metadata[k], v)))
        .sort((a, b) => a.key[2] < b.key[2] ? 1 : a.key[2] > b.key[2] ? -1 : 0);
      response = input.method === 'getTuple' ? (rows[0] ? tuple(rows[0]) : null)
        : rows.slice(0, options.limit ?? rows.length).map(tuple);
    } else if (input.method === 'put') {
      assertCheckpointV4(input.checkpoint);
      const current = input.config.configurable;
      const nextConfig = config(current.thread_id, current.checkpoint_ns, input.checkpoint.id);
      const rowKey = key(nextConfig);
      const row = { key: rowKey, config: nextConfig, checkpoint: input.checkpoint,
        metadata: input.metadata, newVersions: input.newVersions,
        parentConfig: current.checkpoint_id === undefined ? null : input.config };
      const index = store.checkpoints.findIndex((r) => equal(r.key, rowKey));
      if (index < 0) store.checkpoints.push(row); else store.checkpoints[index] = row;
      response = nextConfig;
    } else if (input.method === 'putWrites') {
      const rowKey = key(input.config);
      assert.equal(typeof rowKey[2], 'string');
      assert.equal(typeof input.taskId, 'string');
      for (const [position, [channel, value]] of input.writes.entries()) {
        // Own-property lookup: channel names never read Object.prototype.
        const index = Object.hasOwn(WRITES_IDX_MAP, channel) ? WRITES_IDX_MAP[channel] : position;
        const found = store.writes.findIndex((r) => equal(r.key, rowKey) && r.taskId === input.taskId && r.index === index);
        const row = { key: rowKey, taskId: input.taskId, index, channel, value };
        if (found < 0) store.writes.push(row); else if (index < 0) store.writes[found] = row;
      }
    } else if (input.method === 'deleteThread') {
      store.checkpoints = store.checkpoints.filter((r) => r.key[0] !== input.threadId);
      store.writes = store.writes.filter((r) => r.key[0] !== input.threadId);
    } else throw new Error(`Unsupported public method ${input.method}`);
    if (['put', 'putWrites', 'deleteThread'].includes(input.method)) persist(this.file, store);
    return codec.decode(codec.encode(response));
  }
  async getTuple(input) { return this.rpc({ method: 'getTuple', config: identity(input) }) ?? undefined; }
  async *list(input, options = {}) {
    // Omitted config fields mean wildcard, unlike getTuple's root namespace default.
    const wireOptions = {};
    if (options.limit !== undefined) {
      assert.ok(Number.isSafeInteger(options.limit) && options.limit >= 0);
      wireOptions.limit = options.limit;
    }
    if (options.before !== undefined) wireOptions.before = selection(options.before);
    if (options.filter !== undefined) wireOptions.filter = options.filter;
    for (const row of this.rpc({ method: 'list', config: selection(input), options: wireOptions })) yield row;
  }
  async put(input, checkpoint, metadata, newVersions) {
    return this.rpc({ method: 'put', config: identity(input), checkpoint, metadata, newVersions });
  }
  async putWrites(input, writes, taskId) {
    this.rpc({ method: 'putWrites', config: identity(input), writes, taskId });
    this.afterWrites?.(writes);
  }
  async deleteThread(threadId) { this.rpc({ method: 'deleteThread', threadId }); }
}

const checkpoint = (id) => ({
  v: 4, id, ts: '2026-09-13T00:00:00.000Z',
  channel_values: { result: ['seed'], bytes: new Uint8Array([0, 255]), [TASKS]: [{ node: 'next', args: { x: 1 } }] },
  channel_versions: { result: '0002', [TASKS]: 3 },
  versions_seen: { sibling: { result: '0001', [TASKS]: 2 } },
  extension: { preserved: true },
});
const metadata = { source: 'loop', step: 2, parents: { outer: 'parent-id' }, writes: { sibling: { result: ['ok'] } }, counters_since_delta_snapshot: { result: [1, 2] }, extra: { label: 'keep' } };
const newVersions = { result: '0002', [TASKS]: 3 };

async function contractWrite(saver) {
  await check('missing getTuple and inherited get return undefined', async () => {
    assert.equal(await saver.getTuple(config('absent')), undefined);
    assert.equal(await saver.get(config('absent')), undefined);
  });
  await check('put returns identity and repeated put preserves full fields', async () => {
    const first = await saver.put(config('contract', 'ns'), checkpoint('0001'), metadata, newVersions);
    assert.deepEqual(first, config('contract', 'ns', '0001'));
    await saver.put(config('contract', 'ns'), checkpoint('0001'), metadata, newVersions);
    await saver.put(first, checkpoint('0002'), metadata, newVersions);
    await saver.put(first, checkpoint('0003'), { ...metadata, source: 'fork' }, newVersions);
    await saver.put(config('contract', 'other'), checkpoint('0004'), metadata, newVersions);
    await saver.put(config('other-thread', 'ns'), checkpoint('0005'), metadata, newVersions);
  });
  const target = config('contract', 'ns', '0002');
  await check('ordinary writes retain first value by task/index, separate tasks coexist', async () => {
    await saver.putWrites(target, [['result', 'first'], ['result', 'second']], 'task,with,comma');
    await saver.putWrites(target, [['different-channel', 'ignored'], ['result', 'ignored']], 'task,with,comma');
    await saver.putWrites(target, [['result', 'other-task']], 'task2');
    await saver.putWrites(target, [[TASKS, { node: 'next', args: { x: 1 } }]], 'send-task');
    const writes = (await saver.getTuple(target)).pendingWrites;
    assert.deepEqual(writes.slice(0, 3), [['task,with,comma', 'result', 'first'], ['task,with,comma', 'result', 'second'], ['task2', 'result', 'other-task']]);
  });
  await check('reserved error/interrupt/resume/scheduled overwrite independent negative indexes', async () => {
    assert.deepEqual(WRITES_IDX_MAP, { [ERROR]: -1, [SCHEDULED]: -2, [INTERRUPT]: -3, [RESUME]: -4 });
    await saver.putWrites(target, [[ERROR, { message: 'first' }]], 'reserved');
    await saver.putWrites(target, [[ERROR, { name: 'Error', message: 'latest' }]], 'reserved');
    for (const channel of [INTERRUPT, RESUME, SCHEDULED]) {
      await saver.putWrites(target, [[channel, ['old']]], 'reserved');
      await saver.putWrites(target, [[channel, [{ id: 'interrupt-1', value: false }]]], 'reserved');
    }
    await saver.putWrites(target, [['result', 'ordinary-zero']], 'reserved');
    const writes = (await saver.getTuple(target)).pendingWrites;
    assert.deepEqual(writes.filter((w) => w[1] === ERROR), [['reserved', ERROR, { name: 'Error', message: 'latest' }]]);
    for (const channel of [INTERRUPT, RESUME, SCHEDULED]) assert.deepEqual(writes.find((w) => w[1] === channel)[2], [{ id: 'interrupt-1', value: false }]);
    assert.ok(writes.some((w) => w[0] === 'reserved' && w[1] === 'result'));
  });
  await check('putWrites before put remains attached and put retry does not erase writes', async () => {
    const late = config('late', '', '0001');
    await saver.putWrites(late, [['result', 'pending-before-checkpoint']], 'task');
    await saver.put(config('late'), checkpoint('0001'), metadata, newVersions);
    await saver.put(config('late'), checkpoint('0001'), metadata, newVersions);
    assert.equal((await saver.getTuple(late)).pendingWrites.length, 1);
  });
}
async function collect(generator) { const values = []; for await (const v of generator) values.push(v); return values; }
async function contractRead(saver) {
  await check('fresh process recovers all checkpoint/metadata/version/parent fields and byte values', async () => {
    const row = await saver.getTuple(config('contract', 'ns', '0002'));
    assert.deepEqual(row.checkpoint, checkpoint('0002'));
    assert.deepEqual(row.metadata, metadata);
    assert.deepEqual(row.config, config('contract', 'ns', '0002'));
    assert.deepEqual(row.parentConfig, config('contract', 'ns', '0001'));
    assert.equal(row.pendingWrites.length, 9);
    assert.deepEqual(await saver.get(row.config), row.checkpoint);
    assert.equal((await saver.getTuple(config('contract', 'ns'))).checkpoint.id, '0003');
    assert.equal((await saver.getTuple(config('contract', 'ns', '0001'))).parentConfig, undefined);
    const stored = readWire(saver.file);
    assert.deepEqual(stored.checkpoints.find((r) => equal(r.key, ['contract', 'ns', '0002'])).newVersions, newVersions);
    assert.deepEqual(stored.writes.filter((r) => r.taskId === 'reserved').map((r) => r.index).sort((a, b) => a - b), [-4, -3, -2, -1, 0]);
  });
  await check('list returns full tuples with namespace/thread/id/filter/before/limit semantics', async () => {
    const rows = await collect(saver.list(config('contract', 'ns')));
    assert.deepEqual(rows.map((r) => r.checkpoint.id), ['0003', '0002', '0001']);
    assert.deepEqual(rows[1], await saver.getTuple(config('contract', 'ns', '0002')));
    assert.deepEqual((await collect(saver.list(config('contract', 'ns'), { before: config('contract', 'ns', '0003'), limit: 1 }))).map((r) => r.checkpoint.id), ['0002']);
    assert.equal((await collect(saver.list(config('contract', 'ns'), { filter: { source: 'fork' } }))).length, 1);
    assert.equal((await collect(saver.list(config('contract', 'ns'), { limit: 0 }))).length, 0);
    assert.equal((await collect(saver.list(config('contract', 'ns', '0002')))).length, 1);
    assert.equal((await collect(saver.list({ configurable: { thread_id: 'contract' } }))).length, 4);
    assert.equal((await collect(saver.list({}))).length, 6);
  });
  await check('list and getTuple project durable identity without serializing runnable callbacks', async () => {
    const callback = () => { throw new Error('runtime callback must stay local'); };
    const live = { configurable: { thread_id: 'contract', checkpoint_ns: 'ns', runtime: callback }, callbacks: callback };
    assert.equal((await saver.getTuple(live)).checkpoint.id, '0003');
    assert.ok((await collect(saver.list(undefined, { limit: undefined }))).length > 0);
    const rows = await collect(saver.list(live, { before: { configurable: { checkpoint_id: '0003' }, callbacks: callback }, limit: 1 }));
    assert.equal(rows[0].checkpoint.id, '0002');
  });
  await check('inherited numeric version generation works and string generation requires override', () => {
    assert.equal(saver.getNextVersion(undefined), 1); assert.equal(saver.getNextVersion(3), 4);
    assert.throws(() => saver.getNextVersion('0003'), /override/);
  });
  await check('inherited beta history follows parent chain rather than unrelated fork', async () => {
    await saver.putWrites(config('contract', 'ns', '0001'), [['result', 'on-parent']], 'parent-task');
    const history = await saver.getDeltaChannelHistory({ config: config('contract', 'ns', '0003'), channels: ['result'] });
    assert.deepEqual(history, { result: { seed: ['seed'], writes: [['parent-task', 'result', 'on-parent']] } });
    assert.deepEqual(await saver.getDeltaChannelHistory({ config: config('contract', 'ns', '0003'), channels: [] }), {});
  });
  await check('deleteThread removes all namespaces and writes without deleting other threads', async () => {
    await saver.deleteThread('contract');
    assert.equal((await collect(saver.list({ configurable: { thread_id: 'contract' } }))).length, 0);
    assert.ok(await saver.getTuple(config('other-thread', 'ns')));
    assert.ok(readWire(saver.file).writes.every((r) => r.key[0] !== 'contract'));
  });
}

function parallelGraph(saver, home, fail, prefix = '') {
  // Fail at a deterministic boundary: the sibling's COMPLETE task writes
  // (including barrier notification) must be durable before the failure.
  let committed;
  const siblingCommitted = new Promise((resolve) => { committed = resolve; });
  saver.afterWrites = (writes) => {
    if (writes.some(([channel, value]) => channel === 'join:completed+flaky:join' && value === 'completed')) committed();
  };
  const count = (name) => {
    const file = join(home, `${prefix}${name}.count`);
    const n = existsSync(file) ? Number(readFileSync(file, 'utf8')) + 1 : 1;
    writeFileSync(file, String(n), { mode: 0o600 });
    return n;
  };
  const state = Annotation.Root({ results: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }) });
  return new StateGraph(state)
    .addNode('completed', () => { count('completed'); return { results: ['completed'] }; })
    .addNode('flaky', async () => { count('flaky'); if (fail) { if (fail !== 'immediate') await siblingCommitted; throw new Error('injected parallel failure'); } return { results: ['recovered'] }; }, { retryPolicy: { maxAttempts: 1 } })
    .addNode('join', (s) => { count('join'); assert.deepEqual([...s.results].sort(), ['completed', 'recovered']); return { results: ['joined'] }; })
    .addEdge(START, 'completed').addEdge(START, 'flaky')
    .addEdge(['completed', 'flaky'], 'join').addEdge('join', END).compile({ checkpointer: saver });
}
function interruptGraph(saver) {
  const state = Annotation.Root({ answer: Annotation() });
  return new StateGraph(state).addNode('ask', () => ({ answer: interrupt({ question: 'continue?', choices: [false, true] }) }))
    .addEdge(START, 'ask').addEdge('ask', END).compile({ checkpointer: saver });
}

async function child(phase, home) {
  assert.equal(realpathSync(home), assertIsolatedHome(process.env.OSSTACK_HOME));
  assert.ok(!lstatSync(home).isSymbolicLink());
  const owner = JSON.parse(readFileSync(join(home, 'probe-owner.json'), 'utf8'));
  assert.equal(owner.token, process.env.GRAPH_SAVER_PROBE_TOKEN);
  assert.equal(owner.parentPid, process.ppid);
  const saver = new TestOnlyPersistentSaver(join(home, 'saver.wire'));
  if (phase === 'contract-write') await contractWrite(saver);
  else if (phase === 'contract-read') await contractRead(saver);
  else if (phase === 'fail') {
    globalThis.probeMemoryCanary = randomUUID();
    persist(join(home, 'memory-canary.wire'), { canary: globalThis.probeMemoryCanary, pid: process.pid });
    await check('parallel superstep failure propagates after completed sibling write persists', async () => {
      const graph = parallelGraph(saver, home, true);
      await assert.rejects(graph.invoke({ results: [] }, config('parallel')), /injected parallel failure/);
      const row = await saver.getTuple(config('parallel'));
      assert.ok(row.pendingWrites.some((w) => w[1] === 'results' && equal(w[2], ['completed'])));
      assert.ok(row.pendingWrites.some((w) => w[1] === ERROR && w[2].message === 'injected parallel failure'));
      assert.equal(readFileSync(join(home, 'completed.count'), 'utf8'), '1');
      assert.equal(existsSync(join(home, 'join.count')), false);
      assert.ok(Object.keys(row.checkpoint.versions_seen).length);
      assert.ok(Object.keys(row.checkpoint.channel_versions).length);
      assert.ok(row.parentConfig);
    });
  } else if (phase === 'recover') {
    await check('new process has no memory canary and reads prior process durable checkpoint', async () => {
      assert.equal(globalThis.probeMemoryCanary, undefined);
      assert.notEqual(readWire(join(home, 'memory-canary.wire')).pid, process.pid);
      assert.ok(await saver.getTuple(config('parallel')));
    });
    await check('resume failed parallel step without rerunning completed sibling; join exactly once', async () => {
      const result = await parallelGraph(saver, home, false).invoke(null, config('parallel'));
      assert.deepEqual([...result.results].sort(), ['completed', 'joined', 'recovered']);
      assert.equal(readFileSync(join(home, 'completed.count'), 'utf8'), '1');
      assert.equal(readFileSync(join(home, 'flaky.count'), 'utf8'), '2');
      assert.equal(readFileSync(join(home, 'join.count'), 'utf8'), '1');
      observations.recovery = { completed: 1, flaky: 2, join: 1, results: result.results };
    });
  } else if (phase === 'interrupt') {
    await check('interrupt payload and id survive pending writes on disk', async () => {
      const result = await interruptGraph(saver).invoke({ answer: null }, config('interrupt'));
      assert.equal(result[INTERRUPT].length, 1);
      const row = await saver.getTuple(config('interrupt'));
      const pause = row.pendingWrites.find((w) => w[1] === INTERRUPT)[2];
      assert.equal(typeof pause.id, 'string');
      assert.deepEqual(pause.value, { question: 'continue?', choices: [false, true] });
      persist(join(home, 'interrupt-id.wire'), pause.id);
    });
  } else if (phase === 'resume') {
    await check('fresh process resumes matching interrupt with falsy input and preserves resume writes', async () => {
      const pauseId = readWire(join(home, 'interrupt-id.wire'));
      const graph = interruptGraph(saver);
      const before = await graph.getState(config('interrupt'));
      assert.equal(before.tasks[0].interrupts[0].id, pauseId);
      const result = await graph.invoke(new Command({ resume: { [pauseId]: false } }), config('interrupt'));
      assert.equal(result.answer, false);
      assert.ok(readWire(saver.file).writes.some((w) => w.channel === RESUME));
      assert.deepEqual((await graph.getState(config('interrupt'))).next, []);
    });
    await check('public graph.getStateHistory preserves full state with live callbacks', async () => {
      const history = [];
      for await (const item of interruptGraph(saver).getStateHistory({ ...config('interrupt'), callbacks: [{ handleChainStart() {} }] }, { limit: 2 })) history.push(item);
      assert.equal(history.length, 2);
      assert.equal(history[0].values.answer, false);
      assert.ok(history[0].config.configurable.checkpoint_id);
      assert.ok(history[0].parentConfig);
    });
  } else if (phase === 'absence') {
    await check('negative control: fresh empty storage contains no recovered graph state', async () => {
      const empty = new TestOnlyPersistentSaver(join(home, 'empty.wire'));
      assert.equal(await empty.getTuple(config('parallel')), undefined);
      assert.deepEqual((await parallelGraph(empty, home, false).getState(config('parallel'))).values, {});
    });
  } else if (phase === 'faults') {
    for (const method of ['getTuple', 'put', 'putWrites']) await check(`${method} transport failure rejects graph invocation`, async () => {
      const broken = new TestOnlyPersistentSaver(join(home, `${method}.wire`), method);
      const state = Annotation.Root({ value: Annotation() });
      const graph = new StateGraph(state).addNode('node', () => ({ value: 1 })).addEdge(START, 'node').addEdge('node', END).compile({ checkpointer: broken });
      await assert.rejects(graph.invoke({ value: 0 }, config('failure')), new RegExp(`injected saver ${method}`));
    });
    await check('public Send class is rejected rather than revived (v1 static graph restriction)', () => {
      assert.throws(() => codec.encode(new Send('node', { x: 1 })), /class or prototype/);
    });
    await check('record partial-abort counterexample separately from completed-sibling recovery', async () => {
      await assert.rejects(parallelGraph(saver, home, 'immediate', 'partial-').invoke({ results: [] }, config('partial')), /injected parallel failure/);
      const before = await saver.getTuple(config('partial'));
      const partial = before.pendingWrites.find((w) => w[1] === 'results');
      assert.ok(partial);
      assert.ok(before.pendingWrites.some((w) => w[0] === partial[0] && w[1] === ERROR));
      assert.ok(!before.pendingWrites.some((w) => w[0] === partial[0] && w[1].startsWith('join:')));
      const recovered = await parallelGraph(saver, home, false, 'partial-').invoke(null, config('partial'));
      assert.deepEqual([...recovered.results].sort(), ['completed', 'recovered']);
      assert.equal(existsSync(join(home, 'partial-join.count')), false);
      observations.partialAbort = {
        limitation: 'An aborted task with a partial output write is treated as cached on resume; its missing barrier write is not reconstructed.',
        pendingWrites: before.pendingWrites, resumedResult: recovered,
        completedInvocations: Number(readFileSync(join(home, 'partial-completed.count'), 'utf8')),
        joinInvocations: 0, productionGate: 'Resolve before arbitrary failure/crash recovery is admitted; no private patch applied.',
      };
    });
    await check('partial-abort counterexample also occurs with unmodified public MemorySaver', async () => {
      const baseline = new MemorySaver();
      await assert.rejects(parallelGraph(baseline, home, 'immediate', 'baseline-').invoke({ results: [] }, config('baseline')), /injected parallel failure/);
      const before = await baseline.getTuple(config('baseline'));
      const result = await parallelGraph(baseline, home, false, 'baseline-').invoke(null, config('baseline'));
      assert.deepEqual([...result.results].sort(), ['completed', 'recovered']);
      assert.equal(existsSync(join(home, 'baseline-join.count')), false);
      observations.publicMemorySaverBaseline = { pendingWrites: before.pendingWrites, result, joinInvocations: 0 };
    });
    await check('unsupported checkpoint v3 fails before persistence', async () => {
      await assert.rejects(saver.put(config('old'), { ...checkpoint('0001'), v: 3 }, metadata, newVersions), /unsupported checkpoint version/);
      assert.equal(await saver.getTuple(config('old')), undefined);
    });
  } else throw new Error(`Unknown child phase ${phase}`);
}

async function main() {
  if (process.argv[2] === '--child') {
    try { await child(process.argv[3], process.argv[4]); }
    catch (error) { process.exitCode = 1; console.error(error.stack); }
    console.log(JSON.stringify({ phase: process.argv[3], pid: process.pid, assertions, observations, passed: process.exitCode !== 1 }));
    return;
  }
  assert.equal(process.argv.length, 2, 'Usage: node scripts/probe-graph-saver.mjs');
  const fixture = createGraphTestEnv();
  const token = randomUUID();
  const ownerPath = join(fixture.home, 'probe-owner.json');
  writeFileSync(ownerPath, JSON.stringify({ parentPid: process.pid, token }), { flag: 'wx', mode: 0o600 });
  const results = [];
  const result = { testOnly: true, node: process.version, versions, productionReady: false, parentPid: process.pid, phases: results, assertions, passed: false, cleaned: false };
  try {
    for (const phase of ['contract-write', 'contract-read', 'fail', 'recover', 'interrupt', 'resume', 'absence', 'faults']) {
      const run = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--child', phase, fixture.home], {
        env: { ...fixture.env, GRAPH_SAVER_PROBE_TOKEN: token, LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' },
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576, killSignal: 'SIGKILL',
      });
      const output = run.stdout?.trim();
      let report;
      try { report = JSON.parse(output); } catch { report = { phase, stdout: output }; }
      results.push({ ...report, exitCode: run.status, signal: run.signal, stderr: run.stderr, ...(run.error ? { error: String(run.error) } : {}) });
      assert.equal(run.status, 0, `${phase} failed`);
      assert.equal(report.passed, true);
    }
    await check('all phases executed in separate processes with exited writers before readers', () => {
      assert.equal(new Set(results.map((r) => r.pid)).size, results.length);
      assert.ok(results.every((r) => r.pid !== process.pid));
    });
    result.storeSha256 = createHash('sha256').update(readFileSync(join(fixture.home, 'saver.wire'))).digest('hex');
    result.passed = true;
  } catch (error) { result.error = String(error); process.exitCode = 1; }
  finally {
    // Delete only the fixture allocated by this invocation, after bounded children exit.
    const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
    assert.equal(owner.token, token); assert.equal(owner.parentPid, process.pid);
    assert.equal(realpathSync(fixture.home), fixture.home);
    assert.ok(!lstatSync(fixture.home).isSymbolicLink());
    fixture.cleanup(); result.cleaned = !existsSync(fixture.home);
    console.log(JSON.stringify(result, null, 2));
  }
}
await main();
