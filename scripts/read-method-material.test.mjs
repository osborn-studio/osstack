import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createScratchDir } from './lib/scratch.mjs';

const reader = fileURLToPath(new URL('./read-method-material.mjs', import.meta.url));
const exporter = fileURLToPath(new URL('./export-osstack-methods.mjs', import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t, content = '') {
  const dir = await createScratchDir('tests', 'method-reader');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'material.md');
  writeFileSync(file, content);
  return { dir, file };
}
function invoke(args) {
  const result = spawnSync(process.execPath, [reader, ...args], { encoding: 'utf8', timeout: 3000, maxBuffer: 256 * 1024 });
  assert.ifError(result.error);
  return result;
}
function page(file, ...args) {
  const result = invoke(['--file', file, ...args]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}
function refused(args, code) {
  const result = invoke(args);
  assert.equal(result.status, 1, result.stdout);
  assert.equal(result.stdout, '');
  const error = JSON.parse(result.stderr);
  assert.deepEqual(error, { schema_version: 1, error: code });
}
for (const count of [64, 65]) for (const terminal of ['', '\n']) {
  test(`${count} lines terminal LF=${!!terminal}: default page cannot hide tail`, async t => {
    const content = Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n') + terminal;
    const { file } = await fixture(t, content);
    const first = page(file);
    assert.equal(first.total_lines, count);
    assert.equal(first.end, 60);
    assert.equal(first.eof, false);
    assert.equal(first.next_start, 61);
    assert.equal(first.sha256, digest(content));
    refused(['--file', file, '--start', '61'], 'sha256_required');
    const tail = page(file, '--start', '61', '--sha256', first.sha256);
    assert.equal(tail.end, count);
    assert.equal(tail.eof, true);
    assert.equal(tail.next_start, null);
    assert.equal(first.text + tail.text, content);
  });
}
test('preserves mixed endings, blank lines, Unicode and BOM bytes', async t => {
  const content = '\ufeff中文\r\n\nend\r';
  const { file } = await fixture(t, content);
  const first = page(file, '--lines', '1');
  const tail = page(file, '--start', '2', '--lines', '2', '--sha256', first.sha256);
  assert.equal(first.text, '\ufeff中文\r\n');
  assert.equal(first.text + tail.text, content);
  assert.equal(tail.total_lines, 3);
  assert.equal(tail.file_bytes, Buffer.byteLength(content));
});
test('empty and newline-only files have distinct line counts', async t => {
  const { file } = await fixture(t);
  const empty = page(file);
  assert.deepEqual([empty.total_lines, empty.start, empty.end, empty.text, empty.eof, empty.next_start], [0, 1, 0, '', true, null]);
  writeFileSync(file, '\n');
  assert.equal(page(file).total_lines, 1);
  refused(['--file', file, '--start', '2', '--sha256', digest('\n')], 'start_beyond_eof');
});
test('same-size drift and first-page hash mismatch return no content', async t => {
  const { file } = await fixture(t, 'a\nb\n');
  const first = page(file, '--lines', '1');
  writeFileSync(file, 'a\nc\n');
  refused(['--file', file, '--start', '2', '--sha256', first.sha256], 'sha256_mismatch');
  refused(['--file', file, '--sha256', first.sha256], 'sha256_mismatch');
});
test('text cap measures UTF8 bytes, allows exact cap and permits smaller page', async t => {
  const { file } = await fixture(t, 'é'.repeat(8192));
  assert.equal(Buffer.byteLength(page(file).text), 16384);
  writeFileSync(file, 'é'.repeat(8193));
  refused(['--file', file], 'page_too_large');
  writeFileSync(file, 'a'.repeat(9000) + '\n' + 'b'.repeat(9000));
  refused(['--file', file], 'page_too_large');
  assert.equal(page(file, '--lines', '1').eof, false);
});
test('file cap, invalid UTF8 and missing files are bounded errors', async t => {
  const { file } = await fixture(t, Buffer.alloc(1048577, 97));
  refused(['--file', file], 'file_too_large');
  writeFileSync(file, Buffer.from([0xc0, 0xaf]));
  refused(['--file', file], 'invalid_utf8');
  rmSync(file);
  refused(['--file', file], 'file_unavailable');
});
test('rejects terminal symlink, directory and FIFO without blocking', async t => {
  const { dir, file } = await fixture(t, 'secret marker');
  const link = join(dir, 'link');
  symlinkSync(file, link);
  refused(['--file', link], 'not_regular_file');
  refused(['--file', dir], 'not_regular_file');
  if (process.platform !== 'win32') {
    const fifo = join(dir, 'fifo');
    const make = spawnSync('mkfifo', [fifo]);
    assert.equal(make.status, 0);
    refused(['--file', fifo], 'not_regular_file');
  }
});
test('strict argument validation', async t => {
  const { file } = await fixture(t, 'one');
  for (const args of [[], ['--file'], ['--other', 'x'], ['--help', '--file', file], ['--file', file, '--file', file], ['--file', ''], ...['0', '-1', '1.5', '01', '1e2', '9007199254740992'].map(n => ['--file', file, '--start', n]), ['--file', file, '--lines', '201'], ['--file', file, '--sha256', 'bad']]) {
    refused(args, 'invalid_arguments');
  }
  assert.equal(page(file, '--lines', '200').eof, true);
});
test('help is available without reading a file', () => {
  const result = invoke(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /--sha256/);
  assert.match(result.stdout, /understanding/);
});
for (const host of ['codex', 'claude']) test(`${host} actual export material roundtrips through hash-pinned pages`, async t => {
  const { dir } = await fixture(t);
  const output = join(dir, 'export');
  const exported = spawnSync(process.execPath, [exporter, '--host', host, '--output', output], { encoding: 'utf8', timeout: 5000 });
  assert.equal(exported.status, 0, exported.stderr);
  const namespace = host === 'codex' ? '.agents' : '.claude';
  const file = join(output, namespace, 'skills/osstack-mode/references/evidence.md');
  const original = readFileSync(file);
  const chunks = [];
  let current = page(file, '--lines', '7');
  while (true) {
    chunks.push(current.text);
    if (current.eof) break;
    current = page(file, '--start', String(current.next_start), '--lines', '7', '--sha256', current.sha256);
  }
  assert.deepEqual(Buffer.from(chunks.join('')), original);
  assert.equal(current.sha256, digest(original));
});
