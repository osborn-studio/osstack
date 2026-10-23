#!/usr/bin/env node
// TEST ONLY: deterministic, bounded public-API C2 recovery investigation.
// Passing assertions include known failures. admitted remains false.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertIsolatedHome, createGraphTestEnv } from './graph-test-env.mjs';
import { checkpointApi, engine, JournalSaver, persist, read, requireGraph } from './fixtures/graph-c2-runtime.mjs';
import { assertCanStart, trustedResult } from './fixtures/graph-c2-ledger.mjs';
const { Annotation, StateGraph, START, END, MemorySaver, entrypoint, task, interrupt, Command } = engine;
const { ERROR, INTERRUPT } = checkpointApi;
const versions = Object.fromEntries(['langgraph', 'langgraph-checkpoint', 'core'].map((n) => [n, requireGraph(`@langchain/${n}/package.json`).version]));
assert.deepEqual(versions, { langgraph: '1.4.15', 'langgraph-checkpoint': '1.1.5', core: '1.2.11' });
const config = { configurable: { thread_id: 'c2' } };
const full = ['completed', 'recovered', 'joined'];
const defer = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const assertions = [];
const programIdentity = (spec) => ({ executionModel: spec.api, versions, compiler: 'test-fixture-v1', schema: 'json-results-v1',
  orderedTaskSchedule: ['completed', 'flaky', 'join'], digest: createHash('sha256').update(JSON.stringify(spec)).digest('hex') });
async function check(name, fn) {
  try { await fn(); assertions.push({ name, passed: true }); }
  catch (error) { assertions.push({ name, passed: false, error: String(error) }); throw error; }
}
function stateGraph(saver, completed, flaky, joined) {
  // Preserve G07's concat reducer and actual AND edge as the control.
  const state = Annotation.Root({ results: Annotation({ reducer: (a, b) => a.concat(b), default: () => [] }) });
  return new StateGraph(state)
    .addNode('completed', completed)
    .addNode('flaky', flaky, { retryPolicy: { maxAttempts: 1 } })
    .addNode('join', (s) => joined(s.results))
    .addEdge(START, 'completed').addEdge(START, 'flaky')
    .addEdge(['completed', 'flaky'], 'join').addEdge('join', END).compile({ checkpointer: saver });
}
const isCompleted = (writes) => writes.some(([channel, value]) =>
  channel === 'results' ? Array.isArray(value) && value[0] === 'completed'
    : value?.results?.[0] === 'completed');
function partialSummary(tuple) {
  const output = tuple?.pendingWrites?.find((w) => w[1] === 'results' && w[2][0] === 'completed');
  const sameTask = tuple?.pendingWrites?.filter((w) => w[0] === output?.[0]) ?? [];
  return { outputError: !!output && sameTask.some((w) => w[1] === ERROR),
    // Observe only: never construct/write an engine-generated channel name.
    notificationMissing: !!output && sameTask.every((w) => w[1] === 'results' || w[1] === ERROR),
    pendingWrites: tuple?.pendingWrites ?? [] };
}
async function memoryExperiments() {
  const rows = [];
  for (const durability of ['sync', 'async', 'exit']) for (const maxConcurrency of [1, 2]) {
    const saver = new MemorySaver(); const counts = { completed: 0, flaky: 0, join: 0 };
    const build = (fail) => stateGraph(saver,
      () => { counts.completed++; return { results: ['completed'] }; },
      async () => { counts.flaky++; if (fail) throw Error('injected parallel failure'); return { results: ['recovered'] }; },
      () => { counts.join++; return { results: ['joined'] }; });
    let error = null; let initialResult = null;
    try { initialResult = await build(true).invoke({ results: [] }, { ...config, durability, maxConcurrency }); } catch (e) { error = String(e); }
    const before = await saver.getTuple(config);
    const initialCounts = { ...counts };
    const result = await build(false).invoke(null, config);
    const row = { kind: 'unmodified-MemorySaver', durability, maxConcurrency, error, initialResult, initialCounts, ...partialSummary(before), counts, result };
    rows.push(row);
    await check(`MemorySaver ${durability}/${maxConcurrency} control`, () => {
      assert.equal(counts.completed, 1);
      if (maxConcurrency === 2) {
        assert.match(error, /injected parallel failure/);
        assert.equal(row.outputError, true); assert.equal(row.notificationMissing, true);
        assert.equal(counts.join, 0); assert.deepEqual(result.results, ['completed', 'recovered']);
      } else {
        // This pin stops after the first task at concurrency=1. It has not even
        // reached the failing branch; null invocation completes it later.
        assert.equal(initialCounts.flaky, 0); assert.equal(initialCounts.join, 0);
        assert.deepEqual(initialResult.results, []);
        assert.deepEqual(result.results, full); assert.equal(counts.join, 1);
      }
    });
  }
  for (const recovery of ['update-latest', 'update-exact', 'bulk-exact', 'resume-then-empty']) {
    const saver = new MemorySaver(); const counts = { completed: 0, flaky: 0, join: 0 };
    // Independent fixture authority; never derive this row from a checkpoint.
    let confirmed;
    const build = (fail) => stateGraph(saver,
      () => { counts.completed++; confirmed = { run: 'memory', effect: 'completed', attempt: 1, status: 'confirmed', result: { results: ['completed'] } }; return confirmed.result; },
      async () => { counts.flaky++; if (fail) throw Error('injected parallel failure'); return { results: ['recovered'] }; },
      () => { counts.join++; return { results: ['joined'] }; });
    await assert.rejects(build(true).invoke({ results: [] }, config), /injected parallel failure/);
    const before = await saver.getTuple(config); const graph = build(false);
    const trusted = trustedResult(confirmed, { run: 'memory', effect: 'completed', attempt: 1 });
    let next;
    if (recovery === 'update-latest') next = await graph.updateState(config, trusted, 'completed');
    if (recovery === 'update-exact') next = await graph.updateState(before.config, trusted, 'completed');
    if (recovery === 'bulk-exact') next = await graph.bulkUpdateState(before.config, [{ updates: [{ values: trusted, asNode: 'completed' }] }]);
    if (recovery === 'resume-then-empty') {
      const stalled = await graph.invoke(null, config);
      assert.deepEqual(stalled.results, ['completed', 'recovered']);
      assert.equal(stalled.results.filter((x) => x === trusted.results[0]).length, 1);
      next = await graph.updateState(config, {}, 'completed');
    }
    const result = await graph.invoke(null, next);
    const original = await saver.getTuple(before.config);
    assert.deepEqual(original.pendingWrites.filter((w) => w[1] === ERROR), before.pendingWrites.filter((w) => w[1] === ERROR));
    rows.push({ kind: 'state-repair', recovery, counts, result, originalCheckpoint: before.config,
      repairCheckpoint: next, originalErrorsRetained: true, bulkApiMarkedInternal: recovery === 'bulk-exact' });
    await check(`StateGraph ${recovery} outcome`, () => {
      assert.equal(counts.completed, 1);
      if (recovery === 'resume-then-empty') { assert.equal(counts.join, 1); assert.deepEqual(result.results, full); }
      else { assert.equal(counts.join, 0); assert.equal(counts.flaky, 1); }
    });
  }
  return rows;
}
function count(home, key) {
  const path = join(home, 'counts.wire');
  const counts = existsSync(path) ? read(path) : {};
  counts[key] = (counts[key] ?? 0) + 1; persist(path, counts); return counts[key];
}
function effects(home, run) {
  const path = join(home, 'effects.wire');
  return {
    get: (name) => existsSync(path) ? read(path)[name] : undefined,
    execute(name, beforeConfirm) {
      const all = existsSync(path) ? read(path) : {};
      if (all[name]) return trustedResult(all[name], { run, effect: name, attempt: 1 });
      assertCanStart(all, run);
      all[name] = { run, effect: name, attempt: 1, status: 'started' }; persist(path, all);
      count(home, `${name}Body`);
      beforeConfirm?.();
      all[name] = { ...all[name], status: 'confirmed', result: { results: [name] } }; persist(path, all);
      return trustedResult(all[name], { run, effect: name, attempt: 1 });
    },
  };
}
function killAt(home, window) {
  persist(join(home, 'kill.wire'), { pid: process.pid, window, actualSignal: 'SIGKILL' });
  process.kill(process.pid, 'SIGKILL');
  throw Error('SIGKILL unexpectedly returned');
}
async function child(phase, home, spec) {
  const owner = read(join(home, 'owner.wire'));
  assert.deepEqual(read(join(home, 'program.wire')), programIdentity(spec));
  assert.equal(owner.token, process.env.GRAPH_C2_TOKEN); assert.equal(owner.parentPid, process.ppid);
  assert.equal(realpathSync(home), assertIsolatedHome(process.env.OSSTACK_HOME));
  const saver = await JournalSaver.open(join(home, 'journal.wire'));
  const ledger = effects(home, spec.name); const controller = new AbortController();
  const saved = defer(); const started = defer(); const release = defer();
  const isSeed = phase === 'seed'; let rejected = false; let backgroundAfterReject = false;
  let backgroundDone = Promise.resolve(); let saveReached = false;
  const marker = (name) => persist(join(home, `${name}.wire`), { pid: process.pid, window: spec.window });
  const completed = () => {
    count(home, 'completedWrapper');
    const value = ledger.execute('completed', () => {
      if (isSeed && spec.window === 'unknown-effect-crash') killAt(home, spec.window);
    });
    if (isSeed && spec.window === 'effect-confirmed-crash') killAt(home, spec.window);
    return value;
  };
  const flaky = async () => {
    count(home, 'flakyAttempts'); started.resolve();
    if (isSeed) {
      if (spec.window === 'immediate' || spec.window.startsWith('repair-')) throw Error('injected parallel failure');
      await saved.promise;
      if (['full-writes-error', 'recovery-second-kill', 'recovery-second-kill-ungated', 'repair-before', 'repair-after'].includes(spec.window)) throw Error('injected after completed writes');
      if (spec.window === 'cancel') {
        await new Promise((_, reject) => {
          if (controller.signal.aborted) reject(controller.signal.reason);
          else controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
        });
      }
      if (spec.window === 'timeout') {
        await release.promise; backgroundAfterReject = rejected; marker('background-after-reject');
      }
      if (spec.window === 'cancel-worker-kill') {
        await new Promise((r) => setTimeout(r, 1500));
        marker('late-effect');
        return ledger.execute('recovered');
      }
      if (spec.window === 'cancel-uncooperative') {
        await release.promise;
        backgroundAfterReject = rejected;
        marker('background-after-reject');
        return ledger.execute('recovered');
      }
    }
    return ledger.execute('recovered');
  };
  const joined = async (results) => {
    // Pin the second-crash window before the join body. Task return persistence
    // may overlap downstream scheduling; a test gate makes this cut explicit.
    if (phase === 'recover' && spec.window === 'recovery-second-kill') await new Promise(() => {});
    count(home, 'joinWrapper');
    assert.deepEqual([...results].sort(), ['completed', 'recovered']);
    const value = ledger.execute('joined');
    if (isSeed && spec.window === 'join-effect-confirmed-crash') killAt(home, spec.window);
    return value;
  };
  let graph;
  if (spec.api === 'state') graph = stateGraph(saver, completed, flaky, joined);
  else {
    const a = task({ name: 'completed', retry: { maxAttempts: 1 } }, completed);
    const b = task({ name: 'flaky', retry: { maxAttempts: 1 }, ...(isSeed && spec.window === 'timeout' ? { timeout: 80 } : {}) }, flaky);
    const j = task('join', joined);
    graph = entrypoint({ name: 'c2-static', checkpointer: saver }, async () => {
      // Stable, unconditional call order. Only tasks perform fixture effects.
      const ap = a(); const bp = b();
      backgroundDone = bp.catch(() => {});
      const values = await Promise.all([ap, bp]);
      const results = values.flatMap((v) => v.results);
      const approval = spec.window === 'interrupt-false' ? interrupt({ question: 'continue?', choices: [false, true] }) : null;
      const final = await j(results);
      return { results: [...results, ...final.results], ...(spec.window === 'interrupt-false' ? { approval } : {}) };
    });
  }
  if (isSeed) {
    saver.beforeWrites = (writes) => {
      if (isCompleted(writes) && spec.window === 'before-return-write-crash') killAt(home, spec.window);
    };
    saver.afterWrites = async (writes) => {
      // Functional task RETURN is a single public write. State control waits
      // for the full batch: its output plus another engine-emitted write.
      const fullBatch = spec.api === 'functional' ? isCompleted(writes) : isCompleted(writes) && writes.length > 1;
      if (!fullBatch || saveReached) return;
      saveReached = true; marker('completed-saved'); saved.resolve();
      if (spec.window === 'after-return-write-crash') killAt(home, spec.window);
      if (spec.window.startsWith('cancel')) {
        await started.promise;
        controller.abort(new Error('injected external cancel'));
      }
    };
    if (spec.window === 'join-return-crash') saver.afterWrites = (writes) => {
      if (writes.some(([, value]) => value?.results?.[0] === 'joined')) killAt(home, spec.window);
      if (isCompleted(writes)) { saveReached = true; saved.resolve(); }
    };
    if (spec.window === 'before-final-checkpoint-crash') saver.beforePut = ({ metadata }) => {
      if (metadata.source === 'loop') killAt(home, spec.window);
    };
    if (spec.window === 'after-final-checkpoint-crash') saver.afterPut = ({ metadata }) => {
      if (metadata.source === 'loop') killAt(home, spec.window);
    };
    let error = null; let result = null;
    try { result = await graph.invoke({ results: [] }, { ...config, durability: spec.durability, signal: controller.signal }); }
    catch (e) { error = { name: e.name, message: e.message }; rejected = true; }
    if (spec.window === 'cancel-worker-kill') {
      assert.ok(error);
      marker('cancel-rejected');
      persist(join(home, 'kill.wire'), { pid: process.pid, window: spec.window, actualSignal: 'SIGKILL' });
      process.send({ readyForParentKill: true });
      await new Promise(() => {});
    }
    if (spec.window === 'timeout' || spec.window === 'cancel-uncooperative') {
      release.resolve(); await backgroundDone;
      // task timeout can settle its wrapper before the user promise; one turn
      // drains this deterministic, released body before child exit.
      await new Promise((r) => setImmediate(r));
    }
    if (spec.window === 'cancel') await backgroundDone;
    const before = await saver.getTuple(config);
    persist(join(home, 'before.wire'), before);
    persist(join(home, 'seed.wire'), { pid: process.pid, error, result, backgroundAfterReject });
    if (spec.window === 'interrupt-false') {
      assert.equal(error, null); assert.equal(result[INTERRUPT].length, 1);
      assert.equal(read(join(home, 'counts.wire')).joinedBody ?? 0, 0);
    } else assert.ok(error, `${spec.window} must reject in seed`);
    if (spec.api === 'state' && spec.window === 'immediate') {
      assert.equal(partialSummary(before).outputError, true);
      assert.equal(partialSummary(before).notificationMissing, true);
    }
    return { phase, pid: process.pid, error, result, backgroundAfterReject, before: partialSummary(before), counts: read(join(home, 'counts.wire')) };
  }
  const before = await saver.getTuple(config);
  if (spec.window === 'unknown-effect-crash') {
    let reconciliationErrors;
    await assert.rejects(graph.invoke(null, { ...config, durability: spec.durability }), (error) => {
      const errors = error instanceof AggregateError ? error.errors : [error];
      reconciliationErrors = errors.map((item) => item.message);
      assert.ok(reconciliationErrors.length > 0 && reconciliationErrors.every((message) => /reconcile/.test(message)));
      return true;
    });
    const counts = read(join(home, 'counts.wire'));
    assert.equal(counts.completedBody, 1); assert.equal(counts.joinedBody ?? 0, 0);
    assert.equal(counts.recoveredBody ?? 0, 0); assert.equal(counts.completedWrapper, 2);
    return { phase, pid: process.pid, reconciled: false, blockedUnknown: true, reconciliationErrors, counts };
  }
  if (phase === 'recover' && spec.window.startsWith('recovery-second-kill')) saver.afterWrites = (writes) => {
    if (writes.some(([, value]) => value?.results?.[0] === 'recovered')) killAt(home, spec.window);
  };
  let result;
  if (spec.window === 'interrupt-false') {
    const pauses = (before.pendingWrites ?? []).filter((w) => w[1] === INTERRUPT);
    assert.equal(pauses.length, 1);
    result = await graph.invoke(new Command({ resume: { [pauses[0][2].id]: false } }), { ...config, durability: spec.durability });
    assert.equal(result.approval, false);
  } else if (phase === 'repair' || phase === 'repair-recover') {
    const state = await graph.getState(config);
    assert.deepEqual(state.values.results, ['completed', 'recovered']);
    const trusted = trustedResult(ledger.get('completed'), { run: spec.name, effect: 'completed', attempt: 1 });
    assert.equal(state.values.results.filter((x) => x === trusted.results[0]).length, 1);
    if (phase === 'repair' && spec.window === 'repair-before') saver.beforePut = ({ metadata }) => { if (metadata.source === 'update') killAt(home, spec.window); };
    if (phase === 'repair' && spec.window === 'repair-after') saver.afterPut = ({ metadata }) => { if (metadata.source === 'update') killAt(home, spec.window); };
    const next = phase === 'repair-recover' && state.next.includes('join')
      ? config : await graph.updateState(config, {}, 'completed');
    result = await graph.invoke(null, next);
  } else result = await graph.invoke(null, { ...config, durability: spec.durability });
  const counts = read(join(home, 'counts.wire'));
  const state = await graph.getState(config);
  if (spec.api === 'state' && ['immediate', 'repair-before', 'repair-after'].includes(spec.window) && phase === 'recover') {
    assert.deepEqual(result.results, ['completed', 'recovered']); assert.equal(counts.joinedBody ?? 0, 0);
  } else {
    assert.deepEqual(result.results, full); assert.equal(counts.joinedBody, 1);
    assert.equal(counts.recoveredBody, 1);
    assert.equal(counts.completedBody, 1); assert.deepEqual(state.next, []);
    assert.equal(counts.joinWrapper, ['join-effect-confirmed-crash', 'recovery-second-kill-ungated'].includes(spec.window) ? 2 : 1);
    // A second null resume is a no-op, not a hidden rerun of the join task.
    await graph.invoke(null, { ...config, durability: spec.durability });
    assert.deepEqual(read(join(home, 'counts.wire')), counts);
    const history = [];
    for await (const item of graph.getStateHistory(config, { limit: 3 })) history.push(item);
    assert.ok(history.length > 0, 'public list history round-trips through the codec');
  }
  return { phase, pid: process.pid, result, counts, next: state.next, before: partialSummary(before) };
}
async function main() {
  if (process.argv[2] === '--child') {
    try { const report = await child(process.argv[3], process.argv[4], JSON.parse(process.argv[5])); console.log(JSON.stringify({ ...report, passed: true })); }
    catch (error) { console.error(error.stack); process.exitCode = 1; }
    return;
  }
  const evidence = process.env.GRAPH_C2_EVIDENCE ? resolve(process.env.GRAPH_C2_EVIDENCE)
    : mkdtempSync(join(tmpdir(), 'osstack-graph-c2-evidence-'));
  mkdirSync(evidence, { recursive: true });
  const report = { testOnly: true, admitted: false, passed: false, versions, node: process.version, assertions, memory: [], experiments: [], limitations: [
    'No production identity, atomic effect store, worker fencing, repair pointer or power-loss proof.',
    'The public-call journal is a bounded single-writer test fixture; MemorySaver itself is not persistent.',
    'Uncooperative task cancellation is explicitly a negative control, not safe automatic cancellation.',
  ] };
  try {
    report.memory = await memoryExperiments();
    if (process.argv.includes('--red-control')) {
      const control = report.memory.find((row) => row.kind === 'unmodified-MemorySaver' && row.maxConcurrency === 2);
      assert.equal(control.counts.join, 1, 'RED: baseline does not recover the actual AND join');
      throw Error('known-failure RED unexpectedly passed');
    }
    const specs = [];
    for (const durability of ['sync', 'async']) {
      for (const window of ['immediate', 'full-writes-error', 'repair-before', 'repair-after']) specs.push({ api: 'state', window, durability });
      for (const window of ['immediate', 'full-writes-error', 'effect-confirmed-crash', 'before-return-write-crash', 'after-return-write-crash', 'join-return-crash', 'join-effect-confirmed-crash', 'before-final-checkpoint-crash', 'unknown-effect-crash', 'cancel', 'timeout', 'cancel-uncooperative', 'cancel-worker-kill', 'recovery-second-kill', 'recovery-second-kill-ungated', 'after-final-checkpoint-crash', 'interrupt-false']) {
        specs.push({ api: 'functional', window, durability });
      }
    }
    for (const spec of specs) {
      spec.name = `${spec.api}-${spec.durability}-${spec.window}`;
      const env = createGraphTestEnv(); const token = randomUUID();
      persist(join(env.home, 'owner.wire'), { token, parentPid: process.pid });
      persist(join(env.home, 'program.wire'), programIdentity(spec));
      const entry = { ...spec, processes: [], cleaned: false };
      report.experiments.push(entry);
      const run = async (phase, expectedSignal = null) => {
        const args = [fileURLToPath(import.meta.url), '--child', phase, env.home, JSON.stringify(spec)];
        const options = {
          env: { ...env.env, GRAPH_C2_TOKEN: token, LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' },
          encoding: 'utf8', timeout: 8_000, killSignal: 'SIGKILL', maxBuffer: 1_048_576,
        };
        let parentSignaled = false;
        const result = spec.window === 'cancel-worker-kill' && phase === 'seed'
          ? await new Promise((resolveRun) => {
            const child = spawn(process.execPath, args, { env: options.env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
            let stdout = ''; let stderr = ''; let error;
            const timeout = setTimeout(() => { error = Error('child runtime timeout'); child.kill('SIGKILL'); }, 8000);
            const collect = (key, chunk) => {
              if (key === 'stdout') stdout += chunk; else stderr += chunk;
              if (stdout.length + stderr.length > 1_048_576) { error = Error('child output bound'); child.kill('SIGKILL'); }
            };
            child.stdout.on('data', (v) => collect('stdout', v)); child.stderr.on('data', (v) => collect('stderr', v));
            child.on('error', (e) => { error = e; });
            child.on('message', (message) => {
              if (message.readyForParentKill) { parentSignaled = child.kill('SIGKILL'); }
            });
            child.on('close', (status, signal) => { clearTimeout(timeout); resolveRun({ status, signal, stdout, stderr, error }); });
          }) : spawnSync(process.execPath, args, options);
        let data = null;
        if (result.stdout?.trim()) { try { data = JSON.parse(result.stdout); } catch {} }
        entry.processes.push({ phase, parentSignaled, exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : null, stderr: result.stderr, report: data });
        writeFileSync(join(evidence, `${spec.name}-${phase}.json`), JSON.stringify(entry.processes.at(-1), null, 2));
        // The child has exited: capture each crash cut BEFORE recovery can
        // mutate counts, effects, or checkpoint history.
        const restoredSaver = await JournalSaver.open(join(env.home, 'journal.wire'));
        const taskReturns = [];
        for await (const tuple of restoredSaver.list(config)) {
          for (const [taskId, channel, value] of tuple.pendingWrites ?? []) {
            // Observe the emitted RETURN name, never synthesize a write.
            if (channel === '__return__') taskReturns.push({ checkpoint: tuple.config, taskId, value });
          }
        }
        const cut = { taskReturns, counts: existsSync(join(env.home, 'counts.wire')) ? read(join(env.home, 'counts.wire')) : {},
          effects: existsSync(join(env.home, 'effects.wire')) ? read(join(env.home, 'effects.wire')) : {},
          tuple: (await restoredSaver.getTuple(config)) ?? null };
        writeFileSync(join(evidence, `${spec.name}-${phase}-cut.json`), JSON.stringify(cut, null, 2));
        if (spec.api === 'functional' && phase === 'seed') {
          const returned = (name) => taskReturns.some((row) => row.value?.results?.[0] === name);
          const missingCompleted = ['effect-confirmed-crash', 'before-return-write-crash', 'unknown-effect-crash'].includes(spec.window);
          assert.equal(returned('completed'), !missingCompleted, 'actual seed completed RETURN evidence');
          assert.equal(cut.counts.completedWrapper, 1);
          if (['cancel', 'timeout', 'cancel-uncooperative', 'cancel-worker-kill'].includes(spec.window)) {
            assert.equal(returned('recovered'), false, 'late user result did not become a cached task RETURN');
            assert.equal(cut.counts.flakyAttempts, 1);
          }
        }
        if (spec.window === 'recovery-second-kill-ungated' && phase === 'recover') {
          assert.equal(cut.counts.joinedBody, 1);
          assert.equal(cut.tuple.pendingWrites.some(([, , value]) => value?.results?.[0] === 'joined'), false);
          entry.joinEffectConfirmedWithoutReturn = true;
        }
        assert.equal(result.error, undefined, `${spec.name}/${phase} timeout or spawn error`);
        if (expectedSignal) {
          assert.equal(result.signal, expectedSignal); assert.equal(read(join(env.home, 'kill.wire')).window, spec.window);
          entry.processes.at(-1).kill = read(join(env.home, 'kill.wire'));
        } else { assert.equal(result.status, 0, `${spec.name}/${phase}: ${result.stderr}`); assert.equal(data.passed, true); }
        writeFileSync(join(evidence, `${spec.name}-${phase}.json`), JSON.stringify(entry.processes.at(-1), null, 2));
        return data;
      };
      try {
        await run('seed', spec.window.endsWith('crash') || spec.window === 'cancel-worker-kill' ? 'SIGKILL' : null);
        if (spec.window === 'cancel-worker-kill') {
          assert.equal(entry.processes[0].parentSignaled, true);
          assert.equal(existsSync(join(env.home, 'late-effect.wire')), false);
          assert.equal(read(join(env.home, 'counts.wire')).recoveredBody ?? 0, 0);
          entry.confirmedExitBeforeRecovery = true;
        }
        await check(`${spec.name}: fresh process recovery`, async () => {
          if (spec.window.startsWith('recovery-second-kill')) await run('recover', 'SIGKILL');
          const recovered = await run(spec.window.startsWith('recovery-second-kill') ? 'recover-again' : 'recover');
          if (spec.window === 'interrupt-false') assert.equal(recovered.counts.flakyAttempts, 1);
          if (['cancel', 'timeout', 'cancel-uncooperative', 'cancel-worker-kill'].includes(spec.window)) assert.equal(recovered.counts.flakyAttempts, 2);
          if (['effect-confirmed-crash', 'before-return-write-crash'].includes(spec.window)) assert.equal(recovered.counts.completedWrapper, 2);
          const pids = entry.processes.map((p) => p.report?.pid ?? p.kill?.pid);
          assert.equal(new Set(pids).size, pids.length); assert.ok(pids.every((p) => p && p !== process.pid));
          if (['cancel-uncooperative', 'timeout'].includes(spec.window)) assert.equal(entry.processes[0].report.backgroundAfterReject, true);
          if (spec.api === 'functional' && !['effect-confirmed-crash', 'before-return-write-crash', 'unknown-effect-crash'].includes(spec.window)) {
            assert.equal(recovered.counts.completedWrapper, 1, 'durably returned completed task body does not re-enter');
          }
        });
        if (spec.window.startsWith('repair-')) {
          await run('repair', 'SIGKILL');
          await check(`${spec.name}: resume interrupted public repair`, async () => { await run('repair-recover'); });
        }
      } finally {
        // Preserve raw fixture state even on failed assertions, before cleanup.
        try {
          for (const file of ['journal.wire', 'effects.wire', 'counts.wire', 'before.wire', 'kill.wire', 'program.wire']) {
            if (existsSync(join(env.home, file))) writeFileSync(join(evidence, `${spec.name}-${file}.json`), JSON.stringify(read(join(env.home, file)), null, 2));
          }
        } finally {
          const owner = read(join(env.home, 'owner.wire'));
          assert.equal(owner.token, token); assert.equal(owner.parentPid, process.pid);
          assert.equal(realpathSync(env.home), env.home); assert.equal(lstatSync(env.home).isSymbolicLink(), false);
          env.cleanup(); entry.cleaned = !existsSync(env.home);
        }
      }
      writeFileSync(join(evidence, 'experiments.json'), JSON.stringify(report, null, 2));
    }
    report.passed = true;
  } catch (error) { report.error = String(error); process.exitCode = 1; }
  finally {
    writeFileSync(join(evidence, 'experiments.json'), JSON.stringify(report, null, 2));
    const summary = { passed: report.passed, admitted: false, node: report.node, versions, assertions: assertions.length,
      failedAssertions: assertions.filter((a) => !a.passed), experiments: report.experiments.length,
      processes: report.experiments.reduce((n, r) => n + r.processes.length, 0),
      actualSigkills: report.experiments.flatMap((r) => r.processes).filter((p) => p.signal === 'SIGKILL' && !p.error).length,
      cleaned: report.experiments.every((r) => r.cleaned), evidence, ...(report.error ? { error: report.error } : {}) };
    writeFileSync(join(evidence, 'summary.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
  }
}
await main();
