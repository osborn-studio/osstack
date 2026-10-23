#!/usr/bin/env node
// Explicit, paid live-provider pilot. Fresh isolated home, real OSStack repository clone, actual
// built CLI daemon and public graph RPC. Never print or persist the API key.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync, appendFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { FrameDecoder, encodeFrame } from '../packages/hermes-adapter/dist/index.js';
import { createBoundedMessagesAdapter } from '../packages/agents/dist/index.js';
import { assertIsolatedHome } from './graph-test-env.mjs';

const parent = assertIsolatedHome(process.env.OSSTACK_HOME);
const [output, model] = process.argv.slice(2);
assert.ok(output && isAbsolute(output) && model && /^[\w.:-]+$/.test(model), 'Absolute report path and exact model ID required');
assert.ok(process.env.DEEPSEEK_API_KEY, 'Explicit DEEPSEEK_API_KEY required');
const baseUrl = process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com';
const key = process.env.DEEPSEEK_API_KEY;
// Validate before persisting even the endpoint; a URL must not embed a secret.
await createBoundedMessagesAdapter({ provider: 'deepseek', baseUrl, model, role: 'writer', files: ['scripts/graph-test-env.mjs'],
  acceptance: 'Validate endpoint configuration', apiKey: key, authorize: () => {} });
const redact = text => String(text).split(key).join('[REDACTED]');
mkdirSync(parent, { recursive: true, mode: 0o700 });
const root = realpathSync(mkdtempSync(join(parent, 'pilot-')));
const home = join(root, 'home'), repo = join(root, 'repo');
mkdirSync(home, { mode: 0o700 });
const sourceRepo = fileURLToPath(new URL('../', import.meta.url));
execFileSync('git', ['-c','core.hooksPath=/dev/null','clone','--no-hardlinks', sourceRepo, repo], { stdio: 'pipe' });
mkdirSync(join(repo, '.osstack'), { recursive: true });
const cli = fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url));
const git = (...args) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], {
  cwd: repo, encoding: 'utf8', env: { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
}).trim();
const targetFile = 'scripts/graph-test-env.mjs';
const original = readFileSync(join(repo, targetFile), 'utf8');
const guard = "  if (path === dirname(path)) throw new Error('Refusing filesystem root as test home');";
const expected = original.replace('  const path = canonical(home);', '  const path = canonical(home);\n' + guard);
assert.notEqual(expected, original);
writeFileSync(join(repo, '.osstack', 'policy.yaml'), 'schema_version: 1\nmode: execute\n');
git('add', '.osstack/policy.yaml'); git('-c', 'user.name=Graph Pilot', '-c', 'user.email=pilot@invalid', 'commit', '--allow-empty', '-qm', 'test: authorize isolated internal graph pilot');
const scope = { schemaVersion: 1, tenantId: 'local-pilot', principalId: 'owner', workspaceId: 'osstack-internal' };
const acceptance = "Fix scripts/graph-test-env.mjs assertIsolatedHome: immediately after const path = canonical(home); insert exactly this line: " + guard + " Preserve every other byte, exports and behavior. This rejects the filesystem root (including aliases that resolve to root), which currently passes the serving-home guard. Do not claim tests executed.";
// Static exact-change gate runs before importing any generated code. Behavioral
// checks then exercise root, a root alias, a normal isolated path and default home.
const acceptanceCode = `const fs=require("node:fs");const assert=require("node:assert/strict");const {pathToFileURL}=require("node:url");const {homedir}=require("node:os");const path=require("node:path");const expected=Buffer.from("${Buffer.from(expected).toString('base64')}","base64").toString();assert.equal(fs.readFileSync("scripts/graph-test-env.mjs","utf8"),expected);import(pathToFileURL(path.resolve("scripts/graph-test-env.mjs")).href).then(({assertIsolatedHome:check})=>{assert.throws(()=>check("/"),/filesystem root/);assert.throws(()=>check("/tmp/.."),/filesystem root/);assert.throws(()=>check(path.join(homedir(),".osstack")));const safe=fs.mkdtempSync(path.join(require("node:os").tmpdir(),"osstack-acceptance-"));try{assert.equal(check(safe),fs.realpathSync(safe));}finally{fs.rmdirSync(safe);}}).catch(e=>{console.error(e.message);process.exitCode=1;});`;
const command = `env -u DEEPSEEK_API_KEY -u ANTHROPIC_API_KEY node -e '${acceptanceCode}'`;
const config = { schemaVersion: 1, registration: { id: 'pilot-owner', scope, repositoryRef: 'repo', repositoryPath: repo, taskRef: 'safe-test-home',
  task: acceptance, inputArtifactRef: 'input',
  writer: { agentId: 'deepseek-bounded-writer', capabilityId: 'deepseek-bounded-writer.writer' },
  reviewer: { agentId: 'deepseek-bounded-reviewer', capabilityId: 'deepseek-bounded-reviewer.reviewer' },
  boundedMessages: { provider: 'deepseek', baseUrl, model, files: ['scripts/graph-test-env.mjs'], acceptance },
  acceptanceRegistry: [{ ref: 'closed-source-form', command, passExitCodes: [0], failExitCodes: [1] }],
  grant: { scope, expiresAt: Date.now() + 1200000, operations: ['read', 'execute', 'cancel', 'resume'] } } };
writeFileSync(join(home, 'graph-host.json'), JSON.stringify(config, null, 2), { mode: 0o600 });
const request = { schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'live-success', inputArtifactRef: 'input', source: { product: 'osstack', requestId: 'live-success' },
  spec: { schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only', input: { taskRef: 'safe-test-home', repositoryRef: 'repo', baseRevision: git('rev-parse', 'HEAD'), acceptanceRef: 'closed-source-form' },
    limits: { maxEpochs: 2, maxBranchAttempts: 1, maxConcurrentReaders: 2, maxConcurrentWritersPerRepo: 1, maxActionStarts: 14, deadlineSeconds: 600, tokenReservationLimit: 196608 } } };
const socketPath = join(home, 'daemon.sock');
assert.ok(Buffer.byteLength(socketPath) < 104, 'Pilot socket path is too long');
const env = { ...process.env, OSSTACK_HOME: home, OSSTACK_SOCKET: socketPath, TMPDIR: parent, OSSTACK_UPDATE_CHECK: '0',
  OSSTACK_POWER_POLICY: 'none', OSSTACK_CLOCK_MONITOR: 'monotonic-v1', OSSTACK_DASHBOARD_PORT: '0' };
delete env.OSSTACK_AGENT_PROFILE;
const report = { schemaVersion: 1, scope: 'G29 real OSStack internal patch: reject filesystem root in assertIsolatedHome; artifact only',
  root, home, model, baseUrl, startedAt: new Date().toISOString(), checks: [], passed: false };
const save = () => writeFileSync(output, redact(JSON.stringify(report, null, 2)) + '\n', { mode: 0o600 });
save();
const child = spawn(process.execPath, [cli, 'serve'], { cwd: repo, env, stdio: ['ignore','pipe','pipe'] });
const exited = new Promise(resolve => { child.once('exit', (code, signal) => resolve({ code, signal })); });
child.on('error', () => {});
for (const stream of [child.stdout, child.stderr]) stream.on('data', data => appendFileSync(join(root, 'daemon.log'), redact(data), { mode: 0o600 }));
async function rpc(method, params) {
  return await new Promise((resolve, reject) => {
    const socket = connect(socketPath); const decoder = new FrameDecoder();
    const finish = (error, result) => { clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(result); };
    const timer = setTimeout(() => finish(Error('PILOT_RPC_TIMEOUT')), 15000);
    socket.on('error', () => finish(Error('PILOT_RPC_UNAVAILABLE')));
    socket.on('connect', () => socket.write(encodeFrame({ id: 1, method, params })));
    socket.on('data', data => {
      for (const reply of decoder.push(data)) { finish(reply.ok ? null : Error(`PILOT_RPC_${String(reply.error?.code).replace(/[^A-Z_]/g, '')}`), reply.result); break; }
    });
  });
}
async function until(probe, timeout = 540000) {
  const deadline = Date.now() + timeout;
  for (;;) { const value = await probe(); if (value) return value; if (Date.now() > deadline) throw Error('PILOT_TIMEOUT'); await delay(200); }
}
const status = id => rpc('graph.status', { schemaVersion: 1, scope, graphRunId: id });
let database;
try {
  await until(async () => { if (child.exitCode !== null) throw Error('PILOT_DAEMON_EXITED'); try { return await rpc('health', {}); } catch { return false; } }, 30000);
  const health = await rpc('autonomy.health', {});
  report.health = { canRunLocal: health.can_run_local, writeBlockers: health.write_blockers, checks: health.checks }; save();
  assert.equal(health.can_run_local, true, 'Real autonomy health must allow local writes');
  const start = await rpc('graph.start', request); report.successRunId = start.graphRunId; save();
  const ready = await until(async () => {
    const value = await status(start.graphRunId);
    if (['failed','waiting_input','reconciliation_required','cancelled'].includes(value.status)) { report.unexpectedStatus = value; throw Error('PILOT_NOT_READY'); }
    return value.status === 'ready' && value;
  });
  assert.equal(readFileSync(join(repo, targetFile), 'utf8'), original);
  const candidatePath = join(home, 'graph-delivery', start.graphRunId, 'writer-0', targetFile);
  assert.equal(readFileSync(candidatePath, 'utf8'), expected);
  assert.equal((await rpc('graph.start', request)).graphRunId, start.graphRunId);
  const require = createRequire(new URL('../packages/core/package.json', import.meta.url));
  const Database = require('better-sqlite3');
  database = new Database(join(home, 'state.db'), { readonly: true });
  report.success = { status: ready, candidateSource: readFileSync(candidatePath, 'utf8'),
    actions: database.prepare('SELECT node_id,state,outcome_json FROM graph_actions WHERE graph_run_id=?').all(start.graphRunId) };
  const outcomes = new Map(report.success.actions.map(action => { assert.equal(action.state, 'confirmed'); return [action.node_id, JSON.parse(action.outcome_json)]; }));
  for (const node of ['workspace','implement','freeze','prepare_review','prepare_tests','review','tests']) assert.ok(outcomes.has(`e0.${node}`));
  assert.equal(outcomes.get('e0.implement').result.kind, 'implementation_complete');
  assert.equal(outcomes.get('e0.freeze').result.kind, 'candidate_ready');
  assert.equal(outcomes.get('e0.review').result.verdict, 'accept');
  assert.equal(outcomes.get('e0.tests').result.passed, true);
  const joinRow = database.prepare('SELECT receipt_ref,bundle_json FROM graph_verification_joins WHERE graph_run_id=? AND epoch=0').get(start.graphRunId);
  assert.equal(joinRow.receipt_ref, ready.resultRef); report.success.join = JSON.parse(joinRow.bundle_json);
  assert.equal(report.success.join.status, 'complete'); assert.deepEqual(report.success.join.missing, []);
  assert.equal(report.success.join.branches.length, 2);
  report.checks.push({ name: 'real daemon graph writer/freeze/reviewer/acceptance/join ready; source unchanged; replay stable', passed: true }); save();
  // An independent real reviewer must reject the original defective source.
  const reviewer = await createBoundedMessagesAdapter({ provider: 'deepseek', baseUrl, model, role: 'reviewer', apiKey: key, files: ['scripts/graph-test-env.mjs'], acceptance,
    authorize: path => { assert.equal(path, repo); } });
  const events = []; const reviewId = 'live-negative-review';
  for await (const event of reviewer.invoke({ run_id: reviewId, task_id: 'negative-review', session_id: 'independent-negative', capability_id: reviewer.capabilities()[0].id,
    prompt: 'Independently review this original candidate against the acceptance. Do not assume an implementation occurred.', context: { repo_path: repo } }, new AbortController().signal)) events.push(event);
  report.negativeReviewEvents = events; save();
  assert.equal(events.at(-1).payload.status, 'completed');
  const review = JSON.parse(events.find(e => e.type === 'token.delta').payload.delta);
  report.negativeReview = { review, stop: await reviewer.confirmStopped(reviewId), usage: events.find(e => e.type === 'usage.final')?.payload };
  save(); assert.equal(review.verdict, 'changes_requested'); assert.equal(report.negativeReview.stop.stopped, true);
  report.checks.push({ name: 'independent real reviewer rejects original defect with stopped evidence', passed: true }); save();
  const cancelRun = await rpc('graph.start', { ...request, idempotencyKey: 'live-cancel', source: { product: 'osstack', requestId: 'live-cancel' } });
  await until(async () => database.prepare("SELECT effect_key FROM graph_actions WHERE graph_run_id=? AND node_id='e0.implement' AND state='running'").get(cancelRun.graphRunId));
  await delay(200);
  for (let attempt = 0; attempt < 2; attempt++) {
    const beforeCancel = await status(cancelRun.graphRunId);
    try {
      await rpc('graph.cancel', { schemaVersion: 1, kind: 'cancel', scope, graphRunId: cancelRun.graphRunId, expectedRevision: beforeCancel.revision, idempotencyKey: `cancel-intent-${attempt}` }); break;
    } catch (error) { if (attempt !== 0 || error.message !== 'PILOT_RPC_REVISION_CONFLICT') throw error; }
  }
  await until(async () => database.prepare("SELECT state FROM graph_actions WHERE graph_run_id=? AND node_id='e0.implement' AND state NOT IN ('intent','running')").get(cancelRun.graphRunId));
  const afterCancel = await status(cancelRun.graphRunId);
  assert.ok(['cancel_pending','cancelled','reconciliation_required'].includes(afterCancel.status));
  report.cancellation = { status: afterCancel, actions: database.prepare('SELECT effect_key,node_id,state,outcome_json FROM graph_actions WHERE graph_run_id=?').all(cancelRun.graphRunId) };
  const writerAction = report.cancellation.actions.find(action => action.node_id === 'e0.implement');
  const writerState = writerAction.state;
  report.cancellation.admissions = database.prepare('SELECT effect_key,held_at,released_at FROM graph_action_admissions WHERE graph_run_id=?').all(cancelRun.graphRunId);
  if (writerState === 'unknown') {
    assert.notEqual(afterCancel.status, 'cancelled');
    assert.ok(report.cancellation.admissions.some(admission => admission.effect_key === writerAction.effect_key && admission.released_at === null));
    assert.equal(readFileSync(join(home, 'graph-delivery', cancelRun.graphRunId, 'writer-0', targetFile), 'utf8'), original);
  } else assert.ok(['confirmed', 'failed'].includes(writerState) && JSON.parse(writerAction.outcome_json).state === writerState);
  assert.equal(database.prepare("SELECT count(*) n FROM graph_actions WHERE graph_run_id=? AND node_id='e0.freeze'").get(cancelRun.graphRunId).n, 0);
  report.checks.push({ name: 'cancel admitted live writer; no freeze or forced release of unknown inference', passed: true });
  report.passed = true;
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : 'PILOT_FAILED'); process.exitCode = 1;
} finally {
  database?.close(); child.kill('SIGTERM');
  report.daemonExit = await Promise.race([exited, delay(30000, undefined, { ref: false }).then(() => ({ timeout: true }))]);
  if (report.daemonExit.timeout) { child.kill('SIGKILL'); report.passed = false; process.exitCode = 1; }
  report.completedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ passed: report.passed, report: output, root, error: report.error, checks: report.checks }));
}
