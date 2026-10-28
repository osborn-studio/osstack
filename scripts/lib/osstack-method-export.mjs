// Project-local material export only: no subprocess, network, host registration or DB access.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, opendir, realpath, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';

const names = ['osstack-mode', 'osstack-help', 'setup-osstack', 'osstack-agent'];
const namespaces = { codex: '.agents/skills', claude: '.claude/skills' };
const limits = { file_bytes: 1024 * 1024, source_bytes: 8 * 1024 * 1024, source_nodes: 256, reference_depth: 8 };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };
const usage = 'usage: node scripts/export-osstack-methods.mjs --host codex|claude --output ABSOLUTE_NEW_ROOT [--dry-run]';
const present = async path => { try { await lstat(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };
function validateOptions({ host, output, dryRun = false }) {
  if (!Object.hasOwn(namespaces, host) || typeof output !== 'string' || !isAbsolute(output) || typeof dryRun !== 'boolean') throw Error(usage);
}
export function parseExportOptions(args) {
  const options = { dryRun: false }; const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!['--host', '--output', '--dry-run'].includes(arg) || seen.has(arg)) throw Error(usage);
    seen.add(arg);
    if (arg === '--dry-run') options.dryRun = true;
    else {
      const value = args[++i]; if (!value || value.startsWith('--')) throw Error(usage);
      options[arg.slice(2)] = value;
    }
  }
  validateOptions(options); return options;
}
async function sourceDirectory(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw Error(`source_symlink: ${path}`);
  if (!info.isDirectory()) throw Error(`source_not_directory: ${path}`);
}
async function boundedRead(path, budget) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw Error(`source_symlink: ${path}`);
  if (!info.isFile()) throw Error(`source_not_regular: ${path}`);
  if (info.size > limits.file_bytes) throw Error(`source_limit: file bytes ${path}`);
  // NOFOLLOW closes the final-component link race; NONBLOCK avoids a raced FIFO open.
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.ino !== info.ino || current.dev !== info.dev) throw Error(`source_changed: ${path}`);
    const buffer = Buffer.alloc(limits.file_bytes + 1); let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > limits.file_bytes || (budget.bytes += length) > limits.source_bytes) throw Error(`source_limit: bytes ${path}`);
    const after = await handle.stat();
    if (length !== current.size || after.size !== current.size || after.mtimeMs !== current.mtimeMs) throw Error(`source_changed: ${path}`);
    return Buffer.from(buffer.subarray(0, length));
  } finally { await handle.close(); }
}
async function collectSources(sourceRoot) {
  await sourceDirectory(sourceRoot); await sourceDirectory(join(sourceRoot, 'entries'));
  const files = new Map(); const budget = { bytes: 0, nodes: 0 };
  const count = () => { if (++budget.nodes > limits.source_nodes) throw Error('source_limit: nodes'); };
  for (const name of names) {
    await sourceDirectory(join(sourceRoot, 'entries', name));
    const path = `entries/${name}/SKILL.md`; count(); files.set(path, await boundedRead(join(sourceRoot, path), budget));
  }
  async function walk(rel, depth) {
    if (depth > limits.reference_depth) throw Error('source_limit: reference depth');
    await sourceDirectory(join(sourceRoot, rel));
    const entries = [];
    for await (const entry of await opendir(join(sourceRoot, rel))) { count(); entries.push(entry.name); }
    for (const name of entries.sort()) {
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw Error(`source_name: ${name}`);
      if (name.startsWith('.')) throw Error(`source_format: ${rel}/${name}`);
      const path = `${rel}/${name}`; const info = await lstat(join(sourceRoot, path));
      if (info.isSymbolicLink()) throw Error(`source_symlink: ${path}`);
      if (info.isDirectory()) await walk(path, depth + 1);
      else {
        if (!name.endsWith('.md')) throw Error(`source_format: ${path}`);
        files.set(path, await boundedRead(join(sourceRoot, path), budget));
      }
    }
  }
  await walk('references', 0);
  const folded = new Set();
  for (const path of files.keys()) { const key = path.toLowerCase(); if (folded.has(key)) throw Error(`source_case_collision: ${path}`); folded.add(key); }
  return files;
}
// A deliberately small Markdown subset: single-line, unnested labels; simple
// destinations; no titles or HTML navigation. Unsupported navigation fails closed.
// Code masking and delimiter scans are linear in the bounded source size.
function maskCode(text) {
  let fence = null;
  return text.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return ' '.repeat(line.length);
    }
    if (marker) { fence = { char: marker[1][0], length: marker[1].length }; return ' '.repeat(line.length); }
    const runs = [];
    for (let i = 0; i < line.length;) {
      if (line[i] !== '`') { i++; continue; }
      const start = i; while (line[i] === '`') i++;
      runs.push({ start, end: i, next: null });
    }
    const next = new Map();
    for (let i = runs.length - 1; i >= 0; i--) {
      const run = runs[i]; const length = run.end - run.start;
      run.next = next.get(length) ?? null; next.set(length, i);
    }
    // Use code-unit offsets, including when a label contains non-BMP Unicode.
    const masked = line.split('');
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]; if (run.next === null) continue;
      const close = runs[run.next]; masked.fill(' ', run.start, close.end); i = run.next;
    }
    return masked.join('');
  }).join('\n');
}
function destinations(text, sourcePath) {
  const spans = []; const prose = maskCode(text); const labels = [];
  const unsupported = () => { throw Error(`link_unsupported: ${sourcePath}`); };
  function targetAt(start, inline) {
    let i = start;
    while (prose[i] === ' ' || prose[i] === '\t') i++;
    const angle = prose[i] === '<'; if (angle) i++;
    const begin = i;
    while (i < prose.length && !/[\s]/.test(prose[i]) && prose[i] !== (angle ? '>' : ')')) {
      if (prose[i] === '(' || (!angle && prose[i] === '<')) unsupported();
      i++;
    }
    if (i === begin || (angle && prose[i] !== '>')) unsupported();
    const end = i; if (angle) i++;
    while (prose[i] === ' ' || prose[i] === '\t') i++;
    if (inline ? prose[i] !== ')' : i < prose.length && prose[i] !== '\n' && prose[i] !== '\r') unsupported();
    spans.push({ target: prose.slice(begin, end), start: begin, end });
    return inline ? i : i - 1;
  }
  let lineStart = 0;
  for (let i = 0; i < prose.length; i++) {
    if (prose[i] === '\n') { lineStart = i + 1; }
    else if (prose[i] === '[') { if (labels.length) labels[labels.length - 1].nested = true; labels.push({ start: i, nested: false }); }
    else if (prose[i] === ']') {
      const label = labels.pop();
      if (prose[i + 1] === '(') {
        if (!label || label.nested || prose.slice(label.start, i).includes('\n')) unsupported();
        i = targetAt(i + 2, true);
      } else if (prose[i + 1] === ':' && label) {
        if (label.start < lineStart) unsupported();
        const prefix = prose.slice(lineStart, label.start);
        if (/^ {0,3}$/.test(prefix)) {
          if (label.nested || prose[label.start + 1] === '^' || prose.slice(label.start, i).includes('\n')) unsupported();
          i = targetAt(i + 2, false);
        }
      }
    }
  }
  // Scan angle regions separately: unmatched '<' must not hide later Markdown.
  for (let i = 0; i < prose.length;) {
    const begin = prose.indexOf('<', i); if (begin === -1) break;
    const end = prose.indexOf('>', begin + 1); if (end === -1) break;
    const angle = prose.slice(begin + 1, end);
    if (/\b(?:href|src|srcset)\s*=/i.test(angle)) unsupported();
    if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(angle) && !/^(?:https?:\/\/|mailto:)/i.test(angle)) unsupported();
    i = end + 1;
  }
  return spans;
}
function localTarget(from, target) {
  if (/^https?:\/\//i.test(target) || /^mailto:/i.test(target) || target.startsWith('#')) return null;
  if (!target || /[\\%\u0000-\u0020]/.test(target) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('~') || target.includes('?')) throw Error(`link_unsafe: ${from} -> ${target}`);
  return posix.normalize(posix.join(posix.dirname(from), target.split('#')[0]));
}
function transform(sourcePath, bytes, sources) {
  if (!sourcePath.endsWith('.md')) return bytes;
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); } catch { throw Error(`source_utf8: ${sourcePath}`); }
  const spans = destinations(text, sourcePath);
  for (const span of spans) {
    const local = localTarget(sourcePath, span.target);
    if (local !== null && !sources.has(local)) throw Error(`link_missing_or_escape: ${sourcePath} -> ${span.target}`);
  }
  if (sourcePath.startsWith('entries/')) for (const span of [...spans].reverse()) {
    if (span.target.startsWith('../../references/')) text = text.slice(0, span.start) + span.target.slice(6) + text.slice(span.end);
  }
  return Buffer.from(text);
}
async function plan({ sourceRoot, host, output, dryRun = false }) {
  validateOptions({ host, output, dryRun });
  sourceRoot = resolve(sourceRoot); // Strip trailing separators before lstat: never follow a final-component symlink.
  const requested = resolve(output);
  if (await present(requested)) throw Error(`output_exists: ${requested}`);
  let parent;
  try { parent = await realpath(dirname(requested)); if (!(await lstat(parent)).isDirectory()) throw Error('not directory'); }
  catch { throw Error(`output_parent: ${dirname(requested)}`); }
  const destination = join(parent, basename(requested));
  if (await present(destination)) throw Error(`output_exists: ${destination}`);
  const protectedHomes = ['.agents', '.claude', '.codex', '.osstack'].map(name => resolve(homedir(), name));
  for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'OSSTACK_HOME']) if (process.env[key]) protectedHomes.push(resolve(process.env[key]));
  for (const forbidden of protectedHomes) {
    let actual = forbidden; try { actual = await realpath(forbidden); } catch { /* Lexical boundary still applies when absent. */ }
    if (inside(forbidden, requested) || inside(actual, destination)) throw Error('output_protected_home');
  }
  const sources = await collectSources(sourceRoot);
  if (inside(await realpath(sourceRoot), destination)) throw Error('output_inside_source');
  const namespace = namespaces[host]; const outputs = [];
  for (const name of names) {
    const sourcePath = `entries/${name}/SKILL.md`;
    outputs.push({ path: `${namespace}/${name}/SKILL.md`, sourcePath, bytes: transform(sourcePath, sources.get(sourcePath), sources) });
    for (const [path, bytes] of sources) if (path.startsWith('references/')) outputs.push({ path: `${namespace}/${name}/${path}`, sourcePath: path, bytes: transform(path, bytes, sources) });
  }
  outputs.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const outputPaths = new Set(outputs.map(file => file.path));
  for (const file of outputs) if (file.path.endsWith('.md')) for (const { target } of destinations(file.bytes.toString('utf8'), file.path)) {
    const local = localTarget(file.path, target);
    if (local !== null && (!local.startsWith(`${namespace}/`) || !outputPaths.has(local))) throw Error(`link_export_missing_or_escape: ${file.path} -> ${target}`);
  }
  const sourceFiles = [...sources].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const files = outputs.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes), source_path: file.sourcePath, source_sha256: digest(sources.get(file.sourcePath)) }));
  return { destination, outputs, manifest: { schema_version: 1, host, namespace, layout: 'project-local skills with private reference copies', exported: true, installed: false, global_registration: false, host_discovery_verified: false, source_digest: digest(JSON.stringify(sourceFiles)), source_files: sourceFiles, files, limits, link_scope: 'simple single-line unnested Markdown labels and reference definitions, without titles; unsupported navigation rejected; file existence checked, fragment anchors not qualified', limitations: ['material export is not host discovery or execution', 'no provider, runtime or formal gate qualification', 'source and output trees must not be concurrently mutated during export'] } };
}
export async function exportMethods(options) {
  const prepared = await plan(options);
  const result = { status: options.dryRun ? 'planned' : 'exported', host: options.host, output: prepared.destination, exported: !options.dryRun, installed: false, host_discovery_verified: false, namespace: prepared.manifest.namespace };
  if (options.dryRun) return { ...result, files: prepared.manifest.files, source_digest: prepared.manifest.source_digest, limits };
  let owned = false;
  try {
    // Non-recursive reservation must succeed before any output writes. Never remove an output.
    await mkdir(prepared.destination); owned = true;
    const made = new Set([prepared.destination]);
    async function directory(path) {
      if (made.has(path)) { const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw Error('output_directory_changed'); return; }
      await directory(dirname(path)); await mkdir(path); made.add(path);
    }
    for (const file of prepared.outputs) {
      const path = join(prepared.destination, file.path); await directory(dirname(path));
      await writeFile(path, file.bytes, { flag: 'wx' });
    }
    const manifest = Buffer.from(JSON.stringify(prepared.manifest, null, 2) + '\n');
    await writeFile(join(prepared.destination, 'manifest.json'), manifest, { flag: 'wx' });
    return { ...result, manifest: 'manifest.json', manifest_sha256: digest(manifest), file_count: prepared.outputs.length };
  } catch (cause) {
    const error = new Error(`export_failed: ${cause.message}`);
    error.result = { ...result, status: 'failed', exported: false, output_created: owned, cleanup: owned ? 'retained_incomplete_owned_output' : 'not_owned_no_cleanup', error: cause.code ?? cause.message };
    throw error;
  }
}
