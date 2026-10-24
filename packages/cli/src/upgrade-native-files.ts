import { createHash, randomBytes } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync } from 'node:fs';
import { link, mkdir, open, rename, symlink, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { UpgradeDigest, UpgradeId, UpgradeTargetSchema, upgradeCanonical } from './upgrade-plan.js';
export const absolute = z.string().min(1).max(4096).refine(isAbsolute);
export const ManagedInstallationSchema = z.object({ schema_version: z.literal(1), backend: z.literal('launchd'),
  installation_id: UpgradeId, root: absolute, node: absolute, node_sha256: UpgradeDigest,
  entry: z.string().regex(/^[A-Za-z0-9_./-]+$/).refine(safeRelative),
  consumers: z.array(z.object({ home_id: z.string().regex(/^home_[a-f0-9]{32}$/), home: absolute, socket: absolute,
    label: z.string().regex(/^ai\.osstack\.managed\.[A-Za-z0-9._-]{1,100}$/) }).strict()).min(1).max(32),
}).strict().superRefine((v, ctx) => {
  for (const values of [v.consumers.map(c => c.home_id), v.consumers.map(c => c.home), v.consumers.map(c => c.socket), v.consumers.map(c => c.label)])
    if (new Set(values).size !== values.length) ctx.addIssue({ code: 'custom', message: 'duplicate_consumer' });
});
export type ManagedInstallation = z.infer<typeof ManagedInstallationSchema>;
export const ReleaseBundleSchema = z.object({ schema_version: z.literal(1), target: UpgradeTargetSchema,
  files: z.array(z.object({ path: z.string().max(1024).refine(safeRelative), mode: z.union([z.literal(0o600), z.literal(0o700)]),
    content_base64: z.string().max(24 * 1024 * 1024).regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/) }).strict()).min(1).max(20000),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.files.map(f => f.path.toLowerCase())).size !== v.files.length) ctx.addIssue({ code: 'custom', message: 'duplicate_bundle_path' });
  if (v.files.some(f => f.path === '.osstack-release.json')) ctx.addIssue({ code: 'custom', message: 'reserved_bundle_path' });
});
export type ReleaseBundle = z.infer<typeof ReleaseBundleSchema>;
export function safeRelative(path: string): boolean {
  return path.length > 0 && /^[A-Za-z0-9_./@+-]+$/.test(path) && !isAbsolute(path) && path.split('/').every(p => p !== '' && p !== '.' && p !== '..');
}
export function sha256(bytes: string | Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
/** Canonical same-UID private roots and regular files; no ancestor or final symlinks. */
export function privateDirectory(path: string): void {
  const info = lstatSync(path);
  if (realpathSync(path) !== resolve(path) || !info.isDirectory() || (info.mode & 0o077) || process.getuid && info.uid !== process.getuid()) throw Error('upgrade_unsafe_directory');
}
export function readPrivate(path: string, limit = 262144): Buffer {
  privateDirectory(dirname(path)); const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || (before.nlink !== 1 && before.nlink !== 2) || before.size > limit || before.mode & 0o077 || process.getuid && before.uid !== process.getuid()) throw Error('upgrade_unsafe_file');
    if(before.nlink===2){const names=readdirSync(dirname(path));if(names.length>22000)throw Error('upgrade_file_links');let matches=0;for(const name of names.filter(name=>/^\.publish-[a-f0-9]{32}$/.test(name))){const other=lstatSync(join(dirname(path),name));if(other.isFile()&&other.ino===before.ino&&other.dev===before.dev)matches++;}if(matches!==1)throw Error('upgrade_file_links');}
    const bytes = Buffer.alloc(Math.min(limit + 1, before.size + 1)); let count = 0;
    while (count < bytes.length) { const size = readSync(fd, bytes, count, bytes.length - count, count); if (!size) break; count += size; }
    const after = fstatSync(fd);
    if (count > limit || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('upgrade_file_changed');
    return bytes.subarray(0, count);
  } finally { closeSync(fd); }
}
export async function syncDirectory(path: string): Promise<void> {
  const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); }
}
export async function publishPrivate(path: string, value: unknown): Promise<void> {
  privateDirectory(dirname(path)); const temp=join(dirname(path),`.publish-${randomBytes(16).toString('hex')}`);
  const fd = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(upgradeCanonical(value)); await fd.sync(); } finally { await fd.close(); }
  try { await link(temp,path); } finally { await unlink(temp); }
  await syncDirectory(dirname(path));
}
export function loadInstallation(path: string, digest: string): ManagedInstallation {
  UpgradeDigest.parse(digest); const bytes = readPrivate(path);
  if (sha256(bytes) !== digest) throw Error('upgrade_registry_changed');
  const result = ManagedInstallationSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (path !== join(result.root, 'installation.json')) throw Error('upgrade_registry_location');
  privateDirectory(result.root);
  if (realpathSync(result.node) !== result.node || !lstatSync(result.node).isFile() || sha256(readFileSync(result.node)) !== result.node_sha256) throw Error('upgrade_node_changed');
  for (const consumer of result.consumers) { privateDirectory(consumer.home); if (dirname(consumer.socket) !== consumer.home) throw Error('upgrade_socket_location');
    const identity = z.object({schema_version:z.literal(1),home_id:z.literal(consumer.home_id)}).strict().parse(JSON.parse(readPrivate(join(consumer.home,'deployment-identity.json'),512).toString()));
    if (identity.home_id !== consumer.home_id) throw Error('upgrade_home_identity_changed');
  }
  return result;
}
export function bundleBuildDigest(files: ReleaseBundle['files']): string {
  return sha256(upgradeCanonical([...files].map(file => ({ path: file.path, mode: file.mode, sha256: sha256(Buffer.from(file.content_base64, 'base64')) })).sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
}
export function loadBundle(path: string, digest: string): ReleaseBundle {
  UpgradeDigest.parse(digest); const bytes = readPrivate(path, 128 * 1024 * 1024);
  if (sha256(bytes) !== digest) throw Error('upgrade_artifact_changed');
  const bundle = ReleaseBundleSchema.parse(JSON.parse(bytes.toString('utf8')));
  if (bundleBuildDigest(bundle.files) !== bundle.target.build_digest) throw Error('upgrade_build_digest_mismatch');
  return bundle;
}
export async function stageRelease(root: string, bundle: ReleaseBundle, signal: AbortSignal): Promise<string> {
  privateDirectory(root); const releases = join(root, 'releases'); await mkdir(releases, { mode: 0o700 }).catch(e => { if (e.code !== 'EEXIST') throw e; }); privateDirectory(releases);
  const target = join(releases, bundle.target.build_digest); const temporary = join(releases, `.stage-${randomBytes(16).toString('hex')}`);
  await mkdir(temporary, { mode: 0o700 });
  for (const file of bundle.files) {
    signal.throwIfAborted(); const path = join(temporary, file.path); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const fd = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, file.mode);
    try { await fd.writeFile(Buffer.from(file.content_base64, 'base64')); await fd.sync(); } finally { await fd.close(); }
    await syncDirectory(dirname(path));
  }
  await publishPrivate(join(temporary, '.osstack-release.json'), { schema_version: 1, target: bundle.target, files: bundle.files.map(f => ({ path: f.path, mode: f.mode, sha256: sha256(Buffer.from(f.content_base64, 'base64')) })) });
  signal.throwIfAborted(); await rename(temporary, target); await syncDirectory(releases); return target;
}
export async function switchRelease(root: string, release: string, signal: AbortSignal): Promise<void> {
  privateDirectory(root); if (dirname(release) !== join(root, 'releases')) throw Error('upgrade_release_location');
  const temp = join(root, `.current-${randomBytes(16).toString('hex')}`); await symlink(release, temp);
  try { signal.throwIfAborted(); await rename(temp, join(root, 'current')); await syncDirectory(root); } finally { await unlink(temp).catch(() => {}); }
}
