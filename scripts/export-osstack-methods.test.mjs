import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { exportMethods, parseExportOptions } from './lib/osstack-method-export.mjs';

const run = promisify(execFile);
const names = ['osstack-mode', 'osstack-help', 'setup-osstack', 'osstack-agent'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const script = fileURLToPath(new URL('./export-osstack-methods.mjs', import.meta.url));
async function fixture(t) {
  const root = join(resolve(process.env.OSSTACK_SCRATCH_ROOT ?? join(tmpdir(), 'osstack')), 'tests', `method-export-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const sourceRoot = join(root, 'source');
  await mkdir(join(sourceRoot, 'references'), { recursive: true });
  await writeFile(join(sourceRoot, 'references/evidence.md'), '# Evidence\n[Detail](detail.md#limits)\n');
  await writeFile(join(sourceRoot, 'references/detail.md'), '# Detail\n## limits\n[Source](https://example.invalid/source)\n');
  for (const name of names) {
    await mkdir(join(sourceRoot, 'entries', name), { recursive: true });
    await writeFile(join(sourceRoot, 'entries', name, 'SKILL.md'), `---\nname: ${name}\ndescription: Test method\n---\n# Method\n[Evidence](../../references/evidence.md)\n[Help](../osstack-help/SKILL.md#usage)\n[More][details]\n[details]: ../../references/detail.md#limits\nLiteral prose: ../../references/not-a-link\n`);
  }
  return { root, sourceRoot, output: join(root, 'export') };
}
async function tree(root, rel = '') {
  const result = {};
  for (const name of (await readdir(join(root, rel))).sort()) {
    const next = rel ? `${rel}/${name}` : name;
    const info = await lstat(join(root, next));
    if (info.isDirectory()) Object.assign(result, await tree(root, next));
    else result[next] = info.isSymbolicLink() ? 'SYMLINK' : hash(await readFile(join(root, next)));
  }
  return result;
}

for (const [host, namespace] of [['codex', '.agents/skills'], ['claude', '.claude/skills']]) {
  test(`${host} exports self-contained methods with independently verifiable source/output hashes`, async t => {
    const f = await fixture(t); const before = await tree(f.sourceRoot);
    const result = await exportMethods({ ...f, host });
    assert.equal(result.exported, true); assert.equal(result.installed, false); assert.equal(result.host_discovery_verified, false);
    const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
    assert.equal(manifest.host, host); assert.equal(manifest.namespace, namespace);
    assert.deepEqual((await readdir(join(f.output, namespace))).sort(), [...names].sort());
    for (const name of names) {
      const entry = await readFile(join(f.output, namespace, name, 'SKILL.md'), 'utf8');
      assert.ok(entry.includes('[Evidence](references/evidence.md)'));
      assert.ok(entry.includes('[details]: references/detail.md#limits'));
      assert.ok(entry.includes('[Help](../osstack-help/SKILL.md#usage)'));
      assert.ok(entry.includes('Literal prose: ../../references/not-a-link'));
      assert.deepEqual(await readFile(join(f.output, namespace, name, 'references/evidence.md')), await readFile(join(f.sourceRoot, 'references/evidence.md')));
    }
    assert.equal(manifest.files.length, 12);
    for (const file of manifest.files) {
      assert.equal(file.sha256, hash(await readFile(join(f.output, file.path))));
      assert.equal(file.source_sha256, hash(await readFile(join(f.sourceRoot, file.source_path))));
    }
    assert.equal(result.manifest_sha256, hash(await readFile(join(f.output, 'manifest.json'))));
    assert.deepEqual(await tree(f.sourceRoot), before);
  });
}

test('dry-run leaves source and parent tree unchanged and plans exactly the real destinations', async t => {
  const f = await fixture(t); const before = await tree(f.root);
  const result = await exportMethods({ ...f, host: 'codex', dryRun: true });
  assert.equal(result.status, 'planned'); assert.equal(result.exported, false); assert.equal(result.installed, false);
  assert.equal(result.files.length, 12); assert.equal(existsSync(f.output), false);
  assert.deepEqual(await tree(f.root), before);
});

test('option parser rejects ambiguity and requires explicit absolute new project root', () => {
  assert.deepEqual(parseExportOptions(['--host', 'codex', '--output', '/tmp/new-project', '--dry-run']), { host: 'codex', output: '/tmp/new-project', dryRun: true });
  for (const argv of [[], ['--host', 'unknown', '--output', '/tmp/new'], ['--host', 'claude', '--output', 'relative'], ['--host', 'codex', '--host', 'claude', '--output', '/tmp/new'], ['--host', 'codex', '--output', '/tmp/new', '--dry-run', '--dry-run'], ['--host', 'codex', '--output', '/tmp/new', '--source', '/tmp/source']]) {
    assert.throws(() => parseExportOptions(argv), /usage/);
  }
});

for (const kind of ['directory', 'file', 'symlink', 'dangling-symlink']) {
  test(`refuses pre-existing ${kind} without changing its contents or target`, async t => {
    const f = await fixture(t);
    if (kind === 'directory') { await mkdir(f.output); await writeFile(join(f.output, 'sentinel'), 'keep'); }
    if (kind === 'file') await writeFile(f.output, 'keep');
    if (kind.includes('symlink')) await symlink(kind === 'symlink' ? f.sourceRoot : join(f.root, 'absent'), f.output);
    const before = await tree(f.root);
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), /output_exists/);
    assert.deepEqual(await tree(f.root), before);
  });
}

test('missing parent rejects without creating it', async t => {
  const f = await fixture(t); const output = join(f.root, 'absent/child');
  await assert.rejects(exportMethods({ ...f, output, host: 'codex' }), /output_parent/);
  assert.equal(existsSync(dirname(output)), false);
});

for (const target of ['../../../outside.md', '../../references/../../outside.md', '../../references/missing.md', 'file:///etc/passwd', '%2e%2e/%2e%2e/outside.md', '/etc/passwd', '..\\outside.md']) {
  test(`rejects unsafe or missing Markdown destination ${target} before output creation`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.sourceRoot, 'entries/osstack-mode/SKILL.md'), `# Bad\n[proof](${target})\n`);
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), /link_/);
    assert.equal(existsSync(f.output), false);
  });
}

test('reference-style link escape is validated, not just inline links', async t => {
  const f = await fixture(t);
  await writeFile(join(f.sourceRoot, 'references/detail.md'), '[proof][p]\n[p]: ../../outside.md\n');
  await assert.rejects(exportMethods({ ...f, host: 'claude' }), /link_/);
  assert.equal(existsSync(f.output), false);
});

for (const kind of ['entry', 'reference-file', 'reference-directory', 'source-root']) {
  test(`refuses ${kind} symlink before reading/copying external bytes`, async t => {
    const f = await fixture(t); let sourceRoot = f.sourceRoot;
    if (kind === 'entry') { const p = join(f.sourceRoot, 'entries/osstack-mode/SKILL.md'); await rm(p); await symlink(join(f.sourceRoot, 'references/evidence.md'), p); }
    if (kind === 'reference-file') await symlink(join(f.sourceRoot, 'entries/osstack-mode/SKILL.md'), join(f.sourceRoot, 'references/link.md'));
    if (kind === 'reference-directory') await symlink(join(f.sourceRoot, 'entries'), join(f.sourceRoot, 'references/nested'));
    if (kind === 'source-root') { sourceRoot = join(f.root, 'source-link'); await symlink(f.sourceRoot, sourceRoot); }
    await assert.rejects(exportMethods({ ...f, sourceRoot, host: 'codex' }), /source_symlink/);
    assert.equal(existsSync(f.output), false);
  });
}

test('oversized source is rejected without allocating output', async t => {
  const f = await fixture(t);
  await writeFile(join(f.sourceRoot, 'references/large.md'), Buffer.alloc(1024 * 1024 + 1, 97));
  await assert.rejects(exportMethods({ ...f, host: 'claude' }), /source_limit/);
  assert.equal(existsSync(f.output), false);
});

test('CLI invoked through a real symlink executes read-only planning instead of silent exit0', async t => {
  const f = await fixture(t); const linked = join(f.root, 'linked-export.mjs'); await symlink(script, linked);
  const result = await run(process.execPath, [linked, '--host', 'codex', '--output', f.output, '--dry-run'], { env: { ...process.env, PATH: '' }, timeout: 10000 });
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.status, 'planned'); assert.equal(receipt.exported, false); assert.equal(existsSync(f.output), false);
});


test('canonical shared reference bytes including UTF-8 BOM survive export unchanged', async t => {
  const f = await fixture(t);
  const bytes = Buffer.from('\ufeff# Evidence\r\n[Detail](detail.md#limits)\r\n');
  await writeFile(join(f.sourceRoot, 'references/evidence.md'), bytes);
  await exportMethods({ ...f, host: 'codex' });
  assert.deepEqual(await readFile(join(f.output, '.agents/skills/osstack-mode/references/evidence.md')), bytes);
});

test('refuses a new output inside the current global Codex home even in dry-run', async t => {
  const f = await fixture(t);
  const parent = join(homedir(), '.codex');
  if (!existsSync(parent)) return t.skip('global Codex home absent; do not create it for testing');
  const output = join(parent, `method-export-test-${randomUUID()}`);
  await assert.rejects(exportMethods({ ...f, output, host: 'codex', dryRun: true }), /output_protected_home/);
  assert.equal(existsSync(output), false);
});

test('nonregular entry is rejected before output reservation', async t => {
  const f = await fixture(t); const entry = join(f.sourceRoot, 'entries/osstack-mode/SKILL.md');
  await rm(entry); await mkdir(entry);
  await assert.rejects(exportMethods({ ...f, host: 'codex' }), /source_not_regular/);
  assert.equal(existsSync(f.output), false);
});

test('a real post-reservation write failure retains only the owned incomplete root and reports it', async t => {
  if (process.platform === 'win32' || process.getuid?.() === 0) return t.skip('POSIX owner permission failure requires non-root');
  const f = await fixture(t); const before = await tree(f.sourceRoot);
  const prior = process.umask(0o777);
  try {
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), error => {
      assert.equal(error.result.status, 'failed'); assert.equal(error.result.exported, false);
      assert.equal(error.result.output_created, true);
      assert.equal(error.result.cleanup, 'retained_incomplete_owned_output');
      return true;
    });
  } finally {
    process.umask(prior);
    if (existsSync(f.output)) await chmod(f.output, 0o700);
  }
  assert.equal(existsSync(f.output), true);
  assert.equal(existsSync(join(f.output, 'manifest.json')), false);
  assert.deepEqual(await tree(f.sourceRoot), before);
});

// Audit regressions: unsupported navigation must not be exported unchecked.
for (const content of [
  'See [the common\nevidence rules](../../references/evidence.md).',
  '[the [draft] plan](../../references/evidence.md)',
  '[![b](https://example.invalid/b.svg)](../../references/missing.md)',
]) {
  test(`unsupported complex Markdown rejects before reservation: ${JSON.stringify(content)}`, async t => {
    const f = await fixture(t);
    await writeFile(join(f.sourceRoot, 'entries/osstack-mode/SKILL.md'), content);
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), /link_unsupported/);
    assert.equal(existsSync(f.output), false);
  });
}

test('source-root trailing slash cannot bypass symlink refusal', async t => {
  const f = await fixture(t); const alias = join(f.root, 'source-alias'); await symlink(f.sourceRoot, alias);
  await assert.rejects(exportMethods({ ...f, sourceRoot: `${alias}/`, host: 'codex' }), /source_symlink/);
  assert.equal(existsSync(f.output), false);
});

for (const [label, content] of [['brackets', '['.repeat(200000)], ['angles', '<'.repeat(200000)], ['backticks', '`'.repeat(20000)]]) {
  test(`bounded subprocess handles hostile ${label} within source byte cap`, async t => {
    const f = await fixture(t); await writeFile(join(f.sourceRoot, 'references/hostile.md'), content);
    const helper = new URL('./lib/osstack-method-export.mjs', import.meta.url).href;
    const source = `import { exportMethods } from ${JSON.stringify(helper)}; console.log(JSON.stringify(await exportMethods(${JSON.stringify({ ...f, host: 'codex', dryRun: true })})));`;
    const result = await run(process.execPath, ['--input-type=module', '-e', source], { timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.equal(JSON.parse(result.stdout).status, 'planned'); assert.equal(existsSync(f.output), false);
  });
}

for (const name of ['.DS_Store', 'unchecked.MD', 'unchecked.markdown', 'opaque.bin']) {
  test(`refuses unsupported reference material ${name} instead of unchecked copying`, async t => {
    const f = await fixture(t); await writeFile(join(f.sourceRoot, 'references', name), '[p](../../outside.md)');
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), /source_format/); assert.equal(existsSync(f.output), false);
  });
}

for (const variable of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OSSTACK_HOME']) {
  test(`protects explicitly configured ${variable} without reading its contents`, async t => {
    const f = await fixture(t); const configured = join(f.root, 'configured-home'); await mkdir(configured);
    const helper = new URL('./lib/osstack-method-export.mjs', import.meta.url).href;
    const source = `import { exportMethods } from ${JSON.stringify(helper)}; try { await exportMethods(${JSON.stringify({ ...f, output: join(configured, 'new'), host: 'codex', dryRun: true })}); process.exitCode=9; } catch(e) { if (!/output_protected_home/.test(e.message)) throw e; console.log('protected'); }`;
    const result = await run(process.execPath, ['--input-type=module', '-e', source], { env: { ...process.env, [variable]: configured }, timeout: 4000 });
    assert.equal(result.stdout.trim(), 'protected'); assert.deepEqual(await readdir(configured), []);
  });
}

test('actual canonical tree exports both host layouts and reproducible source digest', async t => {
  const f = await fixture(t); const sourceRoot = resolve(dirname(script), '../osstack-methods-skill'); const before = await tree(sourceRoot);
  for (const host of ['codex', 'claude']) {
    const output = join(f.root, host); const result = await exportMethods({ sourceRoot, output, host });
    assert.equal(result.status, 'exported');
    const manifest = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8'));
    const rows = manifest.source_files.map(row => ({ path: row.path, bytes: row.bytes, sha256: row.sha256 })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    assert.equal(manifest.source_digest, hash(JSON.stringify(rows)));
    for (const file of manifest.files) assert.equal(hash(await readFile(join(output, file.path))), file.sha256);
  }
  assert.deepEqual(await tree(sourceRoot), before);
});

test('unclosed angle prose cannot hide a later escaping Markdown link', async t => {
  const f = await fixture(t); await writeFile(join(f.sourceRoot, 'references/detail.md'), '< unclosed prose [escape](../../outside.md)');
  await assert.rejects(exportMethods({ ...f, host: 'codex' }), /link_missing_or_escape/); assert.equal(existsSync(f.output), false);
});

test('code masking preserves examples while plain navigation and Unicode destinations remain checked', async t => {
  const f = await fixture(t);
  await writeFile(join(f.sourceRoot, 'entries/osstack-mode/SKILL.md'), '# 🌱\n`[not a link](../../../outside.md)`\n```md\n[also code](../../../outside.md)\n````\n[🌱 proof](../../references/evidence.md)\n');
  await exportMethods({ ...f, host: 'codex' });
  const text = await readFile(join(f.output, '.agents/skills/osstack-mode/SKILL.md'), 'utf8');
  assert.ok(text.includes('[🌱 proof](references/evidence.md)')); assert.ok(text.includes('`[not a link](../../../outside.md)`'));
});

for (const content of ['[x](../../references/evidence.md "title")', '<img srcset="outside.png">', '[x](\n../../references/evidence.md)']) {
  test(`unsupported navigation is rejected: ${JSON.stringify(content)}`, async t => {
    const f = await fixture(t); await writeFile(join(f.sourceRoot, 'entries/osstack-mode/SKILL.md'), content);
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), /link_unsupported/); assert.equal(existsSync(f.output), false);
  });
}

for (const content of ['[long\nlabel]: ../../outside.md', '<file:///etc/passwd>']) {
  test(`other unsupported Markdown navigation fails closed: ${JSON.stringify(content)}`, async t => {
    const f = await fixture(t); await writeFile(join(f.sourceRoot, 'references/detail.md'), content);
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), /link_unsupported/); assert.equal(existsSync(f.output), false);
  });
}

for (const [label, content] of [
  ['inline-like fence info', '```npm i``` is the command\n[x](../../references/missing.md)\n'],
  ['LF opener CRLF closer', '```md\nexample\n```\r\n[x](../../references/missing.md)\n'],
  ['escaped inline backticks', '\\` [x](../../references/missing.md) \\`\n'],
]) {
  test(`code masking cannot hide real navigation: ${label}`, async t => {
    const f = await fixture(t); await writeFile(join(f.sourceRoot, 'entries/osstack-mode/SKILL.md'), content);
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), /link_/); assert.equal(existsSync(f.output), false);
  });
}

test('all-CRLF fenced examples are code and retain bytes', async t => {
  const f = await fixture(t); const content = '```md\r\n[x](../../outside.md)\r\n```\r\n';
  await writeFile(join(f.sourceRoot, 'references/detail.md'), content);
  await exportMethods({ ...f, host: 'codex' });
  assert.equal(await readFile(join(f.output, '.agents/skills/osstack-mode/references/detail.md'), 'utf8'), content);
});

for (const prefix of ['- ', '> ', '  1. ', '> - ']) {
  test(`container-prefixed reference definition fails closed: ${JSON.stringify(prefix)}`, async t => {
    const f = await fixture(t); await writeFile(join(f.sourceRoot, 'references/detail.md'), `${prefix}[x]: ../../outside.md\n`);
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), /link_unsupported/); assert.equal(existsSync(f.output), false);
  });
}

for (const [label, content] of [
  ['dense-entry-links', '[a](../../references/evidence.md)\n'.repeat(30000)],
  ['prefixed-mixed-inline-backticks', 'prefix ' + ('`x``y```z````q ').repeat(12000)],
]) {
  test(`bounded subprocess export scanning and rewriting: ${label}`, async t => {
    const f = await fixture(t);
    for (const name of label === 'dense-entry-links' ? names : ['osstack-mode']) await writeFile(join(f.sourceRoot, 'entries', name, 'SKILL.md'), content);
    const helper = new URL('./lib/osstack-method-export.mjs', import.meta.url).href;
    const source = `import { exportMethods } from ${JSON.stringify(helper)}; console.log(JSON.stringify(await exportMethods(${JSON.stringify({ ...f, host: 'codex', dryRun: true })})));`;
    const start = performance.now();
    try {
      const result = await run(process.execPath, ['--input-type=module', '-e', source], { timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
      assert.equal(JSON.parse(result.stdout).status, 'planned'); assert.equal(existsSync(f.output), false);
    } finally { t.diagnostic(`${label} child wall milliseconds: ${performance.now() - start}`); }
  });
}

test('document-named source router, four entries and six method references actually exist', async () => {
  const sourceRoot = resolve(dirname(script), '../osstack-methods-skill');
  for (const path of ['SKILL.md', ...names.map(name => `entries/${name}/SKILL.md`), ...['feature', 'refactoring', 'bug-fix', 'investigation', 'create-verification', 'maintain-verification'].map(name => `references/${name}.md`)]) {
    assert.equal((await lstat(join(sourceRoot, path))).isFile(), true, path);
    assert.ok((await readFile(join(sourceRoot, path), 'utf8')).trim().length > 0, path);
  }
});

test('quoted angle in an HTML attribute cannot hide navigation', async t => {
  const f = await fixture(t); await writeFile(join(f.sourceRoot, 'references/detail.md'), '<a title="a>b" href="../../outside.md">x</a>');
  await assert.rejects(exportMethods({ ...f, host: 'codex' }), /link_unsupported/); assert.equal(existsSync(f.output), false);
});

test('angle Markdown destinations and HTTP autolinks remain usable without enabling HTML', async t => {
  const f = await fixture(t); await writeFile(join(f.sourceRoot, 'entries/osstack-mode/SKILL.md'), '[p](<../../references/evidence.md>)\n<https://example.invalid/path?a=b>\n<mailto:test@example.invalid>\n');
  await exportMethods({ ...f, host: 'codex' });
  const actual = await readFile(join(f.output, '.agents/skills/osstack-mode/SKILL.md'), 'utf8');
  assert.ok(actual.includes('[p](<references/evidence.md>)')); assert.ok(actual.includes('<https://example.invalid/path?a=b>'));
});

test('long noncontainer prefix with many colon labels is scanned only once per line', async t => {
  const f = await fixture(t);
  await writeFile(join(f.sourceRoot, 'references/dense-prefix.md'), '- '.repeat(200000) + 'x' + '[a]:'.repeat(120000));
  const helper = new URL('./lib/osstack-method-export.mjs', import.meta.url).href;
  const source = `import { exportMethods } from ${JSON.stringify(helper)}; console.log(JSON.stringify(await exportMethods(${JSON.stringify({ ...f, host: 'codex', dryRun: true })})));`;
  const start = performance.now();
  try {
    const result = await run(process.execPath, ['--input-type=module', '-e', source], { timeout: 4000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024 });
    assert.equal(JSON.parse(result.stdout).status, 'planned'); assert.equal(existsSync(f.output), false);
  } finally { t.diagnostic(`dense-prefix child wall milliseconds: ${performance.now() - start}`); }
});

// D2a exercises the shipped material graph through the real CLI, not fixture-only wording.
for (const [host, namespace] of [['codex', '.agents/skills'], ['claude', '.claude/skills']]) {
  test(`D2a ${host} CLI exports reachable feature and refactoring methods for every entry`, async t => {
    const f = await fixture(t);
    const sourceRoot = resolve(dirname(script), '../osstack-methods-skill');
    const before = await tree(sourceRoot);
    const { stdout } = await run(process.execPath, [script, '--host', host, '--output', f.output], { timeout: 10000 });
    const receipt = JSON.parse(stdout);
    assert.equal(receipt.exported, true);
    assert.equal(receipt.host_discovery_verified, false);
    const manifest = JSON.parse(await readFile(join(f.output, 'manifest.json'), 'utf8'));
    for (const name of names) {
      const entryRoot = join(f.output, namespace, name);
      const seen = new Set(); const queue = [join(entryRoot, 'SKILL.md')];
      while (queue.length) {
        const path = queue.shift();
        if (seen.has(path)) continue;
        seen.add(path);
        const text = await readFile(path, 'utf8');
        for (const [, target] of text.matchAll(/\[[^\]\n]+\]\(([^)\s]+)\)/g)) {
          if (/^(https?:|mailto:|#)/.test(target)) continue;
          queue.push(resolve(dirname(path), target.split('#')[0]));
        }
      }
      for (const method of ['feature', 'refactoring']) {
        // All entries copy the canonical method. Delegation/help/setup must also reach it.
        const outputPath = join(entryRoot, 'references', `${method}.md`);
        const sourcePath = `references/${method}.md`;
        assert.deepEqual(await readFile(outputPath), await readFile(join(sourceRoot, sourcePath)));
        assert.ok([...seen].some(path => path.endsWith(`/references/${method}.md`)), `${name} cannot reach ${method}`);
        const row = manifest.files.find(file => file.path === `${namespace}/${name}/references/${method}.md`);
        assert.ok(row, `${name} ${method} missing from manifest`);
        assert.equal(row.sha256, hash(await readFile(outputPath)));
        assert.equal(row.source_sha256, hash(await readFile(join(sourceRoot, sourcePath))));
      }
    }
    assert.deepEqual(await tree(sourceRoot), before);
  });
}

for (const method of ['feature', 'refactoring']) {
  test(`D2a a missing advertised ${method} reference fails before reserving output`, async t => {
    const f = await fixture(t);
    await rm(f.sourceRoot, { recursive: true });
    await cp(resolve(dirname(script), '../osstack-methods-skill'), f.sourceRoot, { recursive: true });
    await rm(join(f.sourceRoot, 'references', `${method}.md`));
    await assert.rejects(exportMethods({ ...f, host: 'codex' }), /link_missing_or_escape/);
    assert.equal(existsSync(f.output), false);
  });
}
