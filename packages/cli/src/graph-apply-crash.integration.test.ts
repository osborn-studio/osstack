import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { openDb } from '@osstack/core';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const build = realpathSync(mkdtempSync(join(tmpdir(), 'graph-apply-build-'))); const entry = join(build, 'fixture.mjs');
beforeAll(() => {
  symlinkSync(join(repo, 'packages/cli/node_modules'), join(build, 'node_modules'), 'dir');
  execFileSync(join(repo, 'node_modules/.bin/esbuild'), [join(repo, 'scripts/fixtures/graph-changeset-apply-crash.ts'), '--bundle', '--platform=node', '--format=esm', '--packages=external', `--outfile=${entry}`]);
});
afterAll(() => rmSync(build, { recursive: true, force: true }));
const points = ['before_gate', 'after_gate', 'before_create', 'after_create', 'before_delete', 'after_delete', 'before_replace', 'after_replace', 'before_complete', 'after_complete', 'before_file_sync', 'after_file_sync', 'before_create_dirsync', 'after_create_dirsync', 'before_delete_dirsync', 'after_delete_dirsync', 'before_replace_dirsync', 'after_replace_dirsync'];
it.each(points)('never falsely confirms or replays filesystem writes after SIGKILL at %s', point => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'graph-apply-crash-')));
  const run = (mode = '') => spawnSync(process.execPath, [entry, root, point, mode], { encoding: 'utf8', env: { ...process.env, OSSTACK_HOME: join(root, 'isolated') }, timeout: 15000 });
  try {
    const child = run(); expect(child.signal, child.stderr).toBe('SIGKILL');
    const metadata = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8')) as { key: string };
    const db = openDb({ path: join(root, 'state.db') });
    try {
      const action = db.prepare('SELECT state FROM graph_actions WHERE effect_key=?').get(metadata.key) as { state: string };
      expect(action.state).toBe(point === 'after_complete' ? 'confirmed' : 'running');
      const resolution = db.prepare('SELECT kind FROM graph_apply_resolutions WHERE effect_key=?').get(metadata.key) as { kind: string } | undefined;
      expect(resolution?.kind).toBe(point === 'after_complete' ? 'applied' : undefined);
      expect((db.prepare('SELECT released_at FROM graph_action_admissions WHERE effect_key=?').get(metadata.key) as { released_at: number | null }).released_at).toBeNull();
    } finally { db.close(); }
    // before_gate is provably before any durable apply permission and is allowed
    // a first apply on restart. Every other window must preserve physical bytes.
    if (point !== 'before_gate') {
      const snapshot = () => readdirSync(join(root, 'workspace')).filter(p => p !== '.git').sort().map(p => [p, readFileSync(join(root, 'workspace', p)).toString('base64')]);
      const before = snapshot(); const replay = run('resume'); expect(replay.status, replay.stderr).toBe(0); expect(snapshot()).toEqual(before);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 20000);
