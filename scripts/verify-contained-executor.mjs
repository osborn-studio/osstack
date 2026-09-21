#!/usr/bin/env node
// Explicit opt-in real Docker test. Never inherits a Docker context, pulls images, or tests on a default control DB.
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createContainedCommandExecutor, createContainedCommandAdapter } from '../packages/agents/dist/index.js';
import { ContainedDocker } from '../packages/agents/dist/contained-docker.js';
import { executeCandidateImplementation, ExecutionPlan } from '../packages/loop/dist/index.js';
import { assertIsolatedHome } from './graph-test-env.mjs';
assertIsolatedHome(process.env.OSSTACK_HOME);
const [configPath, output] = process.argv.slice(2);
assert.ok(configPath && output && isAbsolute(configPath) && isAbsolute(output), 'explicit config/output paths required');
const config = JSON.parse(readFileSync(configPath));
const api = new ContainedDocker(config.socketPath);
const info = JSON.parse((await api.call('GET', '/info')).bytes); assert.equal(info.ID, config.daemonId); assert.equal(info.OSType, 'linux');
const root = mkdtempSync(join(process.env.OSSTACK_HOME, 'contained-real-'));
const report = { schemaVersion: 1, scope: 'Contained executor only; no G15/Graph recovery or full Linux suite admission',
  node: process.version, hostPlatform: process.platform, daemon: { id: info.ID, os: info.OperatingSystem, kernel: info.KernelVersion, version: info.ServerVersion }, imageId: config.imageId,
  startedAt: new Date().toISOString(), root, checks: [], passed: false };
const children = []; const containers = new Set();
const hash = id => createHash('sha256').update(id).digest('hex');
const save = () => writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); save();
function setup(name, command) {
  const journalRoot = join(root, name); mkdirSync(journalRoot);
  const options = { ...config, journalRoot, command, bindingRef: hash(name), timeoutMs: 10000 };
  const path = join(journalRoot, 'host.json'); writeFileSync(path, JSON.stringify(options));
  return { options: { ...options, authorize: () => {} }, path, journalRoot };
}
function host(f, mode, id) {
  const child = fork(fileURLToPath(new URL('./fixtures/contained-command-host.mjs', import.meta.url)), [f.path, mode, id], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
  children.push(child); return child;
}
const message = async child => (await once(child, 'message', { signal: AbortSignal.timeout(20000) }))[0];
async function kill(child) { if (child.exitCode === null && child.signalCode === null) { const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited; } }
async function until(fn) { for (let n = 0; n < 200; n++) { const value = await fn(); if (value) return value; await delay(50); } throw Error('REAL_TEST_TIMEOUT'); }
const launch = (f, id) => JSON.parse(readFileSync(join(f.journalRoot, hash(id), 'launch.json')));
async function inspect(id) { const r = await api.call('GET', `/containers/${id}/json`); return r.status === 200 ? JSON.parse(r.bytes) : null; }
async function check(name, fn) { await fn(); report.checks.push({ name, passed: true }); save(); console.log('PASS ' + name); }
try {
  await check('actual Loop candidate seam executes fixed image command and fresh host verifies stop', async () => {
    const f = setup('loop', 'echo bounded-command; test "$(id -u)" = 65534; test ! -w /; test ! -e /var/run/docker.sock');
    const adapter = await createContainedCommandAdapter(f.options);
    const result = await executeCandidateImplementation({ plan: ExecutionPlan.parse({ plan_id: 'contained-plan', agent_id: adapter.id, max_iterations: 1,
      task: { task_id: 'contained-task', capability: 'code.test', prompt: 'Host command is fixed', source: 'manual' }, stop_condition: { type: 'tests_pass' } }),
      workspace: { workspace_id: 'contained-fixture', workspace_path: f.journalRoot }, adapters: [adapter], cancellationGraceMs: 5000, authorize: async () => ({ allow: true }) });
    assert.equal(result.status, 'implementation_complete'); const runId = result.execution.run_id;
    assert.equal((await (await createContainedCommandExecutor(f.options)).confirmStopped(runId)).stopped, true);
    report.loopResult = result;
  });
  await check('SIGKILL supervisor; fresh process removes live PID namespace with detached session child', async () => {
    const f = setup('orphan', "trap '' TERM; setsid sh -c 'while :; do sleep 1; done' & while :; do sleep 1; done");
    const child = host(f, 'execute', 'orphan');
    const record = await until(async () => { const p = join(f.journalRoot, hash('orphan'), 'launch.json'); if (!existsSync(p)) return; const l = launch(f, 'orphan'); containers.add(l.containerId); if ((await inspect(l.containerId))?.State.Running) return l; });
    const top = JSON.parse((await api.call('GET', `/containers/${record.containerId}/top?ps_args=-eo%20pid,ppid,pgid,sid,args`)).bytes);
    assert.ok(top.Processes.length >= 3); const groups = new Set(top.Processes.map(row => row[2])); assert.ok(groups.size >= 2); report.detachedProcessObservation = top;
    await kill(child);
    assert.equal((await inspect(record.containerId)).State.Running, true);
    assert.deepEqual((await message(host(f, 'stop', 'orphan'))).ok, true);
    assert.equal(await inspect(record.containerId), null);
    assert.equal((await api.call('POST', `/containers/${record.containerId}/start`)).status, 404);
    assert.equal((await (await createContainedCommandExecutor(f.options)).confirmStopped('orphan')).stopped, true);
  });
  await check('paused original supervisor cannot start after fresh host removes recorded container', async () => {
    const f = setup('late', 'echo SHOULD_NOT_EXECUTE'); const child = host(f, 'pre-start', 'late');
    await until(() => existsSync(join(f.journalRoot, 'boundary.json'))); const record = launch(f, 'late'); containers.add(record.containerId);
    assert.equal((await inspect(record.containerId)).State.Status, 'created');
    assert.equal((await message(host(f, 'stop', 'late'))).ok, true);
    const done = message(child); child.kill('SIGCONT'); const result = await done;
    assert.equal(result.ok, false); assert.match(result.error, /CONTAINED_START_UNCONFIRMED/); assert.equal(await inspect(record.containerId), null);
  });
  for (const mode of ['post-create', 'post-delete']) await check(`${mode} crash stays unknown without durable completion`, async () => {
    const f = setup(mode, 'true'); const child = host(f, mode, mode);
    await until(() => existsSync(join(f.journalRoot, 'boundary.json'))); const boundary = JSON.parse(readFileSync(join(f.journalRoot, 'boundary.json')));
    const containerId = mode === 'post-create' ? JSON.parse(boundary.body).Id : launch(f, mode).containerId; containers.add(containerId); await kill(child);
    const executor = await createContainedCommandExecutor(f.options); assert.equal((await executor.confirmStopped(mode)).stopped, false);
    await assert.rejects(executor.stop(mode));
    if (mode === 'post-create') assert.equal((await inspect(containerId)).State.Status, 'created'); else assert.equal(await inspect(containerId), null);
    await assert.rejects(executor.execute(mode, new AbortController().signal), /EEXIST/);
  });
  await check('abort removes the exact live scope and persists independently verifiable stop', async () => {
    const f = setup('abort', 'while :; do sleep 1; done'); const executor = await createContainedCommandExecutor(f.options); const abort = new AbortController();
    const pending = executor.execute('abort', abort.signal);
    const record = await until(async () => { if (!existsSync(join(f.journalRoot, hash('abort'), 'launch.json'))) return; const l = launch(f, 'abort'); containers.add(l.containerId); if ((await inspect(l.containerId))?.State.Running) return l; });
    abort.abort(); assert.equal((await pending).cancelled, true); assert.equal(await inspect(record.containerId), null);
    assert.equal((await (await createContainedCommandExecutor(f.options)).confirmStopped('abort')).stopped, true);
  });
  report.passed = true;
} catch (error) { report.error = String(error); process.exitCode = 1; }
finally {
  await Promise.all(children.map(kill));
  // Cleanup only full IDs allocated by these test fixtures, including intentionally unknown windows.
  for (const id of containers) await api.call('DELETE', `/containers/${id}?force=true&v=true`);
  report.finishedAt = new Date().toISOString(); save(); console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, output }));
}
