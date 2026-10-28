// Project-local material export only: no subprocess, network, host registration or DB access.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, writeFile } from 'node:fs/promises';
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
    return buffer.subarray(0, length);
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
    for (const name of (await readdir(join(sourceRoot, rel))).sort()) {
      count();
      if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw Error(`source_name: ${name}`);
      const path = `${rel}/${name}`; const info = await lstat(join(sourceRoot, path));
      if (info.isSymbolicLink()) throw Error(`source_symlink: ${path}`);
      if (info.isDirectory()) await walk(path, depth + 1);
      else files.set(path, await boundedRead(join(sourceRoot, path), budget));
    }
  }
  await walk('references', 0);
  const folded = new Set();
  for (const path of files.keys()) { const key = path.toLowerCase(); if (folded.has(key)) throw Error(`source_case_collision: ${path}`); folded.add(key); }
  return files;
}
// The canonical materials use ordinary inline Markdown links and reference definitions.
// Rewrite destination spans only, never prose, fenced examples or arbitrary path substrings.
function destinations(text) {
  const spans = [];
  // Mask code without moving offsets. Links in examples are not navigation targets.
  const prose = text.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, value => value.replace(/[^\n]/g, ' ')).replace(/(`+)[^\n]*?\1/g, value => ' '.repeat(value.length));
  const patterns = [ /!?\[[^\]\r\n]*\]\(\s*(?:<([^>\r\n]*)>|([^\s)]+))/g, /^[ \t]{0,3}\[[^\]\r\n]+\]:[ \t]*(?:<([^>\r\n]*)>|([^\s]+))/gm ];
  for (const pattern of patterns) for (const match of prose.matchAll(pattern)) {
    const target = match[1] ?? match[2]; const offset = match[0].lastIndexOf(target);
    spans.push({ target, start: match.index + offset, end: match.index + offset + target.length });
  }
  // HTML navigation is outside this small canonical format, rather than silently unchecked.
  if (/<[^>]+\b(?:href|src)\s*=/i.test(prose)) throw Error('link_unsupported: HTML navigation');
  return spans.sort((a, b) => a.start - b.start);
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
  const spans = destinations(text);
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
  const requested = resolve(output);
  if (await present(requested)) throw Error(`output_exists: ${requested}`);
  let parent;
  try { parent = await realpath(dirname(requested)); if (!(await lstat(parent)).isDirectory()) throw Error('not directory'); }
  catch { throw Error(`output_parent: ${dirname(requested)}`); }
  const destination = join(parent, basename(requested));
  if (await present(destination)) throw Error(`output_exists: ${destination}`);
  for (const name of ['.agents', '.claude', '.codex', '.osstack']) {
    const forbidden = resolve(homedir(), name);
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
  outputs.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const outputPaths = new Set(outputs.map(file => file.path));
  for (const file of outputs) if (file.path.endsWith('.md')) for (const { target } of destinations(file.bytes.toString('utf8'))) {
    const local = localTarget(file.path, target);
    if (local !== null && (!local.startsWith(`${namespace}/`) || !outputPaths.has(local))) throw Error(`link_export_missing_or_escape: ${file.path} -> ${target}`);
  }
  const sourceFiles = [...sources].map(([path, bytes]) => ({ path, bytes: bytes.length, sha256: digest(bytes) })).sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const files = outputs.map(file => ({ path: file.path, bytes: file.bytes.length, sha256: digest(file.bytes), source_path: file.sourcePath, source_sha256: digest(sources.get(file.sourcePath)) }));
  return { destination, outputs, manifest: { schema_version: 1, host, namespace, layout: 'project-local skills with private reference copies', exported: true, installed: false, global_registration: false, host_discovery_verified: false, source_digest: digest(JSON.stringify(sourceFiles)), source_files: sourceFiles, files, limits, link_scope: 'inline Markdown and reference-definition destinations; file existence checked, fragment anchors not qualified', limitations: ['material export is not host discovery or execution', 'no provider, runtime or formal gate qualification', 'source and output trees must not be concurrently mutated during export'] } };
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
