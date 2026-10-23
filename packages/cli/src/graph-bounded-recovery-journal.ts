import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { workerCanonical } from '@osstack/protocol';
import { resolveRepositoryScope, type GraphAction } from '@osstack/core';
import { inspectRepoWriteLock } from '@osstack/autonomy';
import type { GraphActionEvidence } from './graph-action-broker.js';

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const path = z.string().min(1).refine(s => isAbsolute(s) && !s.includes('\0'));
const owner = z.object({ pid: z.number().int().positive(), autonomy_run_id: z.string().min(1), repo_id: z.string().min(1),
  acquired_at: z.string().datetime(), token: z.string().uuid(), expires_at: z.string().datetime().optional(), recovery_policy: z.literal("reconcile").optional() }).strict();
const schema = z.object({ version: z.literal(1), effectKey: digest, actionDigest: digest,
  executionRef: z.string().min(1), generation: z.literal(1), owner: z.string().min(1),
  workspacePath: path, commonDir: path, repoId: z.string().min(1), fingerprint: digest,
  evidenceRef: z.string().regex(/^graph-delivery:[a-f0-9]{64}$/), lockOwner: owner }).strict();
export type BoundedRecoveryJournal = z.infer<typeof schema>;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export const boundedActionDigest = (action: GraphAction) => sha(workerCanonical({ effect: action.effect, action: action.action,
  generation: action.generation, executionRef: action.executionRef, businessDigest: action.businessDigest }));

function read(path: string, limit: number): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw Error('BOUNDED_RECOVERY_FILE');
    const bytes = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    if (offset !== stat.size) throw Error('BOUNDED_RECOVERY_FILE_CHANGED');
    return bytes.subarray(0, offset);
  } finally { closeSync(fd); }
}
/** Raw files, including ignored/untracked and Git metadata. Only host lease
 * bookkeeping is excluded. Bounded to 32 MiB/10000 entries; no symlinks or devices. */
export function boundedWorkspaceFingerprint(root: string): string {
  if (!isAbsolute(root) || realpathSync(root) !== root) throw Error('BOUNDED_RECOVERY_WORKSPACE');
  const hash = createHash('sha256'); let remaining = 32 * 1024 * 1024; let count = 0;
  const visit = (directory: string, prefix: string) => {
    const directoryStat = lstatSync(directory);
    if (!directoryStat.isDirectory() || realpathSync(directory) !== directory) throw Error('BOUNDED_RECOVERY_WORKSPACE');
    for (const name of readdirSync(directory).sort()) {
      const relative = `${prefix}${name}`;
      if (relative === '.git/osstack/writer-locks') continue;
      if (++count > 10000) throw Error('BOUNDED_RECOVERY_LIMIT');
      const full = join(directory, name); const stat = lstatSync(full);
      hash.update(workerCanonical([relative, stat.mode, stat.isDirectory() ? 'directory' : 'file']));
      if (stat.isDirectory()) visit(full, `${relative}/`);
      else { const bytes = read(full, remaining); remaining -= bytes.length; hash.update(workerCanonical([bytes.length, sha(bytes)])); }
    }
  };
  visit(root, ''); return hash.digest('hex');
}
function directory(root: string, create = false): string {
  if (realpathSync(root) !== root) throw Error('BOUNDED_RECOVERY_ROOT');
  const dir = join(root, 'bounded-recovery');
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync(dir) !== dir) throw Error('BOUNDED_RECOVERY_ROOT');
  return dir;
}
function sync(path: string) { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
export function loadBoundedRecoveryJournal(root: string, effectKey: string): BoundedRecoveryJournal {
  digest.parse(effectKey);
  const result = schema.parse(JSON.parse(read(join(directory(root), `${effectKey}.json`), 16384).toString('utf8')));
  if (result.effectKey !== effectKey) throw Error('BOUNDED_RECOVERY_BINDING');
  return result;
}
/** Synchronous final guard after loadDeliveryReceipt verified its full binding. */
export function assertBoundedDeliveryReceipt(root: string, ref: string): void {
  if (!/^graph-delivery:[a-f0-9]{64}$/.test(ref) || realpathSync(root) !== root) throw Error('BOUNDED_RECOVERY_RECEIPT');
  const dir = join(root, 'delivery-receipts');
  if (realpathSync(dir) !== dir || sha(read(join(dir, `${ref.slice(15)}.json`), 128 * 1024)) !== ref.slice(15)) throw Error('BOUNDED_RECOVERY_RECEIPT');
}
/** Optional recovery coverage, never turns missing evidence into a stop claim.
 * Called by the trusted delivery host after receipt publication, before ledger ACK. */
export async function publishBoundedRecoveryJournal(root: string, action: GraphAction, workerOwner: string,
  workspacePath: string, evidenceRef: string, evidence: GraphActionEvidence, authorize: () => void): Promise<void> {
  if (action.generation !== 1 || action.effect.epoch !== 0 || action.effect.nodeId !== 'e0.implement'
    || action.action.kind !== 'implement' || action.state !== 'running' || !action.executionRef
    || evidence.status !== 'completed' || evidence.stopped !== true
    || !/^(anthropic|deepseek)-bounded-v1:/.test(evidence.stopEvidenceRef ?? '')) return;
  const check = () => { const value: unknown = authorize(); if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('BOUNDED_RECOVERY_AUTHORITY'); } };
  check(); const scope = await resolveRepositoryScope(workspacePath); check();
  // A detached, private clone is required; shared worktree metadata is unsupported.
  if (scope.commonDir !== join(workspacePath, '.git')) return;
  const lockOwner = await inspectRepoWriteLock(join(scope.commonDir, 'osstack', 'writer-locks'), scope.repoId); check();
  if (!lockOwner?.token || lockOwner.pid !== process.pid || lockOwner.autonomy_run_id !== `graph-action:${action.effectKey}`) return;
  let fingerprint: string;
  try { fingerprint = boundedWorkspaceFingerprint(workspacePath); } catch { return; }
  const body = schema.parse({ version: 1, effectKey: action.effectKey, actionDigest: boundedActionDigest(action),
    executionRef: action.executionRef, generation: action.generation, owner: workerOwner, workspacePath,
    commonDir: scope.commonDir, repoId: scope.repoId, fingerprint, evidenceRef, lockOwner });
  check(); const dir = directory(root, true); const target = join(dir, `${action.effectKey}.json`); const temporary = `${target}.${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, workerCanonical(body)); fsyncSync(fd); } finally { closeSync(fd); }
  try { check(); linkSync(temporary, target); sync(dir); sync(root); }
  finally { unlinkSync(temporary); }
  check();
}
