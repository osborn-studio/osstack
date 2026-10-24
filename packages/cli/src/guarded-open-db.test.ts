import { existsSync, linkSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createScratchDirSync } from '@osstack/core';
import { afterEach, expect, it } from 'vitest';
import { guardedOpenDb } from './guarded-open-db.js';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(createScratchDirSync('tests', 'guarded-db'));
  roots.push(root);
  const home = join(root, 'managed'), alias = join(root, 'outside');
  mkdirSync(home, { mode: 0o700 }); mkdirSync(alias, { mode: 0o700 });
  return { home, alias };
}
it('checks the target managed home before migrating a database reached through an external symlink', () => {
  const { home, alias } = fixture();
  const target = join(home, 'state.db'), path = join(alias, 'state.db');
  new Database(target).close();
  writeFileSync(join(home, 'managed-consumer.json'), '{}', { mode: 0o600 });
  symlinkSync(target, path);
  expect(() => guardedOpenDb({ path })).toThrow();
  const check = new Database(target);
  try { expect(check.pragma('user_version', { simple: true })).toBe(0); } finally { check.close(); }
});
it('rejects a dangling database symlink before SQLite can create its target', () => {
  const { home, alias } = fixture();
  const target = join(home, 'state.db'), path = join(alias, 'state.db');
  symlinkSync(target, path);
  expect(() => guardedOpenDb({ path })).toThrow('db_path_not_single_file');
  expect(existsSync(target)).toBe(false);
});
it('opens a new database under an ordinary explicit scratch home', () => {
  const { alias } = fixture();
  const db = guardedOpenDb({ path: join(alias, 'state.db') });
  try { expect(db.pragma('user_version', { simple: true })).toBeGreaterThan(0); } finally { db.close(); }
});

it('rejects hardlinked database aliases without migrating their shared inode', () => {
  const { home, alias } = fixture(); const target = join(home, 'state.db'); new Database(target).close();
  const path = join(alias, 'state.db'); linkSync(target, path);
  expect(() => guardedOpenDb({ path })).toThrow('db_path_not_single_file');
  const check = new Database(target); try { expect(check.pragma('user_version', { simple: true })).toBe(0); } finally { check.close(); }
});
it('preserves an explicitly in-memory database', () => {
  const db = guardedOpenDb({ path: ':memory:' }); try { expect(db.name).toBe(':memory:'); } finally { db.close(); }
});

it('refuses a managed-home database symlink to an unmanaged target', () => {
 const {home,alias}=fixture();const target=join(alias,'state.db');new Database(target).close();
 writeFileSync(join(home,'managed-consumer.json'),'{}',{mode:0o600});symlinkSync(target,join(home,'state.db'));
 expect(()=>guardedOpenDb({path:join(home,'state.db')})).toThrow('db_path_not_single_file');
 const check=new Database(target);try{expect(check.pragma('user_version',{simple:true})).toBe(0);}finally{check.close();}
});
it.each(['-wal','-shm','-journal'])('refuses a hardlinked SQLite %s sidecar before opening', suffix=>{
 const {home,alias}=fixture();const target=join(home,'unrelated');writeFileSync(target,'preserved');const path=join(alias,'state.db');
 linkSync(target,path+suffix);expect(()=>guardedOpenDb({path})).toThrow('db_path_not_single_file');expect(existsSync(path)).toBe(false);
});
