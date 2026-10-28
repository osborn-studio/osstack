import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, basename } from 'node:path';
import { test } from 'node:test';
import { createScratchDir, scratchRoot } from './lib/scratch.mjs';
import { prepareNodeHeaders } from './prepare-node-headers.mjs';

async function fixture(t, options = {}) {
  const root = await createScratchDir('tests', 'node-headers');
  t.after(() => rm(root, { recursive: true, force: true }));
  const version = process.versions.node;
  const name = `node-v${version}`;
  const archiveName = `${name}-headers.tar.gz`;
  await mkdir(join(root, 'source', name, 'include', 'node'), { recursive: true });
  const [major, minor, patch] = version.split('.');
  await writeFile(join(root, 'source', name, 'include', 'node', 'node_version.h'), `#define NODE_MAJOR_VERSION ${major}\n#define NODE_MINOR_VERSION ${minor}\n#define NODE_PATCH_VERSION ${options.patch ?? patch}\n#define NODE_MODULE_VERSION ${options.abi ?? process.versions.modules}\n`);
  await writeFile(join(root, 'source', name, 'include', 'node', 'config.gypi'), '{}');
  execFileSync('tar', ['-czf', join(root, 'fixture.tar.gz'), '-C', join(root, 'source'), name]);
  const archive = await readFile(join(root, 'fixture.tar.gz'));
  const digest = createHash('sha256').update(archive).digest('hex');
  const counts = { sums: 0, archive: 0 };
  const server = createServer((req, res) => {
    const kind = req.url.endsWith('SHASUMS256.txt') ? 'sums' : 'archive';
    counts[kind]++;
    if (options.serve?.({ req, res, kind, count: counts[kind], archive })) return;
    res.end(kind === 'sums' ? `${options.badDigest ? '0'.repeat(64) : digest}  ${archiveName}\n` : archive);
  });
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  t.after(async () => { const closed = new Promise((resolve) => server.close(resolve)); for (const socket of sockets) socket.destroy(); await closed; });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const output = join(root, 'output');
  const run = (extra = {}) => prepareNodeHeaders({ output, baseUrl: `http://127.0.0.1:${server.address().port}`, timeoutMs: 1000, retryDelayMs: 0, log: () => {}, ...extra });
  return { root, name, counts, output, run, digest, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

test('official-layout archive is verified, extracted and bound to actual runtime ABI', async (t) => {
  const f = await fixture(t);
  const result = await f.run();
  assert.equal(result.sha256, f.digest);
  assert.equal(result.runtime_version, process.versions.node);
  assert.equal(result.runtime_abi, process.versions.modules);
  assert.equal(result.nodedir, join(f.output, f.name));
  assert.deepEqual(f.counts, { sums: 1, archive: 1 });
  assert.equal(JSON.parse(await readFile(join(f.output, 'receipt.json'), 'utf8')).status, 'verified');
});

test('HTTP503 retries and subsequently verifies the complete archive', async (t) => {
  const f = await fixture(t, { serve: ({ res, kind, count }) => { if (kind === 'archive' && count === 1) { res.writeHead(503); res.end('busy'); return true; } } });
  await f.run();
  assert.equal(f.counts.archive, 2);
});

test('HTTP404 fails without retry or extraction', async (t) => {
  const f = await fixture(t, { serve: ({ res }) => { res.writeHead(404); res.end('missing'); return true; } });
  await assert.rejects(f.run(), /HTTP 404/);
  assert.equal(f.counts.sums, 1);
  await assert.rejects(access(join(f.output, f.name)));
});

test('HTTP200 stalled body has finite retries and a whole-body deadline', async (t) => {
  const f = await fixture(t, { serve: ({ res, kind }) => { if (kind === 'archive') { res.writeHead(200); res.write('partial'); return true; } } });
  const started = Date.now();
  await assert.rejects(f.run({ timeoutMs: 100 }), /deadline/);
  assert.equal(f.counts.archive, 3);
  assert.ok(Date.now() - started < 3000);
  await assert.rejects(access(join(f.output, f.name)));
});

test('aborted response body is discarded before a fresh complete retry', async (t) => {
  const f = await fixture(t, { serve: ({ res, kind, count }) => { if (kind === 'archive' && count === 1) { res.writeHead(200, { 'Content-Length': 10000 }); res.write('partial'); setTimeout(() => res.destroy(), 5); return true; } } });
  await f.run();
  assert.equal(f.counts.archive, 2);
});

test('checksum mismatch never extracts and never retries archive', async (t) => {
  const f = await fixture(t, { badDigest: true });
  await assert.rejects(f.run(), /SHA256 mismatch/);
  assert.equal(f.counts.archive, 1);
  await assert.rejects(access(join(f.output, f.name)));
});

for (const [label, options] of [['ABI', { abi: '9999' }], ['version', { patch: '9999' }]]) {
  test(`matching digest cannot hide ${label} mismatch`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(f.run(), /runtime.*mismatch/);
    await assert.rejects(access(join(f.output, 'receipt.json')));
  });
}

test('existing output is untouched and no network is attempted', async (t) => {
  const f = await fixture(t);
  await mkdir(f.output);
  await writeFile(join(f.output, 'sentinel'), 'keep');
  await assert.rejects(f.run(), /EEXIST/);
  assert.equal(await readFile(join(f.output, 'sentinel'), 'utf8'), 'keep');
  assert.deepEqual(f.counts, { sums: 0, archive: 0 });
});

test('oversized responses fail closed without retries', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run({ maxSumsBytes: 2 }), /byte limit/);
  assert.equal(f.counts.sums, 1);
});


test('retry exhaustion disposes stalled sockets and a real child exits naturally', async (t) => {
  const f = await fixture(t, { serve: ({ res, kind }) => {
    if (kind === 'archive') { res.writeHead(200); res.write('partial'); return true; }
  } });
  const source = `import { prepareNodeHeaders } from ${JSON.stringify(new URL('./prepare-node-headers.mjs', import.meta.url).href)};
    try { await prepareNodeHeaders(${JSON.stringify({ output: f.output, baseUrl: f.baseUrl, timeoutMs: 150, retryDelayMs: 0 })}); }
    catch (error) { console.error(error.message); process.exitCode = 1; }`;
  const result = await new Promise((resolve) => execFile(process.execPath, ['--input-type=module', '-e', source],
    { timeout: 3000 }, (error, stdout, stderr) => resolve({ error, stdout, stderr })));
  assert.equal(result.error?.code, 1);
  assert.equal(result.error?.killed, false, 'parent timeout/kill is failure, not successful cleanup');
  assert.equal(result.error?.signal, null);
  assert.match(result.stderr, /deadline 150ms/);
  assert.equal(f.counts.archive, 3);
});

test('retryable HTTP failure exhausts exactly three attempts', async (t) => {
  const f = await fixture(t, { serve: ({ res }) => { res.writeHead(503); res.end('busy'); return true; } });
  await assert.rejects(f.run(), /HTTP 503/);
  assert.equal(f.counts.sums, 3);
});

test('duplicate official checksum entries are rejected before archive download', async (t) => {
  const f = await fixture(t, { serve: ({ res, kind }) => {
    if (kind === 'sums') { const line = `${'0'.repeat(64)}  node-v${process.versions.node}-headers.tar.gz\n`; res.end(line + line); return true; }
  } });
  await assert.rejects(f.run(), /exactly one/);
  assert.equal(f.counts.archive, 0);
});


test('standalone scratch helper matches canonical root and safe directory layout', async (t) => {
  assert.equal(scratchRoot({}), join(tmpdir(), 'osstack'));
  assert.equal(scratchRoot({ OSSTACK_SCRATCH_ROOT: ' relative-root ' }), resolve('relative-root'));
  await assert.rejects(createScratchDir('../escape', 'label'), /invalid scratch kind/);
  const outer = await createScratchDir('tests', 'headers-helper');
  t.after(() => rm(outer, { recursive: true, force: true }));
  const inner = await createScratchDir('smoke', '../unsafe label', { OSSTACK_SCRATCH_ROOT: outer });
  assert.ok(inner.startsWith(join(outer, 'smoke') + '/'));
  assert.match(basename(inner), /^unsafe-label-[a-zA-Z0-9]+$/);
});
