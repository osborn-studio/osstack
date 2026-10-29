#!/usr/bin/env node
// Read a bounded snapshot; hash/EOF describe returned bytes, not model understanding.
import { constants, openSync, closeSync, fstatSync, lstatSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const FILE_LIMIT = 1024 * 1024;
const TEXT_LIMIT = 16 * 1024;
const fail = code => { throw new Error(code); };

function options(args) {
  const result = { start: 1, lines: 60 };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i];
    const value = args[i + 1];
    if (!['--file', '--start', '--lines', '--sha256'].includes(flag) || seen.has(flag) || !value) fail('invalid_arguments');
    seen.add(flag);
    const key = flag.slice(2);
    if (key === 'start' || key === 'lines') {
      if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value))) fail('invalid_arguments');
      result[key] = Number(value);
    } else result[key] = value;
  }
  if (!result.file || result.file.includes('\0') || result.lines > 200 || (result.sha256 !== undefined && !/^[a-fA-F0-9]{64}$/.test(result.sha256))) fail('invalid_arguments');
  if (result.start > 1 && !result.sha256) fail('sha256_required');
  return result;
}

function readSnapshot(path) {
  let fd;
  try {
    // Check before open to avoid FIFO/device blocking; NOFOLLOW and NONBLOCK
    // also protect the open against a terminal-component replacement race.
    if (!lstatSync(path).isFile()) fail('not_regular_file');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd);
    if (!before.isFile()) fail('not_regular_file');
    if (before.size > FILE_LIMIT) fail('file_too_large');
    const buffer = Buffer.alloc(FILE_LIMIT + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size > FILE_LIMIT) fail('file_too_large');
    const after = fstatSync(fd);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || size !== after.size) fail('file_changed');
    return buffer.subarray(0, size);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readPage(input) {
  const path = resolve(input.file);
  const bytes = readSnapshot(path);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (input.sha256 && input.sha256.toLowerCase() !== sha256) fail('sha256_mismatch');
  let content;
  try {
    // ignoreBOM means decode it as content, rather than stripping it.
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch { fail('invalid_utf8'); }
  const lines = content === '' ? [] : content.split('\n');
  if (content.endsWith('\n')) lines.pop();
  const total = lines.length;
  if (input.start > total && !(total === 0 && input.start === 1)) fail('start_beyond_eof');
  const end = Math.min(input.start - 1 + input.lines, total);
  let text = lines.slice(input.start - 1, end).join('\n');
  if (end > 0 && (end < total || content.endsWith('\n'))) text += '\n';
  if (Buffer.byteLength(text, 'utf8') > TEXT_LIMIT) fail('page_too_large');
  const eof = end === total;
  return { schema_version: 1, path, sha256, file_bytes: bytes.length, total_lines: total, start: input.start, end, text, eof, next_start: eof ? null : end + 1 };
}

const help = `Usage: node scripts/read-method-material.mjs --file PATH [--start N] [--lines N] [--sha256 HEX]
Defaults: start 1, lines 60. Positive integers; at most 200 lines.
Limits: 1 MiB regular UTF8 file; 16 KiB UTF8 page text. Oversized pages fail;
reduce --lines. A single line above the text limit is unsupported.
LF counts lines; CRLF, BOM and selected original separators are preserved.
Start > 1 requires the exact whole-file SHA256 returned by the first page.
EOF means this page reaches the snapshot end, not prior-page reading or understanding.
Empty file: total_lines 0, start 1, end 0, text empty, eof true, next_start null.
All final pages have next_start null; beyond-EOF starts otherwise fail.
Terminal symlinks/nonregular files are refused. Parent paths may resolve normally.
This is not an OS sandbox or a concurrent-writer fence. No files are written.
`;

try {
  if (process.argv.length === 3 && process.argv[2] === '--help') process.stdout.write(help);
  else process.stdout.write(JSON.stringify(readPage(options(process.argv.slice(2)))) + '\n');
} catch (error) {
  const codes = new Set(['invalid_arguments', 'sha256_required', 'not_regular_file', 'file_too_large', 'file_changed', 'sha256_mismatch', 'invalid_utf8', 'start_beyond_eof', 'page_too_large']);
  // Filesystem diagnostics can contain caller paths; expose only stable codes.
  const code = codes.has(error.message) ? error.message : 'file_unavailable';
  process.stderr.write(JSON.stringify({ schema_version: 1, error: code }) + '\n');
  process.exitCode = 1;
}
