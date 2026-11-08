#!/usr/bin/env node
// Local evidence only. This command cannot qualify a real 5-G run.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { scratchRoot } from './lib/scratch.mjs';

const execute = promisify(execFile);
const REPOSITORY = 'osborn-studio/osstack-bridge-sandbox', REPOSITORY_ID = 1446327922;
const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
const id = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{1,127}$/.test(value);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (condition, code) => { if (!condition) throw Error(code); };
const chainStates = ['awaiting_review', 'revision_reserved', 'revising', 'publishing', 'ready_for_human', 'closed', 'awaiting_decision'];

async function requireNoSnapshotSidecars(path) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const entry = await lstat(`${path}${suffix}`).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
    requireThat(entry === null, 'snapshot_sidecar_refused');
  }
}

export function parseArgs(args) {
  const result = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    requireThat(['report', 'db', 'snapshot', 'manifest'].includes(key) && args[i] === `--${key}`
      && !Object.hasOwn(result, key) && args[i + 1] && !args[i + 1].startsWith('--'), 'invalid_arguments');
    result[key] = args[i + 1];
  }
  requireThat(result.report, 'absolute_report_required');
  return result;
}

async function artifact(path, code) {
  requireThat(typeof path === 'string' && isAbsolute(path), code);
  const canonical = await realpath(path).catch(() => { throw Error(code); });
  const root = await realpath(scratchRoot()).catch(() => { throw Error(code); });
  requireThat(canonical === resolve(path) && canonical.startsWith(`${root}${sep}`) && (await lstat(path)).isFile(), code);
  return canonical;
}

async function jsonArtifact(path, code) {
  await artifact(path, code);
  const bytes = await readFile(path);
  requireThat(bytes.length <= 64 * 1024 * 1024, code);
  try { return JSON.parse(bytes); } catch { throw Error(code); }
}

// Fixed identifiers, bound parameters, explicit columns. No config, credentials or runtime imports.
const PYTHON = String.raw`
import json,pathlib,sqlite3,sys
allowed={
 'engineering_revision_chains', 'engineering_contained_missions', 'engineering_workspace_claims',
 'engineering_host_processes', 'engineering_publication_intents', 'engineering_revision_chain_events', 'engineering_revision_reservations'}
# Immutable snapshots read exactly the hashed main file, even if a sidecar appears after the JS check.
x=sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+'?mode=ro'+('&immutable=1' if sys.argv[3]=='snapshot' else ''),uri=True,timeout=3)
x.execute('PRAGMA query_only=ON'); x.execute('PRAGMA trusted_schema=OFF'); x.execute('BEGIN')
def authorize(action,table,column,db,trigger):
 if action==sqlite3.SQLITE_READ: return sqlite3.SQLITE_OK if table in allowed else sqlite3.SQLITE_DENY
 return sqlite3.SQLITE_OK if action==sqlite3.SQLITE_SELECT else sqlite3.SQLITE_DENY
x.set_authorizer(authorize); x.row_factory=sqlite3.Row
ids=json.loads(sys.argv[2]); marks=','.join('?' for _ in ids)
def rows(sql,args):
 result=[dict(r) for r in x.execute(sql+' LIMIT 10001',args)]
 if len(result)>10000: raise ValueError('row_limit')
 return result
chains=rows('SELECT chain_id,root_mission_id,current_mission_id,repository,pr_number,branch,published_head,state FROM engineering_revision_chains WHERE chain_id IN ('+marks+')',ids)
intents=rows('SELECT intent_id,chain_id,kind,repository,pr_number,branch,expected_old_head,new_head,child_mission_id,state,binding_json FROM engineering_publication_intents WHERE chain_id IN ('+marks+')',ids)
reservations=rows('SELECT chain_id,repository,pr_number,head_sha,child_mission_id,state,settled_reason FROM engineering_revision_reservations WHERE chain_id IN ('+marks+')',ids)
missions=list({c['root_mission_id'] for c in chains}|{c['current_mission_id'] for c in chains if c['current_mission_id']}|{i['child_mission_id'] for i in intents if i['child_mission_id']}|{r['child_mission_id'] for r in reservations if r['child_mission_id']})
mm=','.join('?' for _ in missions)
result={'chains':chains,'intents':intents,'reservations':reservations,
 'missions':rows('SELECT mission_id,state,stop_obligation FROM engineering_contained_missions WHERE mission_id IN ('+mm+')',missions),
 'claims':rows('SELECT mission_id,state FROM engineering_workspace_claims WHERE mission_id IN ('+mm+')',missions),
 'host_processes':rows('SELECT mission_id,kind,state,released_at,stop_proof FROM engineering_host_processes WHERE mission_id IN ('+mm+')',missions),
 'ranges':rows("SELECT chain_id,payload_json FROM engineering_revision_chain_events WHERE kind='push_range' AND chain_id IN ("+marks+')',ids)}
x.close();print(json.dumps(result,separators=(',',':')))
`;

export async function auditSandboxLedger(options) {
  requireThat(options && typeof options.report === 'string' && isAbsolute(options.report), 'absolute_report_required');
  const reportPath = await artifact(options.report, 'invalid_report_path');
  const reportBytes = await readFile(reportPath), reportBefore = digest(reportBytes);
  requireThat(reportBytes.length <= 64 * 1024 * 1024, 'invalid_report');
  let report;
  try { report = JSON.parse(reportBytes); } catch { throw Error('invalid_report'); }
  requireThat(report && report.repository === REPOSITORY && report.repository_id === REPOSITORY_ID
    && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(report.run ?? '') && report.qualification_scope === 'LIVE_5G_ONLY'
    && typeof report.home === 'string' && report.home === join(resolve(reportPath, '..'), 'home')
    && Array.isArray(report.chains) && report.chains.length > 0 && report.chains.length <= 100
    && report.chains.every(id) && new Set(report.chains).size === report.chains.length
    && Array.isArray(report.owned_prs) && report.owned_prs.length > 0
    && report.owned_prs.every(n => Number.isSafeInteger(n) && n > 0)
    && Array.isArray(report.ledger) && report.ledger.length === report.chains.length, 'invalid_report');
  const ledger = new Map(report.ledger.map(c => [c.chain_id, c]));
  requireThat(ledger.size === report.chains.length && report.chains.every(chain => {
    const c = ledger.get(chain);
    return c && chainStates.includes(c.state) && sha(c.published_head) && Array.isArray(c.intents) && c.intents.length <= 1000
      && new Set(c.intents.map(i => i.intent_id)).size === c.intents.length
      && c.intents.every(i => id(i.intent_id) && ['open_pr', 'push', 'check'].includes(i.kind)
        && typeof i.state === 'string' && (i.head === null || sha(i.head)) && (i.child === null || id(i.child)));
  }), 'invalid_report');
  requireThat(Boolean(options.db) !== Boolean(options.snapshot) && (!options.db || !options.manifest)
    && (!options.snapshot || options.manifest), 'explicit_database_required');
  let path, snapshotDigest;
  if (options.db) {
    requireThat(options.db === join(report.home, 'control.db'), 'invalid_database_path');
    path = await artifact(options.db, 'invalid_database_path');
  } else {
    const manifest = await jsonArtifact(options.manifest, 'snapshot_manifest_mismatch');
    requireThat(manifest && manifest.repository === REPOSITORY && manifest.repository_id === REPOSITORY_ID
      && manifest.run === report.run && manifest.report_path === reportPath && manifest.final_audit_snapshot === options.snapshot
      && manifest.report_sha256 === reportBefore
      && manifest.snapshot_kind === 'consistent_readonly_backup_after_host_shutdown_delete_journal'
      && /^[a-f0-9]{64}$/.test(manifest.snapshot_sha256 ?? ''), 'snapshot_manifest_mismatch');
    snapshotDigest = manifest.snapshot_sha256;
    path = await artifact(options.snapshot, 'invalid_database_path');
    await requireNoSnapshotSidecars(path);
    const bytes = await readFile(path);
    requireThat(digest(bytes) === manifest.snapshot_sha256 && bytes[18] === 1 && bytes[19] === 1, 'snapshot_manifest_mismatch');
  }
  const before = digest(await readFile(path));
  requireThat(!snapshotDigest || before === snapshotDigest, 'snapshot_manifest_mismatch');
  let data;
  try {
    const result = await execute('python3', ['-c', PYTHON, path, JSON.stringify(report.chains), options.snapshot ? 'snapshot' : 'live'], { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 });
    data = JSON.parse(result.stdout);
  } catch { throw Error('readonly_ledger_query_failed'); }
  requireThat(digest(await readFile(path)) === before && digest(await readFile(reportPath)) === reportBefore, 'evidence_changed_during_audit');
  if (options.snapshot) await requireNoSnapshotSidecars(path);
  requireThat(data.chains.length === report.chains.length, 'ledger_binding_mismatch');
  const chains = new Map(data.chains.map(c => [c.chain_id, c]));
  requireThat(chains.size === report.chains.length && report.chains.every(chainId => chains.has(chainId)), 'ledger_binding_mismatch');
  for (const c of data.chains) requireThat(c.repository === REPOSITORY && report.owned_prs.includes(c.pr_number)
    && c.branch.startsWith(`osstack/mission/${report.run}-`) && /^osstack\/mission\/[A-Za-z0-9_-]+$/.test(c.branch)
    && c.published_head === ledger.get(c.chain_id)?.published_head && c.state === ledger.get(c.chain_id)?.state
    && id(c.root_mission_id) && (c.current_mission_id === null || id(c.current_mission_id)), 'ledger_binding_mismatch');
  for (const r of data.reservations) {
    const c = chains.get(r.chain_id);
    requireThat(c && r.repository === c.repository && r.pr_number === c.pr_number && sha(r.head_sha)
      && (r.child_mission_id === null || id(r.child_mission_id))
      && ((r.state === 'reserved' && r.child_mission_id === null && r.settled_reason === null)
        || (r.state === 'dispatched' && r.child_mission_id !== null && r.settled_reason === null)
        || (r.state === 'void' && typeof r.settled_reason === 'string' && r.settled_reason.length > 0)), 'ledger_binding_mismatch');
  }
  requireThat(new Set(data.reservations.map(r => JSON.stringify([r.repository, r.pr_number, r.head_sha]))).size === data.reservations.length,
    'ledger_binding_mismatch');
  for (const i of data.intents) {
    const c = chains.get(i.chain_id), recorded = ledger.get(i.chain_id)?.intents.find(r => r.intent_id === i.intent_id);
    requireThat(c && recorded && i.repository === REPOSITORY && i.pr_number === c.pr_number && i.branch === c.branch
      && i.kind === recorded.kind && i.state === recorded.state && i.new_head === recorded.head && i.child_mission_id === recorded.child
      && (i.new_head === null || sha(i.new_head)) && (i.expected_old_head === null || sha(i.expected_old_head)), 'ledger_binding_mismatch');
  }
  requireThat(new Set(data.intents.map(i => i.intent_id)).size === data.intents.length
    && data.intents.length === report.ledger.reduce((n, c) => n + c.intents.length, 0), 'ledger_binding_mismatch');
  const expectedMissions = new Set(data.chains.flatMap(c => [c.root_mission_id, c.current_mission_id])
    .concat(data.intents.map(i => i.child_mission_id), data.reservations.map(r => r.child_mission_id)).filter(Boolean));
  const missionIds = new Set(data.missions.map(m => m.mission_id));
  requireThat(data.missions.length === expectedMissions.size && missionIds.size === expectedMissions.size
    && [...expectedMissions].every(missionId => missionIds.has(missionId)), 'ledger_binding_mismatch');
  const ranges = new Map();
  for (const r of data.ranges) {
    let payload;
    try { payload = JSON.parse(r.payload_json); } catch { throw Error('invalid_range_evidence'); }
    const key = `${r.chain_id}:${payload.intent_id}`;
    requireThat(!ranges.has(key) && id(payload.intent_id) && Array.isArray(payload.commits) && payload.commits.length > 0
      && payload.commits.every(sha) && new Set(payload.commits).size === payload.commits.length, 'invalid_range_evidence');
    ranges.set(key, payload.commits);
  }
  const invalidRanges = new Set();
  for (const c of data.chains) {
    const confirmed = data.intents.filter(i => i.chain_id === c.chain_id && ['open_pr', 'push'].includes(i.kind) && i.state === 'confirmed');
    const baseline = confirmed.filter(i => i.kind === 'open_pr');
    const remaining = confirmed.filter(i => i.kind === 'push');
    let current = baseline[0], tip = current?.expected_old_head;
    const covered = new Set();
    if (baseline.length !== 1) invalidRanges.add(c.chain_id);
    while (current) {
      let binding;
      try { binding = JSON.parse(current.binding_json); } catch { binding = {}; }
      const commits = ranges.get(`${c.chain_id}:${current.intent_id}`);
      if (!commits || commits.at(-1) !== current.new_head || current.expected_old_head !== tip
        || binding?.commit_count !== commits.length || binding?.range_sha256 !== digest(JSON.stringify(commits))
        || commits.some(commit => covered.has(commit))) invalidRanges.add(current.intent_id);
      for (const commit of commits ?? []) covered.add(commit);
      tip = current.new_head;
      const next = remaining.filter(i => i.expected_old_head === tip);
      if (next.length > 1) invalidRanges.add(c.chain_id);
      current = next.length === 1 ? next[0] : undefined;
      if (current) remaining.splice(remaining.indexOf(current), 1);
    }
    if (remaining.length || tip !== c.published_head) invalidRanges.add(c.chain_id);
  }
  const unsettled = {
    chains: data.chains.filter(c => ['revision_reserved', 'revising', 'publishing'].includes(c.state)).length,
    reservations: data.reservations.filter(r => r.state !== 'void').length,
    missions: data.missions.filter(m => !['pr_opened', 'cancelled', 'abandoned', 'failed'].includes(m.state) || m.stop_obligation !== 0).length,
    claims: data.claims.filter(c => c.state !== 'released').length,
    host_processes: data.host_processes.filter(h => h.state !== 'stopped'
      || !['group_empty+marker_unheld', 'never_released', 'never_spawned', 'never_registered+marker_unheld'].includes(h.stop_proof)
      || (h.stop_proof !== 'group_empty+marker_unheld' && h.released_at !== null)).length,
    intents: data.intents.filter(i => !['confirmed', 'failed'].includes(i.state)).length,
    ranges: invalidRanges.size,
  };
  return { schema_version: 1, repository: REPOSITORY, repository_id: REPOSITORY_ID, run: report.run,
    database_sha256: before, database_sha256_scope: 'MAIN_FILE_ONLY', database_read_scope: options.snapshot ? 'IMMUTABLE_SNAPSHOT_MAIN_FILE' : 'READONLY_TRANSACTION_INCLUDING_WAL',
    report_sha256: reportBefore, ledger_settled: Object.values(unsettled).every(n => n === 0),
    counts: Object.fromEntries(['chains', 'reservations', 'missions', 'claims', 'host_processes', 'intents', 'ranges'].map(k => [k, data[k].length])),
    unsettled, full_5g_pass: false, w13_revocation: 'unproven', github_timeline: 'not_read',
    limits: ['Settlement covers selected chain, reservation and mission rows; deleted rows and evidence authenticity are not established.',
      'The main-file hash does not bind live WAL contents. Snapshot reads use only the manifest-bound immutable main file.'] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await auditSandboxLedger(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.ledger_settled ? 0 : 1;
  } catch (error) {
    const code = /^[a-z_]+$/.test(error?.message ?? '') ? error.message : 'audit_failed';
    process.stderr.write(`${JSON.stringify({ error: code, full_5g_pass: false })}\n`); process.exitCode = 2;
  }
}
