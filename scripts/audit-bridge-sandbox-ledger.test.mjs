import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createScratchDir } from './lib/scratch.mjs';
import { auditSandboxLedger, parseArgs } from './audit-bridge-sandbox-ledger.mjs';

const repository = 'osborn-studio/osstack-bridge-sandbox', head = 'a'.repeat(40);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const dir = await createScratchDir('smoke', 'readonly-ledger-test');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const home = join(dir, 'home'), report = join(dir, 'report.json'), db = join(home, 'control.db');
  await mkdir(home);
  const intent = { intent_id: 'pi_test', kind: 'open_pr', state: 'confirmed', head, child: 'cm_root' };
  const value = { repository, repository_id: 1446327922, run: 'audit-test', home, qualification_scope: 'LIVE_5G_ONLY',
    qualified: false, chains: ['rc_test'], owned_prs: [1], required_scenarios: [], scenarios: [],
    ledger: [{ chain_id: 'rc_test', state: 'ready_for_human', published_head: head, intents: [intent] }] };
  await writeFile(report, JSON.stringify(value));
  execFileSync('python3', ['-c', `import sqlite3,sys,json
x=sqlite3.connect(sys.argv[1]); x.executescript('''
CREATE TABLE engineering_revision_chains(chain_id,root_mission_id,current_mission_id,repository,pr_number,branch,published_head,state);
CREATE TABLE engineering_contained_missions(mission_id,state,stop_obligation);
CREATE TABLE engineering_workspace_claims(mission_id,state);
CREATE TABLE engineering_host_processes(mission_id,kind,state,released_at,stop_proof);
CREATE TABLE engineering_publication_intents(intent_id,chain_id,kind,repository,pr_number,branch,expected_old_head,new_head,child_mission_id,state,binding_json);
CREATE TABLE engineering_revision_chain_events(chain_id,kind,payload_json);
CREATE TABLE engineering_revision_reservations(chain_id,repository,pr_number,head_sha,child_mission_id,state,settled_reason);
CREATE TABLE secret_tokens(secret); INSERT INTO secret_tokens VALUES('DO_NOT_PRINT_SECRET');
INSERT INTO engineering_contained_missions VALUES('cm_root','pr_opened',0);
INSERT INTO engineering_workspace_claims VALUES('cm_root','released');
INSERT INTO engineering_host_processes VALUES('cm_root','git_push','stopped',1,'group_empty+marker_unheld');
''')
import hashlib
h='a'*40; repo='osborn-studio/osstack-bridge-sandbox'; branch='osstack/mission/audit-test-a'
x.execute('INSERT INTO engineering_revision_chains VALUES(?,?,?,?,?,?,?,?)',('rc_test','cm_root',None,repo,1,branch,h,'ready_for_human'))
x.execute('INSERT INTO engineering_publication_intents VALUES(?,?,?,?,?,?,?,?,?,?,?)',('pi_test','rc_test','open_pr',repo,1,branch,'b'*40,h,'cm_root','confirmed',json.dumps({'commit_count':1,'range_sha256':hashlib.sha256(json.dumps([h],separators=(',',':')).encode()).hexdigest()})))
x.execute('INSERT INTO engineering_revision_chain_events VALUES(?,?,?)',('rc_test','push_range',json.dumps({'intent_id':'pi_test','commits':[h]})))
x.commit();x.close()`, db]);
  return { dir, home, report, db, value, async sql(sql) { execFileSync('python3', ['-c', 'import sqlite3,sys;x=sqlite3.connect(sys.argv[1]);x.executescript(sys.argv[2]);x.commit();x.close()', db, sql]); } };
}

test('reads real SQLite without changing bytes or schema and never claims full acceptance', async t => {
  const f = await fixture(t), before = hash(await readFile(f.db));
  const result = await auditSandboxLedger({ report: f.report, db: f.db });
  assert.equal(result.ledger_settled, true);
  assert.equal(result.full_5g_pass, false);
  assert.equal(result.w13_revocation, 'unproven');
  assert.equal(result.github_timeline, 'not_read');
  assert.equal(result.counts.host_processes, 1);
  assert.equal(result.database_sha256_scope, 'MAIN_FILE_ONLY');
  assert.equal(result.database_read_scope, 'READONLY_TRANSACTION_INCLUDING_WAL');
  assert.equal(JSON.stringify(result).includes('DO_NOT_PRINT_SECRET'), false);
  assert.equal(hash(await readFile(f.db)), before);
});

test('active claims, stop obligations and unproven host processes cannot produce a clean ledger', async t => {
  const f = await fixture(t);
  await f.sql("UPDATE engineering_workspace_claims SET state='active'; UPDATE engineering_contained_missions SET stop_obligation=1; UPDATE engineering_host_processes SET state='registered',stop_proof=NULL;");
  const result = await auditSandboxLedger({ report: f.report, db: f.db });
  assert.equal(result.ledger_settled, false);
  assert.deepEqual(result.unsettled, { chains: 0, reservations: 0, missions: 1, claims: 1, host_processes: 1, intents: 0, ranges: 0 });
});

test('rejects wrong repository, malformed identity and default or unrelated DB before opening', async t => {
  const f = await fixture(t);
  for (const patch of [{ repository: 'other/repo' }, { repository_id: 1 }, { run: '../bad' }, { chains: [] }, { owned_prs: [0] }]) {
    await writeFile(f.report, JSON.stringify({ ...f.value, ...patch }));
    await assert.rejects(auditSandboxLedger({ report: f.report, db: '/does/not/exist' }), /invalid_report/);
  }
  await writeFile(f.report, JSON.stringify(f.value));
  await assert.rejects(auditSandboxLedger({ report: f.report, db: '/Users/osborn/.osstack/control.db' }), /invalid_database_path/);
  await assert.rejects(auditSandboxLedger({ report: f.report }), /explicit_database_required/);
  await assert.rejects(auditSandboxLedger({ report: 'relative.json', db: f.db }), /absolute_report_required/);
});

test('rejects report versus DB PR, branch and head mismatches', async t => {
  const f = await fixture(t);
  for (const [column, value] of [['repository', 'other/repo'], ['pr_number', '2'], ['branch', 'osstack/mission/other-a'], ['published_head', 'b'.repeat(40)]]) {
    const original = column === 'repository' ? repository : column === 'pr_number' ? '1' : column === 'branch' ? 'osstack/mission/audit-test-a' : head;
    await f.sql(`UPDATE engineering_revision_chains SET ${column}='${value}';`);
    await assert.rejects(auditSandboxLedger({ report: f.report, db: f.db }), /ledger_binding_mismatch/);
    await f.sql(`UPDATE engineering_revision_chains SET ${column}='${original}';`);
  }
});

test('missing confirmed range is unsettled even with terminal rows', async t => {
  const f = await fixture(t); await f.sql('DELETE FROM engineering_revision_chain_events;');
  const result = await auditSandboxLedger({ report: f.report, db: f.db });
  assert.equal(result.ledger_settled, false); assert.equal(result.unsettled.ranges, 1);
});

test('snapshot requires manifest SHA and report/run/repository binding', async t => {
  const f = await fixture(t), snapshot = join(f.dir, 'final.sqlite'), manifest = join(f.dir, 'manifest.json');
  await writeFile(snapshot, await readFile(f.db));
  const m = { repository, repository_id: 1446327922, run: f.value.run, report_path: f.report,
    report_sha256: hash(await readFile(f.report)),
    final_audit_snapshot: snapshot, snapshot_sha256: hash(await readFile(snapshot)), snapshot_kind: 'consistent_readonly_backup_after_host_shutdown_delete_journal' };
  await writeFile(manifest, JSON.stringify(m));
  assert.equal((await auditSandboxLedger({ report: f.report, snapshot, manifest })).ledger_settled, true);
  for (const patch of [{ snapshot_sha256: '0'.repeat(64) }, { report_sha256: '0'.repeat(64) }, { report_sha256: undefined }, { run: 'other' }, { repository_id: 1 }, { report_path: '/wrong' }]) {
    await writeFile(manifest, JSON.stringify({ ...m, ...patch }));
    await assert.rejects(auditSandboxLedger({ report: f.report, snapshot, manifest }), /snapshot_manifest_mismatch/);
  }
});

test('CLI requires explicit flags and rejects network and write options', () => {
  assert.deepEqual(parseArgs(['--report', '/a', '--db', '/b']), { report: '/a', db: '/b' });
  for (const args of [[], ['--report'], ['--report', '/a', '--github-readback'], ['--report', '/a', '--db', '/b', '--db', '/c']]) assert.throws(() => parseArgs(args));
});


test('range hashes and the baseline chain cannot be replaced by terminal row counts', async t => {
  const f = await fixture(t);
  await f.sql("UPDATE engineering_publication_intents SET binding_json='{}';");
  assert.equal((await auditSandboxLedger({ report: f.report, db: f.db })).ledger_settled, false);
});

test('an allowed table name cannot expose a hidden credentials table through a view', async t => {
  const f = await fixture(t);
  await f.sql("DROP TABLE engineering_host_processes; CREATE VIEW engineering_host_processes AS SELECT 'cm_root' AS mission_id,'git_push' AS kind,secret AS state,0 AS released_at,NULL AS stop_proof FROM secret_tokens;");
  await assert.rejects(auditSandboxLedger({ report: f.report, db: f.db }), /readonly_ledger_query_failed/);
});

test('a reserved review before child dispatch is an unsettled ledger obligation', async t => {
  const f = await fixture(t);
  f.value.ledger[0].state = 'revision_reserved'; await writeFile(f.report, JSON.stringify(f.value));
  await f.sql(`UPDATE engineering_revision_chains SET state='revision_reserved';
    INSERT INTO engineering_revision_reservations VALUES('rc_test','${repository}',1,'${head}',NULL,'reserved',NULL);`);
  const result = await auditSandboxLedger({ report: f.report, db: f.db });
  assert.equal(result.ledger_settled, false);
  assert.equal(result.unsettled.chains, 1); assert.equal(result.unsettled.reservations, 1);
});

test('in-flight chain state and pending publication each prevent settlement', async t => {
  const f = await fixture(t);
  for (const state of ['revision_reserved', 'revising', 'publishing']) {
    f.value.ledger[0].state = state; await writeFile(f.report, JSON.stringify(f.value));
    await f.sql(`UPDATE engineering_revision_chains SET state='${state}';`);
    const result = await auditSandboxLedger({ report: f.report, db: f.db });
    assert.equal(result.ledger_settled, false); assert.equal(result.unsettled.chains, 1);
  }
  f.value.ledger[0].state = 'ready_for_human'; f.value.ledger[0].intents[0].state = 'pending';
  await writeFile(f.report, JSON.stringify(f.value));
  await f.sql("UPDATE engineering_revision_chains SET state='ready_for_human'; UPDATE engineering_publication_intents SET state='pending';");
  assert.equal((await auditSandboxLedger({ report: f.report, db: f.db })).unsettled.intents, 1);
});

test('void reservations retain historical children in the audited mission and process scope', async t => {
  const f = await fixture(t);
  await f.sql(`INSERT INTO engineering_revision_reservations VALUES('rc_test','${repository}',1,'${head}','cm_history','void','child_halted');
    INSERT INTO engineering_contained_missions VALUES('cm_history','failed',1);
    INSERT INTO engineering_workspace_claims VALUES('cm_history','active');
    INSERT INTO engineering_host_processes VALUES('cm_history','git_index_write','registered',NULL,NULL);`);
  const result = await auditSandboxLedger({ report: f.report, db: f.db });
  assert.equal(result.counts.missions, 2); assert.equal(result.counts.reservations, 1);
  assert.equal(result.ledger_settled, false); assert.equal(result.unsettled.reservations, 0);
  assert.equal(result.unsettled.missions, 1); assert.equal(result.unsettled.claims, 1); assert.equal(result.unsettled.host_processes, 1);
  await f.sql("UPDATE engineering_contained_missions SET stop_obligation=0 WHERE mission_id='cm_history'; UPDATE engineering_workspace_claims SET state='released'; UPDATE engineering_host_processes SET state='stopped',stop_proof='never_released' WHERE mission_id='cm_history';");
  assert.equal((await auditSandboxLedger({ report: f.report, db: f.db })).ledger_settled, true);
});

test('reservation scope and lifecycle must bind to the selected chain', async t => {
  const f = await fixture(t);
  await f.sql(`INSERT INTO engineering_revision_reservations VALUES('rc_test','${repository}',1,'${head}',NULL,'void','closed');`);
  for (const update of ["repository='other/repo'", 'pr_number=2', "head_sha='invalid'", "state='unknown'", 'settled_reason=NULL', "child_mission_id='cm_missing'"]) {
    await f.sql(`UPDATE engineering_revision_reservations SET ${update};`);
    await assert.rejects(auditSandboxLedger({ report: f.report, db: f.db }), /ledger_binding_mismatch/);
    await f.sql(`UPDATE engineering_revision_reservations SET repository='${repository}',pr_number=1,head_sha='${head}',state='void',settled_reason='closed',child_mission_id=NULL;`);
  }
  f.value.ledger[0].state = 'closed'; await writeFile(f.report, JSON.stringify(f.value));
  await assert.rejects(auditSandboxLedger({ report: f.report, db: f.db }), /ledger_binding_mismatch/);
});

test('a closed snapshot with settled historical children passes only local ledger scope', async t => {
  const f = await fixture(t), snapshot = join(f.dir, 'final.sqlite'), manifest = join(f.dir, 'manifest.json');
  f.value.ledger[0].state = 'closed'; await writeFile(f.report, JSON.stringify(f.value));
  await f.sql(`UPDATE engineering_revision_chains SET state='closed';
    INSERT INTO engineering_revision_reservations VALUES('rc_test','${repository}',1,'${head}','cm_history','void','chain_closed:pr_closed');
    INSERT INTO engineering_contained_missions VALUES('cm_history','cancelled',0);
    INSERT INTO engineering_workspace_claims VALUES('cm_history','released');`);
  await writeFile(snapshot, await readFile(f.db));
  await writeFile(manifest, JSON.stringify({ repository, repository_id: 1446327922, run: f.value.run, report_path: f.report,
    report_sha256: hash(await readFile(f.report)),
    final_audit_snapshot: snapshot, snapshot_sha256: hash(await readFile(snapshot)), snapshot_kind: 'consistent_readonly_backup_after_host_shutdown_delete_journal' }));
  const result = await auditSandboxLedger({ report: f.report, snapshot, manifest });
  assert.equal(result.ledger_settled, true); assert.equal(result.counts.missions, 2);
  assert.equal(result.full_5g_pass, false); assert.equal(result.w13_revocation, 'unproven');
  assert.equal(result.database_read_scope, 'IMMUTABLE_SNAPSHOT_MAIN_FILE');
});

test('a snapshot cannot read unhashed WAL sidecars even with DELETE journal header bytes', async t => {
  const f = await fixture(t), snapshot = join(f.dir, 'final.sqlite'), manifest = join(f.dir, 'manifest.json');
  await f.sql("UPDATE engineering_workspace_claims SET state='active';");
  execFileSync('python3', ['-c', `import pathlib,sqlite3,sys
source=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2]); x=sqlite3.connect(source)
x.execute('PRAGMA journal_mode=WAL'); x.execute("UPDATE engineering_workspace_claims SET state='released'"); x.commit()
main=bytearray(source.read_bytes()); main[18]=1; main[19]=1; target.write_bytes(main)
pathlib.Path(str(target)+'-wal').write_bytes(pathlib.Path(str(source)+'-wal').read_bytes()); x.close()`, f.db, snapshot]);
  const before = hash(await readFile(snapshot));
  await writeFile(manifest, JSON.stringify({ repository, repository_id: 1446327922, run: f.value.run, report_path: f.report,
    report_sha256: hash(await readFile(f.report)),
    final_audit_snapshot: snapshot, snapshot_sha256: before, snapshot_kind: 'consistent_readonly_backup_after_host_shutdown_delete_journal' }));
  await assert.rejects(auditSandboxLedger({ report: f.report, snapshot, manifest }), /snapshot_sidecar_refused/);
  assert.equal(hash(await readFile(snapshot)), before);
  await rm(`${snapshot}-wal`);
  const result = await auditSandboxLedger({ report: f.report, snapshot, manifest });
  assert.equal(result.ledger_settled, false); assert.equal(result.unsettled.claims, 1);
});

test('manifest binds report contents so dropping an unsettled chain at the same path is refused', async t => {
  const f = await fixture(t), snapshot = join(f.dir, 'final.sqlite'), manifest = join(f.dir, 'manifest.json');
  f.value.chains.push('rc_pending'); f.value.ledger.push({ chain_id: 'rc_pending', state: 'revising', published_head: head, intents: [] });
  await writeFile(f.report, JSON.stringify(f.value));
  await f.sql(`INSERT INTO engineering_revision_chains VALUES('rc_pending','cm_pending',NULL,'${repository}',1,'osstack/mission/audit-test-b','${head}','revising');
    INSERT INTO engineering_contained_missions VALUES('cm_pending','executing',1);`);
  await writeFile(snapshot, await readFile(f.db));
  await writeFile(manifest, JSON.stringify({ repository, repository_id: 1446327922, run: f.value.run, report_path: f.report,
    report_sha256: hash(await readFile(f.report)), final_audit_snapshot: snapshot, snapshot_sha256: hash(await readFile(snapshot)),
    snapshot_kind: 'consistent_readonly_backup_after_host_shutdown_delete_journal' }));
  assert.equal((await auditSandboxLedger({ report: f.report, snapshot, manifest })).ledger_settled, false);
  f.value.chains.pop(); f.value.ledger.pop(); await writeFile(f.report, JSON.stringify(f.value));
  await assert.rejects(auditSandboxLedger({ report: f.report, snapshot, manifest }), /snapshot_manifest_mismatch/);
});

test('duplicate chain or mission IDs cannot replace missing bound identities', async t => {
  const f = await fixture(t);
  await f.sql("UPDATE engineering_revision_chains SET root_mission_id='cm_missing',current_mission_id='cm_root'; INSERT INTO engineering_contained_missions VALUES('cm_root','pr_opened',0);");
  await assert.rejects(auditSandboxLedger({ report: f.report, db: f.db }), /ledger_binding_mismatch/);
  await f.sql("DELETE FROM engineering_contained_missions; INSERT INTO engineering_contained_missions VALUES('cm_root','pr_opened',0); UPDATE engineering_revision_chains SET root_mission_id='cm_root',current_mission_id=NULL; INSERT INTO engineering_revision_chains SELECT * FROM engineering_revision_chains;");
  f.value.chains.push('rc_missing'); f.value.ledger.push({ ...f.value.ledger[0], chain_id: 'rc_missing', intents: [] });
  await writeFile(f.report, JSON.stringify(f.value));
  await assert.rejects(auditSandboxLedger({ report: f.report, db: f.db }), /ledger_binding_mismatch/);
});

test('duplicate commits inside a range fail even when its count and hash agree', async t => {
  const f = await fixture(t), commits = [head, head];
  const binding = JSON.stringify({ commit_count: 2, range_sha256: hash(JSON.stringify(commits)) });
  await f.sql(`UPDATE engineering_publication_intents SET binding_json='${binding}';
    UPDATE engineering_revision_chain_events SET payload_json='${JSON.stringify({ intent_id: 'pi_test', commits })}';`);
  await assert.rejects(auditSandboxLedger({ report: f.report, db: f.db }), /invalid_range_evidence/);
});

test('a live DB includes current WAL rows without claiming that its main-file hash binds them', async t => {
  const f = await fixture(t);
  execFileSync('python3', ['-c', `import pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1]); x=sqlite3.connect(p); x.execute('PRAGMA journal_mode=WAL')
x.execute("UPDATE engineering_workspace_claims SET state='active'"); x.commit()
main=p.read_bytes(); wal=pathlib.Path(str(p)+'-wal').read_bytes(); x.close()
p.write_bytes(main); pathlib.Path(str(p)+'-wal').write_bytes(wal)`, f.db]);
  const before = hash(await readFile(f.db)), result = await auditSandboxLedger({ report: f.report, db: f.db });
  assert.equal(result.ledger_settled, false); assert.equal(result.unsettled.claims, 1);
  assert.equal(result.database_sha256, before); assert.equal(result.database_sha256_scope, 'MAIN_FILE_ONLY');
  assert.equal(result.database_read_scope, 'READONLY_TRANSACTION_INCLUDING_WAL');
  assert.equal(hash(await readFile(f.db)), before);
});
