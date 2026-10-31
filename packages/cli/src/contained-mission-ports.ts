// Real effects behind the contained Mission runner (W11 §5–§7, M6b): workspace
// creation, the Codex proxy, plumbing commits, temp-index diffs and contained
// verification. Nothing here runs repository code on the host.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CodexProxyExecutor, SafeFileError, commitPlumbing, createNoCheckoutWorktree, filterNeutralizingConfig, inspectRepoConfig, materializeCommit, runHardenedGit, safeReadFile, safeRelativePathSegments,
  type CodexProxyOptions, type HardenedGitContext, type HardenedGitOptions, type PlumbingCommitAuthor } from '@osstack/agents';
import { scratchPath, type ContainedEvent, type ContainedMission, type ContainedMissionStore } from '@osstack/core';
import { containedBindingCanonical, containedCommandFromArgv, containedOwnerPort, missionVerificationBinding, prepareContainedCandidateImage, registerContainedExecution, reopenContainedExecution, type ContainedOwnerIdentity } from './contained-verification.js';
import { parseContainedMissionSpec, type ContainedMissionPorts } from './contained-mission-runner.js';

export interface ContainedMissionPortsOptions {
  store: ContainedMissionStore; now?: () => number;
  /** Codex launcher, identity binary and login source; the runtime directory is chosen per Mission. */
  codex: Omit<CodexProxyOptions, 'runtimeDir'>;
  /** Parent of the per-Mission runtime directories (default: the scratch root's runtime/). */
  runtimeRoot?: string;
  verification: { socketPath: string; daemonId: string; baseImageId: string; journalRoot: string };
  author: PlumbingCommitAuthor;
  git?: HardenedGitContext;
}
export type ContainedVerificationStop = { stopped: true; proof: 'container_removed' | 'never_launched'; evidence: string } | { stopped: false };
export interface ContainedMissionHostPorts extends ContainedMissionPorts {
  /** Recovery-only check that the Mission's last verification left no container; it never starts one. */
  verificationStopped: (mission: ContainedMission) => Promise<ContainedVerificationStop>;
}
type FileChange = { path: string; action: 'write'; content: string } | { path: string; action: 'delete' };
type Git = (args: string[], extra?: Partial<HardenedGitOptions>) => Promise<{ stdout: Buffer; exitCode: number }>;

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MAX_WORKTREE_FILES = 10_000;
const text = (result: { stdout: Buffer }) => result.stdout.toString('utf8').trim();
const nulList = (result: { stdout: Buffer }) => result.stdout.toString('utf8').split('\0').filter(Boolean);
const utf8 = (bytes: Uint8Array, code: string) => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw Error(code); } };
const assertSha = (value: string) => { if (!FULL_SHA.test(value)) throw Error('CONTAINED_INVALID_COMMIT'); };

/** Deterministic per-attempt invocation id, so recovery finds the journal without trusting a label. */
export const containedVerifyInvocationId = (mission: Pick<ContainedMission, 'mission_id' | 'verify_attempts'>) => `${mission.mission_id}.verify.${mission.verify_attempts}`;
/** Every event of a Mission in order (bounded pages). */
export function containedEvents(store: ContainedMissionStore, missionId: string, maxPages = 40): ContainedEvent[] {
  const all: ContainedEvent[] = [];
  for (let page = 0, after = 0; page < maxPages; page++) {
    const rows = store.events(missionId, after, 500); all.push(...rows);
    if (rows.length < 500) return all;
    after = rows.at(-1)!.seq;
  }
  throw Error('CONTAINED_EVENTS_LIMIT');
}
/** Index of the last state transition into one of `states`, or -1. */
export function lastTransitionTo(events: readonly ContainedEvent[], states: readonly string[]): number {
  for (let i = events.length - 1; i >= 0; i--) if (states.includes(eventPayload(events[i]!).to as string)) return i;
  return -1;
}
export const eventPayload = (event: ContainedEvent): Record<string, unknown> => { try { return JSON.parse(event.payload_json) as Record<string, unknown>; } catch { return {}; } };

export function createContainedMissionPorts(options: ContainedMissionPortsOptions): ContainedMissionHostPorts {
  const { store, verification, author } = options; const ctx = options.git ?? {};
  const now = options.now ?? Date.now;
  const runtimeRoot = resolve(options.runtimeRoot ?? scratchPath('runtime'));
  const runtimeDir = (worktree: string) => {
    const dir = join(runtimeRoot, `mission-${sha(resolve(worktree)).slice(0, 16)}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 }); return dir;
  };
  const executors = new Map<string, CodexProxyExecutor>();
  const executor = (worktree: string) => {
    const dir = runtimeDir(worktree); let found = executors.get(dir);
    if (!found) { found = new CodexProxyExecutor({ ...options.codex, runtimeDir: dir }); executors.set(dir, found); }
    return found;
  };
  const git = (cwd: string): Git => (args, extra = {}) => runHardenedGit(args, { ...ctx, ...extra, cwd });
  // Every index write runs with all configured filter drivers disabled, the same way M3 commits do.
  const withTempIndex = async <T>(worktree: string, fn: (run: Git) => Promise<T>): Promise<T> => {
    const index = join(runtimeDir(worktree), `diff-${randomBytes(8).toString('hex')}.index`);
    const config = await filterNeutralizingConfig(worktree, ctx);
    const run: Git = (args, extra = {}) => runHardenedGit(args, { ...ctx, config, ...extra, cwd: worktree, gitEnv: { GIT_INDEX_FILE: index } });
    try { return await fn(run); } finally { rmSync(index, { force: true }); rmSync(`${index}.lock`, { force: true }); }
  };
  const diffTrees = async (run: Git, from: string, to: string) => utf8((await run(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--full-index', '--no-color', '--no-relative',
    '--src-prefix=a/', '--dst-prefix=b/', from, to])).stdout, 'CONTAINED_DIFF_NOT_UTF8');
  const headModes = async (run: Git, commit: string, paths: readonly string[]) => {
    const modes = new Map<string, string>();
    if (paths.length === 0) return modes;
    for (const row of nulList(await run(['--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', ...paths]))) {
      const match = /^(\d{6}) \w+ [0-9a-f]+\t([\s\S]+)$/.exec(row);
      if (match) modes.set(match[2]!, match[1]!);
    }
    return modes;
  };
  const hashInto = async (run: Git, path: string, bytes: Uint8Array, mode: string) => {
    const blob = text(await run(['hash-object', '-w', '--no-filters', '--stdin'], { input: bytes }));
    await run(['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`]);
  };
  // The digest recorded when this Mission's workspace was created; commits recheck the repository config against it.
  const recordedConfigDigest = (worktree: string): string => {
    const rows = store.db.prepare(`SELECT e.mission_id,e.payload_json FROM engineering_contained_events e JOIN engineering_workspace_claims c ON c.mission_id=e.mission_id
      WHERE e.kind='workspace_created' AND c.state='active' ORDER BY e.seq`).all() as Array<{ mission_id: string; payload_json: string }>;
    const target = resolve(worktree);
    const matches = rows.map(r => ({ id: r.mission_id, p: JSON.parse(r.payload_json) as { worktree?: string; config_digest?: string } })).filter(r => r.p.worktree === target);
    if (new Set(matches.map(r => r.id)).size !== 1 || typeof matches.at(-1)!.p.config_digest !== 'string') throw Error('CONTAINED_WORKSPACE_UNRECORDED');
    return matches.at(-1)!.p.config_digest!;
  };
  const branchHead = async (worktree: string, branch: string) => {
    const run = git(worktree);
    if (text(await run(['symbolic-ref', '-q', 'HEAD'], { okExitCodes: [0, 1] })) !== `refs/heads/${branch}`) throw Error('CONTAINED_BRANCH_MISMATCH');
    return text(await run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`]));
  };

  const ports: ContainedMissionHostPorts = {
    store, now,
    createWorkspace: async (spec, signal) => {
      const context = { ...ctx, signal };
      const inspection = await inspectRepoConfig(spec.repo_path, context);
      if (inspection.rejections.length > 0) throw Error(`CONTAINED_REPO_CONFIG_REJECTED:${[...new Set(inspection.rejections.map(r => r.code))].join(',')}`);
      assertSha(spec.start_commit);
      try { await runHardenedGit(['cat-file', '-e', `${spec.start_commit}^{commit}`], { ...context, cwd: spec.repo_path }); }
      catch { throw Error('CONTAINED_START_COMMIT_MISSING'); }
      const worktree = resolve(spec.worktree_path);
      await createNoCheckoutWorktree({ repoPath: spec.repo_path, worktreePath: worktree, branch: spec.branch, startCommit: spec.start_commit, expectedConfigDigest: inspection.digest, git: context });
      const head = text(await runHardenedGit(['rev-parse', '--verify', 'HEAD'], { ...context, cwd: worktree }));
      return { worktree, gitDir: inspection.gitDir, head, configDigest: inspection.digest };
    },
    qualify: (worktree, gitDir) => executor(worktree).qualify(worktree, gitDir),
    execute: input => executor(input.worktree).run({ worktree: input.worktree, prompt: input.prompt, signal: input.signal, onLaunched: input.onLaunched }),
    readFile: async (worktree, path) => {
      try { return utf8((await safeReadFile(worktree, path)).bytes, 'CONTAINED_FILE_NOT_UTF8'); }
      catch (error) { if (error instanceof SafeFileError && error.code === 'SAFE_PATH_NOT_FOUND') return null; throw error; }
    },
    commit: async input => {
      const expectedConfigDigest = recordedConfigDigest(input.worktree);
      const modes = await headModes(git(input.worktree), input.expectedHead, input.files.map(f => f.path));
      // Keep each file's committed mode; cumulativeDiff assumes the same, so what was classified is what is committed.
      const files = input.files.map(f => f.action === 'delete' ? f : { ...f, executable: modes.get(f.path) === '100755' });
      return commitPlumbing({ worktree: input.worktree, branch: input.branch, expectedHead: input.expectedHead, files, message: input.message, author, expectedConfigDigest, git: ctx });
    },
    cumulativeDiff: async input => {
      assertSha(input.startCommit); assertSha(input.expectedHead);
      for (const f of input.files) safeRelativePathSegments(f.path);
      return withTempIndex(input.worktree, async run => {
        await run(['read-tree', input.expectedHead]);
        const modes = await headModes(run, input.expectedHead, input.files.map(f => f.path));
        for (const f of input.files as readonly FileChange[]) {
          if (f.action === 'delete') await run(['update-index', '--force-remove', '--', f.path]);
          else await hashInto(run, f.path, Buffer.from(f.content), modes.get(f.path) === '100755' ? '100755' : '100644');
        }
        return diffTrees(run, input.startCommit, text(await run(['write-tree'])));
      });
    },
    restoreWorkspace: async input => {
      assertSha(input.expectedHead);
      const current = await branchHead(input.worktree, input.branch);
      // A host commit the ledger never recorded is dropped from the branch (its objects stay in the repository).
      if (current !== input.expectedHead) await git(input.worktree)(['update-ref', '-m', 'osstack: discard unrecorded commit', `refs/heads/${input.branch}`, input.expectedHead, current]);
      // Anything standing where a tracked file must go (a symlink, a directory, a hard link) is removed first, never followed.
      const tracked = nulList(await git(input.worktree)(['ls-tree', '-r', '-z', '--name-only', '--full-tree', input.expectedHead]));
      if (tracked.length > MAX_WORKTREE_FILES) throw Error('CONTAINED_WORKTREE_LIMIT');
      for (const path of tracked) await clearObstruction(input.worktree, path, true);
      await materializeCommit(input.worktree, input.expectedHead, { git: ctx });
      const config = await filterNeutralizingConfig(input.worktree, ctx);
      const others = nulList(await runHardenedGit(['ls-files', '--others', '-z'], { ...ctx, config, cwd: input.worktree }));
      if (others.length > MAX_WORKTREE_FILES) throw Error('CONTAINED_WORKTREE_LIMIT');
      for (const path of others) await clearObstruction(input.worktree, path, false);
    },
    worktreeDiff: async input => {
      assertSha(input.startCommit);
      return withTempIndex(input.worktree, async run => {
        await run(['read-tree', input.startCommit]);
        const tracked = nulList(await run(['ls-files', '-z']));
        // No exclude rules: an ignored file is still a change the classifier must see.
        const others = nulList(await run(['ls-files', '--others', '-z']));
        if (tracked.length + others.length > MAX_WORKTREE_FILES) throw Error('CONTAINED_WORKTREE_LIMIT');
        const unsafe: string[] = [];
        for (const path of [...tracked, ...others]) {
          let read: Awaited<ReturnType<typeof safeReadFile>>;
          try { read = await safeReadFile(input.worktree, path); }
          catch (error) {
            if (error instanceof SafeFileError && error.code === 'SAFE_PATH_NOT_FOUND') { await run(['update-index', '--force-remove', '--', path]); continue; }
            if (error instanceof SafeFileError) { unsafe.push(`${error.code}:${path}`.slice(0, 512)); continue; }
            throw error;
          }
          await hashInto(run, path, read.bytes, read.executable ? '100755' : '100644');
        }
        const tree = text(await run(['write-tree']));
        return { diff: unsafe.length > 0 ? '' : await diffTrees(run, input.startCommit, tree), tree, unsafe };
      });
    },
    commitWorktree: async input => {
      assertSha(input.tree);
      const expectedConfigDigest = recordedConfigDigest(input.worktree);
      assertSha(input.expectedHead);
      const current = await branchHead(input.worktree, input.branch);
      const run = git(input.worktree);
      // Only the ledger head is trusted ancestry: an unrecorded commit's history was never classified, so it is dropped.
      if (current !== input.expectedHead) await run(['update-ref', '-m', 'osstack: drop unrecorded commit', `refs/heads/${input.branch}`, input.expectedHead, current]);
      const head = input.expectedHead;
      const status = nulList(await run(['diff-tree', '-r', '-z', '--no-renames', '--name-status', head, input.tree]));
      const files: Array<{ path: string; action: 'write' } | { path: string; action: 'delete' }> = [];
      for (let i = 0; i + 1 < status.length; i += 2) files.push({ path: status[i + 1]!, action: status[i] === 'D' ? 'delete' : 'write' });
      if (files.length === 0) return { head, tree: text(await run(['rev-parse', '--verify', `${head}^{tree}`])) };
      const commit = await commitPlumbing({ worktree: input.worktree, branch: input.branch, expectedHead: head, files, message: input.message, author, expectedConfigDigest, git: ctx });
      if (commit.tree !== input.tree) throw Error('CONTAINED_ADOPT_TREE_MISMATCH');
      return commit;
    },
    verify: async (mission, argv, signal) => {
      const spec = parseContainedMissionSpec(mission.spec_json);
      const binding = missionVerificationBinding(mission, { argv }); const { command } = containedCommandFromArgv(argv);
      const invocationId = containedVerifyInvocationId(mission);
      // Start needs the Mission still verifying this candidate; stop and read stay allowed after a cancel.
      const fence = (start: boolean) => () => {
        store.attention.assertOwner(store.owner);
        const current = store.get(mission.mission_id);
        if (current.verify_attempts !== mission.verify_attempts || current.candidate_head !== mission.candidate_head || (start && current.state !== 'verifying')) throw Error('CONTAINED_VERIFY_FENCE');
      };
      store.record(mission.mission_id, 'verify_invocation', { invocation_id: invocationId, journal_root: verification.journalRoot, daemon_id: verification.daemonId, base_image_id: verification.baseImageId, command }, now());
      const image = await prepareContainedCandidateImage(verification, spec.worktree_path, mission.candidate_head!, fence(true));
      const { registration } = registerContainedExecution({ ...verification, authorizeStop: fence(false), authorizeRead: fence(false) }, image, binding, command, containedOwnerPort);
      let result: Awaited<ReturnType<typeof registration.execute>>['result'];
      try { result = (await registration.execute({ owner_kind: 'contained_mission', owner_id: mission.mission_id, invocationId }, signal, fence(true))).result; }
      catch (error) {
        const proof = await registration.confirmStopped(invocationId);
        if (proof.stopped) return { exit_code: null, output: '', cancelled: signal.aborted, evidence: proof.evidence, stopped: true };
        throw error;
      }
      return { exit_code: result.exitCode, output: result.output, cancelled: result.cancelled, evidence: result.evidence, stopped: removalProven(result) };
    },
    verificationStopped: async mission => {
      try {
        const events = containedEvents(store, mission.mission_id);
        const opened = lastTransitionTo(events, ['verifying']);
        const recorded = events.slice(opened + 1).filter(e => e.kind === 'verify_invocation').at(-1);
        // verify_invocation is written before any Docker call; without it nothing was launched for this attempt.
        if (opened >= 0 && !recorded) return { stopped: true, proof: 'never_launched', evidence: 'verify_invocation_absent' };
        const invocationId = containedVerifyInvocationId(mission);
        const r = recorded ? eventPayload(recorded) : {};
        if (!recorded || r.invocation_id !== invocationId || r.journal_root !== verification.journalRoot || realpathSync(verification.journalRoot) !== verification.journalRoot) return { stopped: false };
        // The executor creates this directory before the binding and any container create.
        if (!existsSync(join(verification.journalRoot, sha(invocationId)))) return { stopped: true, proof: 'never_launched', evidence: 'journal_absent' };
        const spec = parseContainedMissionSpec(mission.spec_json); const { command } = containedCommandFromArgv(spec.verify.argv);
        const expected = containedBindingCanonical(missionVerificationBinding({ ...mission, state: 'verifying' }, { argv: spec.verify.argv }));
        const fence = () => { store.attention.assertOwner(store.owner); if (store.get(mission.mission_id).revision !== mission.revision) throw Error('CONTAINED_RECOVERY_CHANGED'); };
        const reopened = await reopenContainedExecution<ContainedOwnerIdentity>({ ...verification, authorizeRead: fence, authorizeStop: fence }, {
          invocationId, command, mode: 'held', fence, inTransaction: () => store.db.inTransaction,
          validate: value => {
            const id = value as ContainedOwnerIdentity;
            if (id?.version !== 1 || id.invocationId !== invocationId || id.command !== command || containedBindingCanonical(id.binding) !== expected
              || id.image?.daemonId !== verification.daemonId || id.image.baseImageId !== verification.baseImageId) throw Error('CONTAINED_LEDGER_BINDING');
            return { identity: id, image: id.image };
          },
        });
        let proof = await reopened.confirmStopped();
        if (!proof.stopped) proof = await reopened.stop();
        return { stopped: true, proof: 'container_removed', evidence: proof.evidence };
      } catch { return { stopped: false }; }
    },
  };
  return ports;
}

/**
 * Walk `relPath` under `root` with lstat only and remove the first entry in the way:
 * a non-directory where a directory is needed, or the leaf itself unless `keepRegular`
 * and it is a single-link regular file. `rm` never follows a symlink.
 */
async function clearObstruction(root: string, relPath: string, keepRegular: boolean): Promise<void> {
  const segments = safeRelativePathSegments(relPath);
  let current = await realpath(root);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stat = await lstat(current).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (!stat) return;
    if (index < segments.length - 1) {
      if (stat.isDirectory()) continue;
      await rm(current, { force: true }); return;
    }
    if (keepRegular && stat.isFile() && stat.nlink === 1) return;
    await rm(current, { recursive: true, force: true }); return;
  }
}

/** True only when the result carries the Docker removal receipt its evidence names (as Graph checks it). */
export function removalProven(result: { evidence: string; stopReceipt?: { version: number; kind: string; launch: Record<string, unknown>; confirmedAt: number } }): boolean {
  const r = result.stopReceipt;
  if (r?.version !== 1 || r.kind !== 'docker_removed' || !r.launch) return false;
  const l = r.launch;
  return result.evidence === `docker-removed:${sha(JSON.stringify({ version: 1, kind: 'docker_removed', launch: { version: l.version, invocationId: l.invocationId, specDigest: l.specDigest, daemonId: l.daemonId, containerId: l.containerId, nonce: l.nonce }, confirmedAt: r.confirmedAt }))}`;
}
