import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openDb, runMigrations } from './db.js';
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from './migrations.js';
const legacy = JSON.parse(readFileSync(new URL('./fixtures/graph-preintegration-migrations.json', import.meta.url), 'utf8')) as { migrations: { id: number; name: string; sql: string }[] };
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'graph-lineage-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });
const install = (db: Database.Database, migrations: typeof MIGRATIONS) => {
  // Construct the historical starting state atomically. Migration behavior is
  // exercised below by openDb/runMigrations, not by fsyncing each fixture DDL.
  db.transaction(() => {
    for (const m of migrations) { db.exec(m.sql); db.pragma(`user_version = ${m.id}`); }
  })();
};
it.each([true, false])('reopens the integrated current schema with readwrite=%s', readwrite => {
  const path = join(root, 'current.db');
  const created = openDb({ path });
  created.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES ('retained','restart evidence','pending',1,1)");
  created.close();
  const reopened = openDb({ path, readwrite });
  try {
    expect(reopened.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(reopened.prepare("SELECT title FROM tasks WHERE task_id='retained'").get()).toEqual({ title: 'restart evidence' });
    expect(reopened.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally { reopened.close(); }
});
it.each([24, 25, 26, 27, 37, 38, 39, 40])('upgrades deployed v%s preserving its actual improvement execution', version => {
  const path = join(root, 'main.db'); const old = new Database(path);
  install(old, MIGRATIONS.filter(m => m.id <= version));
  old.exec(`INSERT INTO improvement_proposals(proposal_id,repo_id,source_asset_ids_json,target,risk,title,rationale,proposed_changes_json,required_gates_json,status,created_at,updated_at) VALUES ('p','repo','[]','eval','low','title','reason','[]','[]','approved',1,1)`);
  if (version >= 25) old.exec(`INSERT INTO improvement_executions(execution_id,proposal_id,request_json,request_sha256,state,created_at,updated_at)
    VALUES ('e','p','{}','digest','claimed',1,1);`);
  old.close();
  const db = openDb({ path });
  try {
    expect(db.prepare("SELECT proposal_id,state,request_sha256 FROM improvement_executions WHERE execution_id='e'").get())
      .toEqual(version >= 25 ? { proposal_id: 'p', state: 'claimed', request_sha256: 'digest' } : undefined);
    expect(db.prepare('SELECT count(*) n FROM graph_runs').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM improvement_pr_deliveries').get()).toEqual({ n: 0 });
    expect(db.pragma('user_version', { simple: true })).toBe(CURRENT_SCHEMA_VERSION);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally { db.close(); }
});
it.each(Array.from({ length: 10 }, (_, i) => i + 25))('rejects unreleased Graph v%s without changing bytes or migration progress', version => {
  const path = join(root, 'experiment.db'); const old = new Database(path);
  install(old, MIGRATIONS.filter(m => m.id <= 24));
  install(old, legacy.migrations.filter(m => m.id <= version));
  old.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES ('held','preserve evidence','pending',1,1)");
  old.close(); const before = readFileSync(path);
  for (const readwrite of [true, false]) expect(() => openDb({ path, readwrite })).toThrow('GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT');
  const raw = new Database(path);
  try {
    expect(() => runMigrations(raw)).toThrow('GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT');
    expect(raw.pragma('user_version', { simple: true })).toBe(version);
    expect(raw.prepare('SELECT title FROM tasks').get()).toEqual({ title: 'preserve evidence' });
  } finally { raw.close(); }
  expect(readFileSync(path).equals(before)).toBe(true);
});

it('pins deployed main SQL and the integration boundary', () => {
  expect(createHash('sha256').update(MIGRATIONS.filter(m => m.id >= 25 && m.id <= 27).map(m => m.sql).join('\0')).digest('hex')).toBe('55ad736ab2a455b4ac8f8e76b561b6c39931bb2322f16a57414f7cb574e9c090');
  expect(MIGRATIONS.map(m => m.id)).toEqual(Array.from({ length: CURRENT_SCHEMA_VERSION }, (_, i) => i + 1));
  expect(MIGRATIONS.find(m => m.name === 'improvement_candidate_executions')?.id).toBe(25);
  expect(MIGRATIONS.find(m => m.name === 'graph_run_identity_and_worker_leases')?.id).toBe(28);
});
it('allows read-only inspection of main v27 without applying graph DDL', () => {
  const path = join(root, 'readonly.db'); const old = new Database(path);
  install(old, MIGRATIONS.filter(m => m.id <= 27)); old.close();
  const db = openDb({ path, readwrite: false });
  try {
    expect(db.pragma('user_version', { simple: true })).toBe(27);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='graph_runs'").get()).toBeUndefined();
  } finally { db.close(); }
});
it.each([26, 27].flatMap(base => [29, 34].map(cut => ({ base, cut }))))('rejects a main $base / experimental $cut hybrid before any DDL', ({ base, cut }) => {
  const path = join(root, 'hybrid.db'); const old = new Database(path);
  install(old, MIGRATIONS.filter(m => m.id <= base));
  install(old, legacy.migrations.filter(m => m.id > base && m.id <= cut));
  const schema = old.prepare('SELECT * FROM sqlite_master ORDER BY name').all(); old.close();
  for (const readwrite of [true, false]) expect(() => openDb({ path, readwrite })).toThrow('GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT');
  const check = new Database(path);
  try {
    expect(check.pragma('user_version', { simple: true })).toBe(cut);
    expect(check.prepare('SELECT * FROM sqlite_master ORDER BY name').all()).toEqual(schema);
  } finally { check.close(); }
});
it('retains a crashed WAL experimental ledger logically without advancing its schema', () => {
  const path = join(root, 'wal.db'); const script = join(root, 'crash.cjs');
  const migrations = [...MIGRATIONS.filter(m => m.id <= 24), ...legacy.migrations];
  writeFileSync(script, `const Database=require(${JSON.stringify(createRequire(import.meta.url).resolve('better-sqlite3'))});
    const db=new Database(${JSON.stringify(path)}); db.pragma('journal_mode=WAL'); db.pragma('wal_autocheckpoint=0');
    for(const m of ${JSON.stringify(migrations)}) {db.exec(m.sql); db.pragma('user_version='+m.id);}
    db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES ('held','unknown evidence','pending',1,1)");
    process.kill(process.pid,'SIGKILL');`);
  expect(() => execFileSync(process.execPath, [script], { stdio: 'ignore' })).toThrow();
  expect(readFileSync(path + '-wal').length).toBeGreaterThan(0);
  for (const readwrite of [true, false]) expect(() => openDb({ path, readwrite })).toThrow('GRAPH_EXPERIMENTAL_SCHEMA_CONFLICT');
  const db = new Database(path);
  try {
    expect(db.pragma('user_version', { simple: true })).toBe(34);
    expect(db.prepare('SELECT title FROM tasks').get()).toEqual({ title: 'unknown evidence' });
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='improvement_executions'").get()).toBeUndefined();
    expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
  } finally { db.close(); }
});

it.each([25, 26])('preserves unreleased Attention v%s instead of applying main migrations over it', version => {
  const draft = JSON.parse(readFileSync(new URL('./fixtures/attention-preintegration-migrations.json', import.meta.url), 'utf8')) as { migrations: typeof MIGRATIONS };
  const path = join(root, 'attention-draft.db'); const old = new Database(path);
  install(old, MIGRATIONS.filter(m => m.id <= 24));
  install(old, draft.migrations.filter(m => m.id <= version));
  old.exec("INSERT INTO daemon_owner VALUES (1,'home','owner',1)");
  old.close(); const before = readFileSync(path);
  for (const readwrite of [true, false]) expect(() => openDb({ path, readwrite })).toThrow('EXPERIMENTAL_SCHEMA_CONFLICT');
  expect(readFileSync(path).equals(before)).toBe(true);
});

it("rejects Attention tables mixed into main39 before advancing migrations", () => {
  const path = join(root, 'mixed-attention.db'); const old = new Database(path);
  install(old, MIGRATIONS.filter(m => m.id <= 39));
  old.exec(MIGRATIONS.find(m => m.id === 40)!.sql); old.close();
  const before = readFileSync(path);
  expect(() => openDb({ path })).toThrow('EXPERIMENTAL_SCHEMA_CONFLICT');
  expect(readFileSync(path).equals(before)).toBe(true);
});
