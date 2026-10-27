/** J02a: single-source evidence only. No registry admission or dependency closure. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { SourcePin, SourceSnapshot, canonicalJointJson, jointDigest } from '@osstack/protocol/joint';

const FILE_LIMIT = 512;
const BLOB_LIMIT = 512 * 1024;
const TOTAL_LIMIT = 8 * 1024 * 1024;
const TREE_LIMIT = 2 * 1024 * 1024;
const Hex = z.string().regex(/^[a-f0-9]{64}$/);
const Input = z.object({
  gitBinary: z.string().min(1), repositoryPath: z.string().min(1),
  repository: z.string().min(1).max(512), commit: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/),
  subdir: z.string().min(1).max(512), licensePaths: z.array(z.string().min(1).max(512)).min(1).max(32),
  expectedContentSha256: Hex.optional(),
}).strict();
export type GitSourceOptions = z.infer<typeof Input>;
export type SourceInspectionErrorCode = 'INVALID_INPUT' | 'UNSUPPORTED_GIT' | 'PARTIAL_STORE' | 'ALTERNATE_STORE' | 'UNSAFE_ENTRY' | 'RESOURCE_LIMIT' | 'SOURCE_TIMEOUT' | 'OBJECT_UNAVAILABLE' | 'OBJECT_MISMATCH' | 'CONTENT_DRIFT' | 'INTERNAL';
export class SourceInspectionError extends Error {
  readonly retryable: boolean;
  constructor(readonly code: SourceInspectionErrorCode) {
    super(code); this.name = 'SourceInspectionError'; this.retryable = code === 'SOURCE_TIMEOUT';
  }
}
function fail(code: SourceInspectionErrorCode): never { throw new SourceInspectionError(code); }
function pathSafe(path: string, root = false): boolean {
  if (root && path === '.') return true;
  return path.length > 0 && Buffer.byteLength(path) <= 512 && path.split('/').length <= 64
    && !/[\\:]/.test(path) && ![...path].some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) && !path.startsWith('/')
    && path.split('/').every(p => p !== '' && p !== '.' && p !== '..' && !/[. ]$/.test(p) && p.toLowerCase() !== '.git');
}
function utf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return fail('UNSAFE_ENTRY'); }
}
function sha(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
export interface InspectedSourceFile {
  path: string; mode: '100644' | '100755'; blob: string; bytes: number; sha256: string; role: 'source' | 'license';
}
export interface GitSourceInspection {
  kind: 'source_inspection'; schema_version: 1;
  dependency_resolution: 'not_performed'; repository_identity: 'caller_asserted'; expected_digest_checked: boolean;
  pin: z.infer<typeof SourcePin>; files: InspectedSourceFile[]; inspection_digest: string;
}

/** Host-owned absolute binary/mirror paths only. Repository identity is a caller assertion.
 * Returns no bare SourceSnapshot: J02b must verify adoption closure before constructing one.
 * Synchronous: run in a worker/child, never on a daemon RPC event loop.
 * All failures throw typed errors without returning partial evidence. Does not read source checkout bytes.
 */
export function inspectGitSource(options: GitSourceOptions): GitSourceInspection {
  try { return inspect(options); } catch (error) {
    if (error instanceof SourceInspectionError) throw error;
    if (error instanceof Error && 'code' in error) return fail('OBJECT_UNAVAILABLE');
    return fail('INTERNAL');
  }
}
function inspect(options: GitSourceOptions): GitSourceInspection {
  const parsed = Input.safeParse(options);
  if (!parsed.success) return fail('INVALID_INPUT');
  const o = parsed.data;
  if (!isAbsolute(o.gitBinary) || !isAbsolute(o.repositoryPath) || !pathSafe(o.subdir, true)
    || !o.licensePaths.every(p => pathSafe(p)) || new Set(o.licensePaths).size !== o.licensePaths.length) return fail('INVALID_INPUT');
  const preliminary = SourcePin.safeParse({ kind: 'source_pin', schema_version: 1, repository: o.repository, commit: o.commit,
    subdir: o.subdir, content_sha256: '0'.repeat(64), license_refs: ['pending'] });
  if (!preliminary.success) return fail('INVALID_INPUT');
  const placeholder = preliminary.data;
  try { canonicalJointJson(placeholder); } catch { return fail('INVALID_INPUT'); }
  let binary: string; let repo: string;
  try { binary = realpathSync(o.gitBinary); repo = realpathSync(o.repositoryPath); } catch { return fail('INVALID_INPUT'); }
  const deadline = performance.now() + 30_000;
  // Allowlist prevents inherited Git/config/object/exec-path redirection. No source-provided command runs.
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1',
    GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  let gitDir: string | undefined;
  function git(args: string[], maxBuffer = TREE_LIMIT, allowMissingConfig = false): Buffer {
    const left = deadline - performance.now(); if (left <= 0) return fail('SOURCE_TIMEOUT');
    try {
      return execFileSync(binary, ['--no-pager', '--no-optional-locks', '-c', 'protocol.allow=never', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
        ...(gitDir ? ['--git-dir', gitDir] : ['-C', repo]), ...args],
        { env, cwd: gitDir ?? repo, killSignal: 'SIGKILL', timeout: Math.max(1, Math.min(5000, Math.floor(left))), maxBuffer, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      const e = error as { code?: string; status?: number; stdout?: Buffer };
      if (allowMissingConfig && e.status === 1 && e.stdout?.length === 0) return Buffer.alloc(0);
      if (e.code === 'ETIMEDOUT') return fail('SOURCE_TIMEOUT');
      if (e.code === 'ENOBUFS') return fail('RESOURCE_LIMIT');
      return fail('OBJECT_UNAVAILABLE');
    }
  }
  const version = utf8(git(['--version'], 4096)).match(/^git version (\d+)\.(\d+)/);
  if (!version || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 48)) return fail('UNSUPPORTED_GIT');
  gitDir = utf8(git(['rev-parse', '--absolute-git-dir'], 4096)).trim();
  if (!isAbsolute(gitDir)) return fail('INVALID_INPUT');
  gitDir = realpathSync(gitDir);
  if (gitDir !== repo && gitDir !== join(repo, '.git')) return fail('INVALID_INPUT');
  if (git(['config', '--includes', '--get-regexp', '^(extensions.partialclone|remote..*.promisor)$'], 65536, true).length) return fail('PARTIAL_STORE');
  const objects = utf8(git(['rev-parse', '--path-format=absolute', '--git-path', 'objects'], 4096)).trim();
  for (const file of ['alternates', 'http-alternates']) {
    const p = join(objects, 'info', file); if (existsSync(p) && statSync(p).size) return fail('ALTERNATE_STORE');
  }
  const pack = join(objects, 'pack');
  if (existsSync(pack) && readdirSync(pack).some(p => p.endsWith('.promisor'))) return fail('PARTIAL_STORE');
  const format = utf8(git(['rev-parse', '--show-object-format'], 128)).trim();
  if ((format !== 'sha1' && format !== 'sha256') || o.commit.length !== (format === 'sha1' ? 40 : 64)) return fail('INVALID_INPUT');
  function object(type: 'commit' | 'blob', oid: string, limit: number): Buffer {
    const sizeText = utf8(git(['cat-file', '-s', oid], 128)).trim();
    const size = Number(sizeText);
    if (!/^\d+$/.test(sizeText) || !Number.isSafeInteger(size) || size > limit) return fail('RESOURCE_LIMIT');
    const bytes = git(['cat-file', type, oid], limit + 1);
    if (bytes.length !== size || createHash(format).update(`${type} ${size}\0`).update(bytes).digest('hex') !== oid) return fail('OBJECT_MISMATCH');
    return bytes;
  }
  object('commit', o.commit, 65536);
  const subObject = o.subdir === '.' ? `${o.commit}^{tree}` : `${o.commit}:${o.subdir}`;
  if (utf8(git(['cat-file', '-t', subObject], 128)).trim() !== 'tree') return fail('UNSAFE_ENTRY');
  const entries = utf8(git(['ls-tree', '-r', '-z', '--full-tree', o.commit])).split('\0');
  if (entries.pop() !== '') return fail('UNSAFE_ENTRY');
  const licenses = new Set(o.licensePaths);
  const selected: { path: string; mode: '100644' | '100755'; blob: string }[] = [];
  let sourceCount = 0;
  for (const entry of entries) {
    const tab = entry.indexOf('\t'); if (tab < 0) return fail('UNSAFE_ENTRY');
    const path = entry.slice(tab + 1);
    const inside = o.subdir === '.' || path.startsWith(`${o.subdir}/`);
    if (!inside && !licenses.has(path)) continue;
    const match = entry.slice(0, tab).match(/^(100644|100755) blob ([a-f0-9]+)$/);
    if (!match || !pathSafe(path) || match[2]?.length !== o.commit.length) return fail('UNSAFE_ENTRY');
    selected.push({ path, mode: match[1] as '100644' | '100755', blob: match[2] });
    if (inside && !licenses.has(path)) sourceCount++;
    if (selected.length > FILE_LIMIT) return fail('RESOURCE_LIMIT');
  }
  if (!sourceCount || o.licensePaths.some(p => !selected.some(f => f.path === p))) return fail('OBJECT_UNAVAILABLE');
  selected.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  // Reuse J01's collision and prefix invariants, without exporting a closure claim.

  if (!SourceSnapshot.safeParse({ kind: 'source_snapshot', schema_version: 1, pin: placeholder, files: selected, dependencies: [] }).success) return fail('UNSAFE_ENTRY');
  let total = 0;
  const files: InspectedSourceFile[] = selected.map(f => {
    const bytes = object('blob', f.blob, Math.min(BLOB_LIMIT, TOTAL_LIMIT - total)); total += bytes.length;
    return { ...f, bytes: bytes.length, sha256: sha(bytes), role: licenses.has(f.path) ? 'license' : 'source' };
  });
  const content = { schema_version: 1, repository: o.repository, commit: o.commit, subdir: o.subdir, files };
  const digest = jointDigest('osstack.joint.source-content.v1', content);
  if (o.expectedContentSha256 !== undefined && digest !== o.expectedContentSha256) return fail('CONTENT_DRIFT');
  const pin = SourcePin.parse({ ...placeholder, content_sha256: digest,
    license_refs: [...new Set(files.filter(f => f.role === 'license').map(f => `sha256:${f.sha256}`))].sort() });
  const result = { kind: 'source_inspection' as const, schema_version: 1 as const, dependency_resolution: 'not_performed' as const,
    repository_identity: 'caller_asserted' as const, expected_digest_checked: o.expectedContentSha256 !== undefined, pin, files };
  return { ...result, inspection_digest: jointDigest('osstack.joint.source-inspection.v1', result) };
}
