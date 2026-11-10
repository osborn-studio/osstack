import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { resolveRepositoryScope } from '@osstack/core';
import { inspectRepoWriteLock, releaseReconciledLocalLoopLock, type RepoLockOwner } from '@osstack/autonomy';
import { loopContainmentPath, type CommandObservation } from '@osstack/loop';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const runSchema = z.string().regex(/^local_loop_[a-f0-9-]{36}$/);
const ownerSchema = z.object({ pid: z.number().int().positive(), autonomy_run_id: runSchema, repo_id: z.string(),
  acquired_at: z.string().datetime(), token: z.string().uuid(), expires_at: z.string().datetime(), recovery_policy: z.literal('reconcile') }).strict();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const terminalSchema = z.object({ commandSha256: digest, receiptSha256: digest, exitCode: z.number(), durationMs: z.number(),
  failure_code: z.string().optional(),
  termination: z.object({ scope: z.string(), pgid: z.number().int().positive().optional(), leader_exit_code: z.number().optional(),
    trigger: z.string(), stop_confirmed: z.boolean(), signals: z.array(z.string()) }).strict().optional(),
}).strict();
const producerSchema = z.object({ id: z.string().uuid(), commandSha256: digest, cwd: z.string(), pgid: z.number().int().positive().optional(),
  terminal: terminalSchema.optional() }).strict();
const snapshotSchema = z.object({ sha256: digest, fileCount: z.number().int().nonnegative(), byteCount: z.number().int().nonnegative(),
  modes: z.array(z.number().int().nonnegative()) }).strict();
const quiescenceSchema = z.object({ version: z.literal(1), journalSha256: digest, runId: runSchema, repoId: z.string(), workspacePath: z.string(),
  allExternalProducersQuiescent: z.literal(true), workspaceQuarantined: z.literal(true), reviewedEvidenceSha256: digest }).strict();
const journalSchema = z.object({ version: z.literal(1), workspacePath: z.string(), commonDir: z.string(), repoId: z.string(),
  runId: runSchema, owner: ownerSchema, containmentPath: z.string(), containmentSha256: z.string().nullable().optional(), containedCommandsOnly: z.boolean(), sealed: z.boolean(),
  producers: z.array(producerSchema), snapshot: snapshotSchema.optional() }).strict();
type Journal = z.infer<typeof journalSchema>;

function read(path: string): Buffer {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 48 * 1024 * 1024) throw Error('local recovery evidence file invalid');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function publish(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path); sync(join(path, '..'));
}
function git(workspace: string, args: string[]): string {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const base = ['--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'diff.autoRefreshIndex=false', '-C', workspace];
  const options = { encoding: 'utf8' as const, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
    env: { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
      GIT_NO_REPLACE_OBJECTS: '1', GIT_NO_LAZY_FETCH: '1', GIT_TERMINAL_PROMPT: '0' } };
  let keys = '';
  try { keys = execFileSync('git', [...base, 'config', '--null', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|process|required)$'], options); }
  catch (error) { if ((error as { status?: number }).status !== 1) throw error; }
  // Even name-only/stat queries can invoke conversion. Disable every effective
  // driver, including process filters, before issuing content-sensitive queries.
  const drivers = new Set<string>();
  for (const key of keys.split('\0').filter(Boolean)) {
    if (!/^filter\.[A-Za-z0-9_.-]+\.(clean|process|required)$/i.test(key)) throw Error('local recovery Git filter configuration ambiguous');
    drivers.add(key.replace(/\.(clean|process|required)$/i, ''));
  }
  const overrides = [...drivers].flatMap(driver => ['-c', `${driver}.clean=`, '-c', `${driver}.process=`, '-c', `${driver}.required=false`]);
  return execFileSync('git', [...base, ...overrides, ...args], options);
}
/** Selected physical worktree only. Hash safe tracked/untracked content in
 * memory. Ignored files and other worktrees are never opened. Persist no bytes,
 * paths, raw diffs or command output. The native lease preserves files in place. */
function snapshot(workspace: string): z.infer<typeof snapshotSchema> {
  if (!isAbsolute(workspace) || realpathSync(workspace) !== workspace
    || git(workspace, ['rev-parse', '--show-toplevel']).replace(/\r?\n$/, '') !== workspace) throw Error('local recovery workspace path ambiguous');
  const hash = createHash('sha256');
  const add = (value: unknown) => hash.update(JSON.stringify(value));
  add(git(workspace, ['rev-parse', 'HEAD']));
  add(git(workspace, ['ls-files', '--stage', '-z']));
  // Drivers are disabled by git() even for stat/racy-index comparisons.
  // Cached diff compares staged entries without generating a patch.
  const changed = git(workspace, ['ls-files', '-z', '--modified', '--deleted']);
  const staged = git(workspace, ['diff', '--cached', '--name-only', '--no-renames', '--no-ext-diff', '--no-textconv', '-z', 'HEAD', '--']);
  const untracked = git(workspace, ['ls-files', '-z', '--others', '--exclude-standard']);
  const paths = [...new Set([changed, staged, untracked].flatMap(list => list.split('\0')).filter(Boolean))].sort();
  if (paths.length > 10000) throw Error('local recovery workspace limit');
  let byteCount = 0; const modes = new Set<number>();
  for (const relative of paths) {
    if (isAbsolute(relative) || relative.split('/').includes('..')
      || /(^|\/)(\.env(?:\..*)?|credentials(?:\..*)?|id_rsa|id_ed25519|[^/]*\.pem|[^/]*\.key)$/i.test(relative)) {
      throw Error('local recovery workspace sensitive or ambiguous file');
    }
    const full = join(workspace, relative);
    let stat: ReturnType<typeof lstatSync>;
    try { stat = lstatSync(full); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; add([relative, 'missing']); continue; }
    if (realpathSync(join(full, '..')) !== join(full, '..')) throw Error('local recovery workspace symlink');
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('local recovery workspace file ambiguous');
    byteCount += stat.size;
    if (byteCount > 32 * 1024 * 1024) throw Error('local recovery workspace limit');
    modes.add(stat.mode); add([relative, stat.mode, sha(read(full))]);
  }
  return { sha256: hash.digest('hex'), fileCount: paths.length, byteCount, modes: [...modes].sort() };
}
function dead(pid: number): void {
  try { process.kill(pid, 0); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return; throw Error('local recovery producer liveness unknown'); }
  throw Error('local recovery producer alive or identity reused');
}
function journalPath(commonDir: string, runId: string): string {
  runSchema.parse(runId); const dir = join(commonDir, 'osstack', 'local-loop-recovery');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (realpathSync(dir) !== dir) throw Error('local recovery journal directory ambiguous');
  return join(dir, `${runId}.json`);
}
export function journalDigest(path: string): string { return sha(read(path)); }

/** Only the foreground host creates the inventory; never reconstruct absent
 * intents from a worker receipt. Legacy runs without this journal stay held. */
export async function beginLocalLoopJournal(workspacePath: string, runId: string, containedCommandsOnly: boolean) {
  const scope = await resolveRepositoryScope(workspacePath);
  const owner = ownerSchema.parse(await inspectRepoWriteLock(join(scope.commonDir, 'osstack', 'writer-locks'), scope.repoId));
  if (owner.autonomy_run_id !== runId) throw Error('local recovery owner mismatch');
  const containmentPath = loopContainmentPath(scope.workspacePath);
  try { read(containmentPath); throw Error('local recovery pre-existing containment requires reconciliation'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const path = journalPath(scope.commonDir, runId);
  const body: Journal = { version: 1, workspacePath: scope.workspacePath, commonDir: scope.commonDir, repoId: scope.repoId,
    runId, owner, containmentPath, containedCommandsOnly, sealed: false, producers: [] };
  const fd = openSync(path, 'wx', 0o600); try { writeFileSync(fd, JSON.stringify(body)); fsyncSync(fd); } finally { closeSync(fd); }
  sync(join(path, '..'));
  return { path,
    observe(event: CommandObservation): void {
      if (body.sealed) throw Error('local recovery inventory sealed');
      if (event.kind === 'intent') {
        const cwd = realpathSync(event.cwd);
        if (cwd !== scope.workspacePath) throw Error('local recovery command workspace mismatch');
        body.producers.push({ id: event.id, commandSha256: sha(event.command), cwd });
      }
      else {
        const producer = body.producers.find(p => p.id === event.id);
        if (!producer || producer.terminal) throw Error('local recovery producer binding');
        if (event.kind === 'spawn') { if (producer.pgid) throw Error('local recovery duplicate spawn'); producer.pgid = event.pgid; }
        else {
          const result = event.result;
          const termination = result.termination;
          producer.terminal = { commandSha256: sha(result.command), receiptSha256: sha(JSON.stringify(result)),
            exitCode: result.exitCode, durationMs: result.durationMs,
            ...(result.failure_code ? { failure_code: result.failure_code } : {}),
            ...(termination ? { termination: { scope: termination.scope, trigger: termination.trigger,
              stop_confirmed: termination.stop_confirmed, signals: termination.signals,
              ...(termination.pgid === undefined ? {} : { pgid: termination.pgid }),
              ...(termination.leader_exit_code === undefined ? {} : { leader_exit_code: termination.leader_exit_code }) } } : {}),
          };
        }
      }
      publish(path, body);
    },
    async seal(): Promise<void> {
      const current = await inspectRepoWriteLock(join(scope.commonDir, 'osstack', 'writer-locks'), scope.repoId);
      if (!current || current.token !== owner.token || current.autonomy_run_id !== runId) throw Error('local recovery owner changed');
      body.owner = ownerSchema.parse(current);
      try { body.containmentSha256 = sha(read(containmentPath)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; body.containmentSha256 = null; }
      body.snapshot = snapshot(scope.workspacePath); body.sealed = true; publish(path, body);
    },
  };
}

/** Explicit operator approval pins the immutable sealed receipt digest. No DB,
 * graph decision, producer stop signal, or workspace mutation is part of recovery. */
export async function recoverLocalLoop(input: { workspacePath: string; runId: string; journalSha256: string; quiescenceEvidencePath: string; quiescenceEvidenceSha256: string }): Promise<'released' | 'already_released'> {
  if (!/^[a-f0-9]{64}$/.test(input.journalSha256)) throw Error('local recovery approval digest required');
  const scope = await resolveRepositoryScope(input.workspacePath);
  const path = journalPath(scope.commonDir, input.runId);
  const load = () => {
    const bytes = read(path); if (sha(bytes) !== input.journalSha256) throw Error('local recovery journal digest mismatch');
    return journalSchema.parse(JSON.parse(bytes.toString('utf8')));
  };
  const body = load();
  const loadQuiescence = () => {
    const bytes = read(input.quiescenceEvidencePath);
    if (sha(bytes) !== input.quiescenceEvidenceSha256) throw Error('local recovery external evidence digest mismatch');
    const evidence = quiescenceSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (evidence.journalSha256 !== input.journalSha256 || evidence.runId !== input.runId
      || evidence.repoId !== scope.repoId || evidence.workspacePath !== scope.workspacePath) throw Error('local recovery external evidence binding');
  };
  loadQuiescence();
  if (body.workspacePath !== scope.workspacePath || body.commonDir !== scope.commonDir || body.repoId !== scope.repoId
    || body.containmentPath !== loopContainmentPath(scope.workspacePath) || body.runId !== input.runId || body.owner.autonomy_run_id !== input.runId || body.owner.repo_id !== scope.repoId) throw Error('local recovery owner/run binding');
  const statePath = `${path}.release`;
  const releaseBinding = { journalSha256: input.journalSha256, owner: body.owner };
  const state = () => { try { return JSON.parse(read(statePath).toString('utf8')) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; } };
  const verify = (absent: boolean) => {
    load(); loadQuiescence(); dead(body.owner.pid);
    if (!body.containedCommandsOnly) throw Error('local recovery producer inventory ambiguous');
    if (!body.sealed || body.containmentSha256 === undefined || !body.snapshot || body.producers.length === 0) throw Error('local recovery terminal evidence missing');
    for (const producer of body.producers) {
      const t = producer.terminal?.termination;
      if (!producer.pgid || !t || t.scope !== 'posix_process_group' || !t.stop_confirmed || t.pgid !== producer.pgid
        || producer.cwd !== scope.workspacePath || producer.commandSha256 !== producer.terminal?.commandSha256 || producer.terminal?.failure_code === 'process_exit_unconfirmed'
        || producer.terminal?.failure_code === 'process_control_unsupported') throw Error('local recovery terminal producer evidence mismatched');
      dead(-producer.pgid);
    }
    let marker: string | null = null;
    try { marker = sha(read(body.containmentPath)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (marker !== body.containmentSha256 && !(marker === null && JSON.stringify(state()) === JSON.stringify(releaseBinding))) {
      throw Error('local recovery containment evidence changed');
    }
    if (absent && JSON.stringify(state()) !== JSON.stringify(releaseBinding)) throw Error('local recovery release intent missing');
    if (JSON.stringify(snapshot(scope.workspacePath)) !== JSON.stringify(body.snapshot)) throw Error('local recovery workspace changed');
  };
  let repeated = false;
  await releaseReconciledLocalLoopLock({ root_dir: join(scope.commonDir, 'osstack', 'writer-locks'), repo_id: scope.repoId,
    expectedOwner: body.owner as RepoLockOwner, verifyQuiescent: async (_owner, absent) => {
      verify(absent);
      if (absent) {
        if (JSON.stringify(state()) !== JSON.stringify(releaseBinding)) throw Error('local recovery release intent missing');
        repeated = true;
      } else publish(statePath, releaseBinding);
      // Clear only the exact journaled marker while the canonical mutation guard
      // still excludes admission. Crash after this step replays the release intent.
      try { unlinkSync(body.containmentPath); sync(join(body.containmentPath, '..')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    } });
  return repeated ? 'already_released' : 'released';
}
