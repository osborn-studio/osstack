import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { createScratchDir } from './lib/scratch.mjs';

async function fixture(t, mode = 'pass') {
  const root = await createScratchDir('tests', 'portable-cli');
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts/lib'), { recursive: true });
  await mkdir(join(root, 'packages/cli/dist'), { recursive: true });
  for (const file of ['verify-portable-cli.mjs', 'lib/scratch.mjs']) {
    await copyFile(new URL(file, import.meta.url), join(root, 'scripts', file));
  }
  if (mode !== 'missing') await writeFile(join(root, 'packages/cli/dist/bin.js'), `
    const fs = require('node:fs'); const path = require('node:path');
    const [cmd, ...args] = process.argv.slice(2);
    const files = ['.agent/PROJECT_CONTEXT.md', 'AGENTS.md', 'docs/PRD.md', 'docs/ARCHITECTURE.md', 'docs/SPRINTS.md'];
    if (cmd === '--help') process.exit(0);
    if (cmd === 'init') {
      const dir = args[0]; fs.mkdirSync(path.join(dir, 'tasks'), {recursive:true});
      for (const file of files) {
        const dest = path.join(dir, file); fs.mkdirSync(path.dirname(dest), {recursive:true});
        if (fs.existsSync(dest)) console.log('  skipped  ' + dest + ' (already exists)');
        else { fs.writeFileSync(dest, 'fixture'); console.log('  created  ' + dest); }
      }
    } else if (cmd === 'doctor') {
      console.log(JSON.stringify({ok: ${mode !== 'fail'}, loop: {daemon_checked:false, checks:
        ['workspace', 'task_queue', 'state_file', 'git', 'agent_instructions', 'protected_config'].map(id =>
          ({id, status: ['state_file','git','protected_config'].includes(id) ? 'warn' : 'ok'}))}}));
    }
  `);
  const result = spawnSync(process.execPath, [join(root, 'scripts/verify-portable-cli.mjs')], {
    encoding: 'utf8', env: { ...process.env, OSSTACK_SCRATCH_ROOT: join(root, 'scratch') },
  });
  return { root, result };
}

test('all fixed assertions pass, digests are emitted, scratch is removed', async t => {
  const { root, result } = await fixture(t);
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout);
  assert.deepEqual(summary.checks.map(c => [c.id, c.pass, c.exit_code]), [
    ['init_scaffold', true, 0], ['init_idempotent', true, 0], ['doctor_reports_ok', true, 0],
  ]);
  assert.match(summary.inputs.cli_sha256, /^[a-f0-9]{64}$/);
  assert.match(summary.inputs.script_sha256, /^[a-f0-9]{64}$/);
  assert.ok(!result.stdout.includes(root));
  assert.deepEqual(await readdir(join(root, 'scratch/smoke')), []);
});

test('an assertion failure exits 1 and identifies the failed check', async t => {
  const { result } = await fixture(t, 'fail');
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).checks.filter(c => !c.pass).map(c => c.id), ['doctor_reports_ok']);
});

test('missing build exits 2 with a setup message', async t => {
  const { result } = await fixture(t, 'missing');
  assert.equal(result.status, 2);
  assert.match(result.stderr, /setup: missing CLI build/);
  assert.deepEqual(JSON.parse(result.stdout).checks, []);
});
