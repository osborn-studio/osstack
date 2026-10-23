import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { freezeWorkerData, workerCanonical } from '@osstack/protocol';
import { validateChangesetProposal } from '@osstack/agents/experimental/changeset';

type Validated = ReturnType<typeof validateChangesetProposal>;
export interface GraphApplyJournal {
  schemaVersion: 1;
  binding: Validated['manifest']['binding'];
  manifestDigest: string;
  proposalDigest: string;
  beforeTreeRevision: string;
  targetTreeRevision: string;
  workspaceIdentity: { dev: number; ino: number };
  beforeInventoryDigest: string;
  changes: Extract<Validated['proposal'], { kind: 'propose' }>['changes'];
}
/** completedChanges is a lower bound of durably finished operations, never a replay cursor.
 * A failing sync may follow a successful mutation; recovery must inspect actual bytes. */
export interface GraphApplyFailure { phase: string; completedChanges: number; path: string | null; temporaryPath: string | null; code: string }
export interface GraphApplyProof { journalDigest: string; journalRef: string; treeRevision: string; proposalDigest: string }
/** Trusted synchronous host port. authorize must prove the registered private
 * workspace, exclusive physical writer lease, current grant/fence and stopped
 * provider. journal must fsync private evidence; begin must use beginApply and
 * return ONLY its applyAuthorized bit. complete persists proof then completeApply.
 * No worker-supplied implementation of this port is permitted. */
export interface GraphApplyPort {
  authorize: () => unknown;
  journal: (journal: GraphApplyJournal, digest: string) => string;
  begin: (journal: GraphApplyJournal, digest: string, ref: string) => boolean;
  complete: (proof: GraphApplyProof) => unknown;
  quarantine: (proof: GraphApplyProof & { failure: GraphApplyFailure }) => unknown;
}
export interface GraphApplyInput { workspace: string; binding: unknown; manifest: unknown; policy: unknown; proposal: unknown }
export type GraphApplyResult = { kind: 'applied' | 'not_authorized' | 'quarantined' | 'reconciliation_required'; treeRevision: string; reconciliationRequired: boolean };
interface File { bytes: Buffer; mode: number; dev: number; ino: number }
interface Snapshot { files: Map<string, File>; directories: Map<string, { dev: number; ino: number; mode: number }> }
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const fold = (path: string) => path.normalize('NFC').toLowerCase();
const objectHash = (kind: string, bytes: Buffer, algorithm: string) => createHash(algorithm).update(`${kind} ${bytes.length}\0`).update(bytes).digest('hex');
const gitMode = (mode: number) => mode & 0o100 ? '100755' : '100644';
const sameIdentity = (a: { dev: number; ino: number }, b: { dev: number; ino: number }) => a.dev === b.dev && a.ino === b.ino;
function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { if (!fstatSync(fd).isDirectory()) throw Error('APPLY_DIRECTORY'); fsyncSync(fd); } finally { closeSync(fd); }
}
function readFile(path: string): File {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > 8 * 1024 * 1024 || (info.mode & 0o7000)) throw Error('APPLY_FILE_TYPE');
    const bytes = Buffer.alloc(info.size + 1); let length = 0;
    while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, length); if (!n) break; length += n; }
    const after = fstatSync(fd); const named = lstatSync(path);
    if (length !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs
      || !sameIdentity(info, named) || !named.isFile() || named.nlink !== 1) throw Error('APPLY_FILE_CHANGED');
    return { bytes: bytes.subarray(0, length), mode: info.mode & 0o777, dev: info.dev, ino: info.ino };
  } finally { closeSync(fd); }
}
function inventory(root: string): Snapshot {
  const result: Snapshot = { files: new Map(), directories: new Map() }; const aliases = new Set<string>(); let count = 0; let total = 0;
  const visit = (prefix: string, depth: number) => {
    if (depth > 64) throw Error('APPLY_INVENTORY_LIMIT');
    const directory = prefix ? join(root, prefix) : root; const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error('APPLY_DIRECTORY');
    result.directories.set(prefix, { dev: info.dev, ino: info.ino, mode: info.mode & 0o777 });
    for (const name of readdirSync(directory).sort()) {
      if (!prefix && name === '.git') continue;
      if (++count > 10000 || Buffer.from(name).toString('utf8') !== name) throw Error('APPLY_INVENTORY_LIMIT');
      const relative = prefix ? `${prefix}/${name}` : name; const folded = fold(relative);
      if (aliases.has(folded)) throw Error('APPLY_PATH_ALIAS'); aliases.add(folded);
      const stat = lstatSync(join(root, relative));
      if (stat.isSymbolicLink()) throw Error('APPLY_FILE_TYPE');
      if (stat.isDirectory()) visit(relative, depth + 1);
      else {
        const file = readFile(join(root, relative)); total += file.bytes.length;
        if (total > 64 * 1024 * 1024) throw Error('APPLY_INVENTORY_LIMIT'); result.files.set(relative, file);
      }
    }
    const after = lstatSync(directory);
    if (!sameIdentity(info, after) || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw Error('APPLY_DIRECTORY_CHANGED');
  };
  visit('', 0); return result;
}
function fingerprint(snapshot: Snapshot): string {
  return sha(workerCanonical({ files: [...snapshot.files].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, f]) => [path, sha(f.bytes), f.mode, f.dev, f.ino]),
    directories: [...snapshot.directories].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([path, d]) => [path, d.mode, d.dev, d.ino]) }));
}
/** Git object IDs from RAW bytes; never runs filters, git add, hooks or changes an index. */
function treeHash(files: Map<string, File>, algorithm: string): string {
  const tree = (prefix: string): string => {
    const entries = new Map<string, { mode: string; id: string; directory: boolean }>();
    for (const [path, file] of files) {
      if (!path.startsWith(prefix)) continue;
      const tail = path.slice(prefix.length); const slash = tail.indexOf('/');
      if (slash < 0) entries.set(tail, { mode: gitMode(file.mode), id: objectHash('blob', file.bytes, algorithm), directory: false });
      else { const name = tail.slice(0, slash); if (!entries.has(name)) entries.set(name, { mode: '40000', id: tree(`${prefix}${name}/`), directory: true }); }
    }
    const ordered = [...entries].sort(([a, av], [b, bv]) => Buffer.compare(Buffer.from(a + (av.directory ? '/' : '')), Buffer.from(b + (bv.directory ? '/' : ''))));
    return objectHash('tree', Buffer.concat(ordered.map(([name, e]) => Buffer.concat([Buffer.from(`${e.mode} ${name}\0`), Buffer.from(e.id, 'hex')]))), algorithm);
  };
  return tree('');
}
function git(root: string, ...args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return execFileSync('git', ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    env: { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } });
}
function checkTargets(snapshot: Snapshot, validated: Validated): void {
  const names = new Map([...snapshot.files.keys(), ...snapshot.directories.keys()].map(path => [fold(path), path]));
  for (const entry of validated.manifest.entries) {
    const parts = entry.path.split('/'); let prefix = '';
    for (const part of parts) {
      prefix = prefix ? `${prefix}/${part}` : part;
      const existing = names.get(fold(prefix)); if (existing !== undefined && existing !== prefix) throw Error('APPLY_PATH_ALIAS');
      if (prefix !== entry.path && snapshot.files.has(prefix)) throw Error('APPLY_PATH_TYPE');
    }
    const file = snapshot.files.get(entry.path);
    if (snapshot.directories.has(entry.path)) throw Error('APPLY_PATH_TYPE');
    if (entry.state === 'absent') { if (file) throw Error('APPLY_PREIMAGE'); }
    else if (!file?.bytes.equals(Buffer.from(entry.content)) || sha(file.bytes) !== entry.sha256 || gitMode(file.mode) !== entry.mode) throw Error('APPLY_PREIMAGE');
  }
}
function synchronous(value: unknown): void {
  if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('APPLY_AUTHORITY'); }
}
/** Experimental host-only filesystem applier. Exclusive physical writer lease is
 * a prerequisite, NOT established by inode checks. Node path APIs cannot defend
 * against a malicious same-UID process racing directory replacement. No automatic
 * rollback/replay/cleanup. Gate or completion ACK uncertainty retains quarantine.
 * Requires a pristine private candidate: no untracked/ignored files, sparse index,
 * symlinks, hardlinks or submodules. Existing unrelated bytes remain fully checked.
 * Changes to files are durable individually, never an atomic multi-file transaction. */
export function applyGraphChangeset(input: GraphApplyInput, port: GraphApplyPort): GraphApplyResult {
  const validated = validateChangesetProposal(input.proposal, input.manifest, input.policy, input.binding);
  if (validated.proposal.kind !== 'propose') throw Error('APPLY_PROPOSAL_REQUIRED');
  const root = input.workspace;
  if (!isAbsolute(root) || resolve(root) !== root || realpathSync(root) !== root) throw Error('APPLY_ROOT');
  const authority = () => synchronous(port.authorize()); authority();
  const before = inventory(root); const identity = before.directories.get('')!;
  const algorithm = validated.manifest.binding.treeRevision.length === 40 ? 'sha1' : 'sha256';
  const beforeTreeRevision = treeHash(before.files, algorithm);
  if (beforeTreeRevision !== validated.manifest.binding.treeRevision) throw Error('APPLY_TREE_MISMATCH');
  if (git(root, 'rev-parse', '--show-toplevel').trim() !== root) throw Error('APPLY_GIT_ROOT');
  const head = git(root, 'rev-parse', 'HEAD', 'HEAD^{tree}');
  if (head.trim().split('\n')[1] !== beforeTreeRevision) throw Error('APPLY_HEAD_MISMATCH');
  const index = git(root, 'ls-files', '--stage', '-v', '-z');
  const expectedIndex = [...before.files].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([path, f]) => `H ${gitMode(f.mode)} ${objectHash('blob', f.bytes, algorithm)} 0\t${path}\0`).join('');
  if (index !== expectedIndex) throw Error('APPLY_INDEX_MISMATCH');
  checkTargets(before, validated);
  const target = new Map(before.files);
  for (const change of validated.proposal.changes) {
    if (change.kind === 'delete') target.delete(change.path);
    else target.set(change.path, { bytes: Buffer.from(change.content), mode: change.kind === 'create' ? 0o644 : before.files.get(change.path)!.mode, dev: 0, ino: 0 });
  }
  const targetTreeRevision = treeHash(target, algorithm);
  const journal = freezeWorkerData({ schemaVersion: 1 as const, binding: validated.manifest.binding, manifestDigest: validated.manifestDigest, proposalDigest: validated.proposalDigest,
    beforeTreeRevision, targetTreeRevision, workspaceIdentity: { dev: identity.dev, ino: identity.ino }, beforeInventoryDigest: fingerprint(before), changes: validated.proposal.changes });
  const journalDigest = sha(`osstack.apply-journal.v1\n${workerCanonical(journal)}`);
  const recheck = (expected: Snapshot) => {
    authority(); if (realpathSync(root) !== root || fingerprint(inventory(root)) !== fingerprint(expected)) throw Error('APPLY_WORKSPACE_CHANGED');
    if (git(root, 'rev-parse', 'HEAD', 'HEAD^{tree}') !== head || git(root, 'ls-files', '--stage', '-v', '-z') !== index) throw Error('APPLY_GIT_CHANGED');
    authority();
  };
  recheck(before);
  const journalRef = port.journal(journal, journalDigest);
  if (typeof journalRef !== 'string' || !journalRef.length || journalRef.length > 256) throw Error('APPLY_JOURNAL_REF');
  recheck(before);
  const proof = freezeWorkerData({ journalDigest, journalRef, treeRevision: targetTreeRevision, proposalDigest: validated.proposalDigest });
  let gateAttempted = false;
  const failure: GraphApplyFailure = { phase: 'gate', completedChanges: 0, path: null, temporaryPath: null, code: 'APPLY_FAILED' };
  const expected: Snapshot = { files: new Map(before.files), directories: new Map(before.directories) };
  try {
    gateAttempted = true;
    const permitted: unknown = port.begin(journal, journalDigest, journalRef);
    if (permitted !== true) {
      if (permitted !== false) { void Promise.resolve(permitted).catch(() => {}); throw Error('APPLY_GATE'); }
      return { kind: 'not_authorized', treeRevision: targetTreeRevision, reconciliationRequired: true };
    }
    failure.phase = 'verify'; recheck(expected);
    for (const change of validated.proposal.changes) {
      failure.path = change.path; failure.phase = 'verify'; recheck(expected);
      const parts = change.path.split('/'); parts.pop(); let prefix = '';
      for (const part of parts) {
        prefix = prefix ? `${prefix}/${part}` : part;
        if (expected.directories.has(prefix)) continue;
        recheck(expected); failure.phase = 'mkdir'; const path = join(root, prefix); mkdirSync(path, { mode: 0o755 }); syncDirectory(path); syncDirectory(dirname(path));
        const stat = lstatSync(path); expected.directories.set(prefix, { dev: stat.dev, ino: stat.ino, mode: stat.mode & 0o777 });
        recheck(expected);
      }
      const path = join(root, change.path); failure.phase = change.kind;
      if (change.kind === 'delete') { unlinkSync(path); failure.phase = 'delete_sync'; syncDirectory(dirname(path)); expected.files.delete(change.path); }
      else {
        const temp = join(dirname(path), `.osstack-apply-${randomUUID()}`);
        failure.temporaryPath = temp.slice(root.length + 1);
        const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { writeFileSync(fd, change.content, 'utf8'); fchmodSync(fd, target.get(change.path)!.mode); fsyncSync(fd); } finally { closeSync(fd); }
        // Once a temp file exists, cancellation leaves it for quarantine; never
        // remove forensic state or continue the next operation after revocation.
        authority(); renameSync(temp, path); failure.phase = 'rename_sync'; syncDirectory(dirname(path)); expected.files.set(change.path, readFile(path)); failure.temporaryPath = null;
      }
      failure.completedChanges++; failure.phase = 'verify'; recheck(expected);
    }
    recheck(expected);
    if (treeHash(expected.files, algorithm) !== targetTreeRevision) throw Error('APPLY_POSTIMAGE');
    failure.phase = 'complete'; synchronous(port.complete(proof));
    return { kind: 'applied', treeRevision: targetTreeRevision, reconciliationRequired: false };
  } catch (error) {
    const errno = (error as NodeJS.ErrnoException | null)?.code;
    // Allowlisted host codes only; never persist provider/authority error text.
    if (typeof errno === 'string' && ['EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'ENOENT', 'EEXIST'].includes(errno)) failure.code = errno;
    const codes = ['APPLY_AUTHORITY', 'APPLY_ADMISSION_REQUIRED', 'APPLY_ACTION_STATE', 'APPLY_DEADLINE', 'APPLY_WORKSPACE_CHANGED', 'APPLY_GIT_CHANGED', 'APPLY_POSTIMAGE', 'APPLY_GATE'];
    if (error instanceof Error && codes.includes(error.message)) failure.code = error.message;
    let quarantined = false;
    if (gateAttempted) { try { synchronous(port.quarantine(freezeWorkerData({ ...proof, failure }))); quarantined = true; } catch { /* DB may have committed but lost its ACK. */ } }
    return { kind: quarantined ? 'quarantined' : 'reconciliation_required', treeRevision: targetTreeRevision, reconciliationRequired: true };
  }
}
