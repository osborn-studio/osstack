// Real effects behind the contained Mission runner (W11 §5–§7, M6b): workspace
// creation, the Codex proxy, plumbing commits, temp-index diffs and contained
// verification. Nothing here runs repository code on the host.
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { CodexProxyExecutor, SafeFileError, assertRepoConfigUnchanged, commitPlumbing, createNoCheckoutWorktree, filterNeutralizingConfig, inspectRepoConfig, materializeCommit, runHardenedGit, safeReadFile, safeRelativePathSegments,
  type CodexProxyOptions, type HardenedGitContext, type HardenedGitOptions, type PlumbingCommitAuthor } from '@osstack/agents';
import { scratchPath, type ContainedEvent, type ContainedMission, type ContainedMissionStore } from '@osstack/core';
import { openPullRequestToGitHub, type DeliveryCommandRunner } from '@osstack/github';
import { redactSecrets } from '@osstack/governance';
import { containedBindingCanonical, containedCommandFromArgv, containedOwnerPort, missionVerificationBinding, prepareContainedCandidateImage, registerContainedExecution, reopenContainedExecution, type ContainedOwnerIdentity } from './contained-verification.js';
import { HostProcessKit, type HostProcessKitOptions } from './contained-mission-host-process.js';
import { appTransportConfig, gatedBridgeExec, gatedHostRunner, remoteBranchOf, remoteTargetOf, type RemoteWriteBinaries } from './contained-mission-remote-writes.js';
import { parseContainedMissionSpec, type ContainedMissionPorts } from './contained-mission-runner.js';
import type { BridgeKit, BridgeOptions, DeliveryEvidenceFacts } from './contained-mission-bridge.js';

export interface ContainedMissionPortsOptions {
  store: ContainedMissionStore; now?: () => number;
  /** Codex launcher, identity binary and login source; the runtime directory is chosen per Mission. */
  codex: Omit<CodexProxyOptions, 'runtimeDir'>;
  /** Parent of the per-Mission runtime directories (default: the scratch root's runtime/). */
  runtimeRoot?: string;
  verification: { socketPath: string; daemonId: string; baseImageId: string; journalRoot: string };
  author: PlumbingCommitAuthor;
  /** Command runner for the PR-only publication; the default uses the host's own git and gh credentials. */
  delivery?: { runner?: DeliveryCommandRunner; /** Test seam: absolute `git`/`gh` for the gated launcher. */ binaries?: RemoteWriteBinaries };
  git?: HardenedGitContext;
  /** W13: every covered local git write (ref update, worktree add, real-index write) is launched through the gated launcher and journaled here. Required: there is no ungated mode. */
  hostProcess: HostProcessKitOptions;
  /** GitHub Apps bridge (plan phase 3). App mode applies only to the configured repository; without this the host's own gh/git credentials are used. */
  bridge?: BridgeOptions;
}
export type ContainedVerificationStop = { stopped: true; proof: 'container_removed' | 'never_launched'; evidence: string } | { stopped: false };
export interface ContainedMissionHostPorts extends ContainedMissionPorts {
  /** Bind live authority before installing revision services. Checks re-read this at the network boundary. */
  installRevisionCheckAuthority?: (enabled: () => boolean) => void;
  revisionLaunchCaps?: { executor_seconds: number; verify_seconds: number };
  /** Production revision publication effects. Available only with App A configured. */
  revisionPublicationAdapters?: () => Promise<Pick<import('./contained-mission-revision-publication.js').RevisionPublicationDeps, 'runner' | 'preflight' | 'localGit'>>;
  /** Recovery-only check that the Mission's last verification left no container; it never starts one. */
  verificationStopped: (mission: ContainedMission) => Promise<ContainedVerificationStop>;
  /** Recovery-side access to the host child-process ledger and its probes (W13). */
  hostProcesses: HostProcessKit;
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

/** owner/name of a github.com remote URL (https, ssh or scp-like), otherwise undefined. */
export function githubRepositoryOf(url: string): string | undefined {
  const match = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com(?::22)?\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match?.[1];
}
/** gh subcommands the contained publication may run. `pr create` is the one write, gated; `api` is read-only (see `ghApiIsRead`). */
const GH_PR_READS = new Set(['view', 'list', 'status', 'checks', 'diff']);
/** `gh api` is allowed only as a plain GET of one endpoint: exact flags, no short-option clusters, no body or method override. */
function ghApiIsRead(args: readonly string[]): boolean {
  let endpoints = 0;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '-H' || a === '--header' || a === '--jq' || a === '-q') { if (typeof args[i + 1] !== 'string') return false; i++; continue; }
    if (a === '-X' || a === '--method') { if (args[i + 1] !== 'GET') return false; i++; continue; }
    if (a === '--paginate' || a === '--slurp') continue;
    if (a.startsWith('-')) return false;
    endpoints++;
  }
  return endpoints === 1;
}
const SAFE_ARG = /^[^\0\n]*$/;
/** git commands the publication may run besides the gated push, each in its one read-only form. */
function gitReadAllowed(args: readonly string[]): boolean {
  if (!args.every(a => SAFE_ARG.test(a))) return false;
  switch (args[0]) {
    case 'remote': return args[1] === 'get-url' && args.slice(2).every(a => a === '--push' || a === '--all' || a === '--' || !a.startsWith('-'));
    case 'ls-remote': return args.slice(1).every(a => a === '--refs' || a === '--' || !a.startsWith('-'));
    case 'branch': return args.length === 2 && args[1] === '--show-current';
    case 'status': return args.slice(1).every(a => /^(?:--porcelain(?:=v1)?|-z|--untracked-files=all)$/.test(a));
    case 'rev-parse': return args.slice(1).every(a => !/^--(?:output|exec|upload-pack)/.test(a));
    case 'check-ref-format': return args.slice(1).every(a => a === '--branch' || !a.startsWith('-'));
    case 'merge-base': return args.slice(1).every(a => a === '--is-ancestor' || !a.startsWith('-'));
    default: return false;
  }
}
/** `gh pr create` in the one form delivery uses: `--base --head --title --body-file` (values) and `--draft`. No `--repo`, `--web`, `--fill` or other target. */
function prCreateAllowed(args: readonly string[]): boolean {
  const seen = new Set<string>();
  for (let i = 2; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--draft') { if (seen.has(a)) return false; seen.add(a); continue; }
    if (!['--base', '--head', '--title', '--body-file'].includes(a) || seen.has(a) || typeof args[i + 1] !== 'string') return false;
    seen.add(a); i++;
  }
  return seen.has('--base') && seen.has('--head') && seen.has('--title') && seen.has('--body-file');
}
/**
 * The one push form this path runs: `push [--porcelain] [--force-with-lease=refs/heads/<b>:<sha>] <granted remote> <sha>:refs/heads/<b>`.
 * Anything else (a second refspec, a deletion, another remote or URL, --all, --mirror, --delete, -o, --receive-pack) has no ledger target.
 */
function pushBranch(args: readonly string[], remote: string): string | undefined {
  const flags = args.slice(1).filter(a => a.startsWith('-')); const positional = args.slice(1).filter(a => !a.startsWith('-'));
  if (positional.length !== 2 || positional[0] !== remote) return undefined;
  const target = /^[0-9a-f]{40}(?:[0-9a-f]{24})?:refs\/heads\/(.+)$/.exec(positional[1]!)?.[1];
  if (target === undefined) return undefined;
  for (const flag of flags) {
    if (flag === '--porcelain') continue;
    const lease = /^--force-with-lease=refs\/heads\/(.+):[0-9a-f]{40}(?:[0-9a-f]{24})?$/.exec(flag);
    if (lease?.[1] === target) continue;
    return undefined;
  }
  return target;
}
/**
 * Wraps the delivery runner so that every remote write is gated (W13-C2). `git push` and `gh pr create` are the only writes: each is
 * handed to the inner runner with a gate whose `fence` is the Mission's publication fence, which the launcher runs synchronously in
 * the release transaction after the process is registered. The fence no longer runs before `inner.run`; a runner that is not `gated`
 * never runs a write. Everything else is an allowlist of reads: git without hooks or fsmonitor and only over https/ssh, gh limited to
 * `auth status`, `repo view`, GET-only `api`, `pr view/list/status/checks/diff` and `pr create`.
 */
export function fencedDeliveryRunner(inner: DeliveryCommandRunner, beforeRemoteMutation: (kind: 'push' | 'pr_create') => void,
  destination: { remote: string; repository: string; missionId: string; httpsOnly?: boolean }): DeliveryCommandRunner {
  type RunOptions = Parameters<DeliveryCommandRunner['run']>[2];
  const hardened = (args: readonly string[]) => ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always', '-c', 'protocol.ssh.allow=always',
    // A push is exactly the one refspec: no tags and no submodule pushes ride along from a repository's own configuration.
    '-c', 'push.followTags=false', '-c', 'push.recurseSubmodules=no', ...args];
  const gate = (kind: 'git_push' | 'gh_pr_create', branch: string | undefined, fence: () => void, runOptions: RunOptions) => {
    if (branch === undefined || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/.test(branch)) throw Error('CONTAINED_PUBLICATION_TARGET');
    // Only the fence the publication fence owns runs in the release transaction; a caller-supplied gate is never trusted.
    return { missionId: destination.missionId, kind, remoteTarget: remoteTargetOf(destination.repository, branch), localTarget: `${runOptions.cwd}#refs/heads/${branch}`,
      ...(runOptions.intentId === undefined ? {} : { intentId: runOptions.intentId }), fence } as const;
  };
  return {
    ...(inner.gated === true ? { gated: true as const } : {}),
    async run(command, args, runOptions) {
      const { gate: ignored, ...clean } = runOptions; void ignored;
      if (command === 'gh') {
        if (args[0] === 'pr' && args[1] === 'create') {
          if (inner.gated !== true) throw Error('CONTAINED_PUBLICATION_UNGATED');
          if (!prCreateAllowed(args)) throw Error('CONTAINED_PUBLICATION_FORBIDDEN');
          return inner.run(command, args, { ...clean, gate: gate('gh_pr_create', remoteBranchOf('gh', args), () => { beforeRemoteMutation('pr_create'); }, clean) });
        }
        const readOnly = (args[0] === 'auth' && args[1] === 'status') || (args[0] === 'repo' && args[1] === 'view')
          || (args[0] === 'api' && ghApiIsRead(args)) || (args[0] === 'pr' && GH_PR_READS.has(args[1] ?? ''));
        if (!readOnly) throw Error('CONTAINED_PUBLICATION_FORBIDDEN');
        return inner.run(command, args, clean);
      }
      if (command !== 'git') throw Error('CONTAINED_PUBLICATION_FORBIDDEN');
      // No caller-supplied global options: a later `-c` would override the hardening (or rewrite the destination) in front of it.
      const sub = args[0];
      if (sub !== 'push' && !gitReadAllowed(args)) throw Error('CONTAINED_PUBLICATION_FORBIDDEN');
      const git = (rest: readonly string[], extra: RunOptions) => inner.run('git', hardened(rest), extra);
      if (sub !== 'push') return git(args, clean);
      if (inner.gated !== true) throw Error('CONTAINED_PUBLICATION_UNGATED');
      // Resolved with the same configuration the push will use, so pushurl and any pushInsteadOf rewrite are included.
      const urls = await git(['remote', 'get-url', '--push', '--all', '--', destination.remote], clean);
      const list = urls.exitCode === 0 ? urls.stdout.split('\n').map(u => u.trim()).filter(Boolean) : [];
      if (list.length === 0 || list.some(url => githubRepositoryOf(url)?.toLowerCase() !== destination.repository.toLowerCase())) throw Error('CONTAINED_PUBLICATION_DESTINATION');
      // Bridge mode: re-checked at push time, so a remote switched to ssh can never push with the host's own key.
      if (destination.httpsOnly && list.some(url => !/^https:\/\/github\.com\//i.test(url))) throw Error('CONTAINED_BRIDGE_REQUIRES_HTTPS');
      // The URL re-check above covered `destination.remote`; the push must name exactly that remote and exactly one branch.
      return git(args, { ...clean, gate: gate('git_push', pushBranch(args, destination.remote), () => { beforeRemoteMutation('push'); }, clean) });
    },
  };
}

export function createContainedMissionPorts(options: ContainedMissionPortsOptions): ContainedMissionHostPorts {
  const { store, verification, author } = options; const ctx = options.git ?? {};
  const now = options.now ?? Date.now;
  const kit = new HostProcessKit(store, options.hostProcess, now);
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

  // The bridge module and its token sources load once, on first use.
  let kitPromise: Promise<BridgeKit> | undefined;
  let revisionCheckEnabled: (() => boolean) | undefined;
  const bridgeKit = (): Promise<BridgeKit> => {
    kitPromise ??= import('./contained-mission-bridge.js').then(m => m.createBridgeKit({ ...options.bridge!,
      beforeCheckMutation: () => {
        store.attention.assertOwner(store.owner);
        if (revisionCheckEnabled && !revisionCheckEnabled()) throw Error('bridge_live_disabled');
        options.bridge?.beforeCheckMutation?.();
      }, exec: options.bridge!.exec ?? gatedBridgeExec(kit, options.delivery?.binaries) }));
    return kitPromise;
  };
  const revisionPublicationAdapters = async () => {
    if (!options.bridge || options.bridge.disabled) throw Error('BRIDGE_DISABLED');
    const app = await bridgeKit();
    if (app.exec.gated !== true) throw Error('CONTAINED_PUBLICATION_UNGATED');
    const hostRunner = options.delivery?.runner ?? gatedHostRunner(kit, options.delivery?.binaries);
    const { appCredentialRunner } = await import('./contained-mission-bridge.js');
    const preflight = async (spec: import('./contained-mission-runner.js').ContainedMissionSpec, permit: import('./contained-mission-runner.js').ContainedPublicationPermit, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      if (options.bridge?.disabled) throw Error('BRIDGE_DISABLED');
      if (!spec.publication || spec.publication.repository.toLowerCase() !== app.config.repository.toLowerCase()) throw Error('push_url_invalid');
      try { await assertRepoConfigUnchanged(spec.repo_path, recordedConfigDigest(spec.worktree_path), { ...ctx, ...(signal ? { signal } : {}) }); }
      catch (error) { signal?.throwIfAborted(); throw Error('repo_config_changed', { cause: error }); }
      if (await branchHead(spec.worktree_path, spec.branch) !== permit.head) throw Error('local_head_mismatch');
      const urls = text(await git(spec.worktree_path)(['remote', 'get-url', '--push', '--all', '--', spec.publication.remote],
        { timeoutMs: 30_000, maxOutputBytes: 1_048_576, ...(signal ? { signal } : {}) })).split('\n').filter(Boolean);
      if (urls.length !== 1 || !/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?\/?$/i.test(urls[0]!)
        || githubRepositoryOf(urls[0]!)?.toLowerCase() !== app.config.repository.toLowerCase()) throw Error('push_url_invalid');
      await appTransportConfig(hostRunner, spec.worktree_path, signal);
    };
    // Token refresh may yield for seconds. Revalidate the stored Mission's workspace after that await,
    // before the W13 launcher registers and synchronously releases the process.
    const credentialedExec: import('./contained-mission-bridge.js').BridgeExec = Object.assign(async (command: string, args: readonly string[], opts: Parameters<import('./contained-mission-bridge.js').BridgeExec>[2]) => {
      store.attention.assertOwner(store.owner);
      if (!opts.gate || command !== 'git' || opts.gate.kind !== 'git_push') throw Error('CONTAINED_REVISION_PR_CREATE_DENIED');
      const mission = store.get(opts.gate.missionId);
      const spec = parseContainedMissionSpec(mission.spec_json);
      if (resolve(opts.cwd) !== resolve(spec.worktree_path)) throw Error('repo_config_changed');
      const head = args.map(arg => /^([0-9a-f]{40}(?:[0-9a-f]{24})?):refs\/heads\//.exec(arg)?.[1]).find(Boolean);
      if (!head) throw Error('local_head_mismatch');
      await preflight(spec, { mission_id: mission.mission_id, revision: mission.revision, head, tree: mission.candidate_tree ?? '', spec_digest: mission.spec_digest }, opts.signal);
      return app.exec(command, args, opts);
    }, { gated: true as const });
    const runner: DeliveryCommandRunner = { gated: true, run: async (command, args, opts) => {
      if (options.bridge?.disabled) throw Error('BRIDGE_DISABLED');
      const transport = await appTransportConfig(hostRunner, opts.cwd, opts.signal);
      return appCredentialRunner(hostRunner, () => app.publisherToken(), credentialedExec, transport).run(command, args, opts);
    } };
    return {
      runner, preflight,
      localGit: async (cwd: string, args: readonly string[]) => {
        const allowed = (args.length === 3 && args[0] === 'rev-list' && args[1] === '--reverse' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\.\.(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(args[2]!))
          || (args.length === 4 && args[0] === 'merge-base' && args[1] === '--is-ancestor' && FULL_SHA.test(args[2]!) && FULL_SHA.test(args[3]!));
        if (!allowed) throw Error('revision_git_read_refused');
        const result = await git(cwd)([...args], { timeoutMs: 30_000, maxOutputBytes: 1_048_576, okExitCodes: [0, 1] });
        return { stdout: result.stdout.toString('utf8'), exitCode: result.exitCode };
      },
    };
  };
  const deliveryEvidenceFacts = (missionId: string): DeliveryEvidenceFacts | undefined => {
    const event = containedEvents(store, missionId).filter(e => e.kind === 'delivery_evidence').at(-1);
    if (!event) return undefined;
    const p = eventPayload(event) as Partial<DeliveryEvidenceFacts>;
    if (typeof p.head !== 'string' || typeof p.repository !== 'string' || typeof p.evidence_digest !== 'string' || !Array.isArray(p.verify?.argv) || typeof p.verify.exit_code !== 'number') return undefined;
    return { head: p.head, repository: p.repository, evidence_digest: p.evidence_digest, verify: { argv: p.verify.argv.map(String), exit_code: p.verify.exit_code } };
  };

  // Re-materialize `expectedHead`: every ref update and real-index write below is a journaled, fenced launch.
  const restore = async (input: { mission_id: string; fence: () => void; signal?: AbortSignal; worktree: string; branch: string; expectedHead: string }): Promise<void> => {
    assertSha(input.expectedHead);
    const current = await branchHead(input.worktree, input.branch);
    // A host commit the ledger never recorded is dropped from the branch (its objects stay in the repository).
    if (current !== input.expectedHead) {
      const ref = `refs/heads/${input.branch}`;
      await git(input.worktree)(['update-ref', '-m', 'osstack: discard unrecorded commit', ref, input.expectedHead, current],
        { ...signalOf(input), ...kit.hardened(input.mission_id, input.fence, 'git_update_ref', `${await gitDirOf(input.worktree)}#${ref}`) });
    }
    // Anything standing where a tracked file must go (a symlink, a directory, a hard link) is removed first, never followed.
    const tracked = nulList(await git(input.worktree)(['ls-tree', '-r', '-z', '--name-only', '--full-tree', input.expectedHead]));
    if (tracked.length > MAX_WORKTREE_FILES) throw Error('CONTAINED_WORKTREE_LIMIT');
    for (const path of tracked) await clearObstruction(input.worktree, path, true);
    // Every earlier writer of this worktree is proven stopped (one open record per Mission), and the claim is exclusive: a leftover
    // lock (a timed-out or aborted index writer) is stale and would fail the read-tree below.
    rmSync(join(await gitDirOf(input.worktree), 'index.lock'), { force: true });
    await materializeCommit(input.worktree, input.expectedHead, { git: withSignal(input), gate: kit.gate(input.mission_id, input.fence) });
    const config = await filterNeutralizingConfig(input.worktree, ctx);
    const others = nulList(await runHardenedGit(['ls-files', '--others', '-z'], { ...ctx, config, cwd: input.worktree }));
    if (others.length > MAX_WORKTREE_FILES) throw Error('CONTAINED_WORKTREE_LIMIT');
    for (const path of others) await clearObstruction(input.worktree, path, false);
  };
  const withSignal = (input: { signal?: AbortSignal }): HardenedGitContext => input.signal ? { ...ctx, signal: input.signal } : ctx;
  const signalOf = (input: { signal?: AbortSignal }): Partial<HardenedGitOptions> => input.signal ? { signal: input.signal } : {};
  const gitDirOf = async (worktree: string) => text(await git(worktree)(['rev-parse', '--absolute-git-dir']));

  const ports: ContainedMissionHostPorts = {
    store, now, hostProcesses: kit, revisionPublicationAdapters,
    installRevisionCheckAuthority: enabled => { revisionCheckEnabled = enabled; },
    revisionLaunchCaps: { executor_seconds: Math.ceil((options.codex.timeoutMs ?? 600_000) / 1000), verify_seconds: 120 },
    hasOpenHostProcess: missionId => kit.hasOpen(missionId),
    openHostProcessId: missionId => kit.openOpId(missionId),
    remoteWriteReleasedSince: (missionId, since) => kit.remoteReleasedSince(missionId, since),
    createWorkspace: (spec, signal, write) => kit.guard(write.mission_id, async () => {
      const context = { ...ctx, signal };
      const inspection = await inspectRepoConfig(spec.repo_path, context);
      if (inspection.rejections.length > 0) throw Error(`CONTAINED_REPO_CONFIG_REJECTED:${[...new Set(inspection.rejections.map(r => r.code))].join(',')}`);
      assertSha(spec.start_commit);
      try { await runHardenedGit(['cat-file', '-e', `${spec.start_commit}^{commit}`], { ...context, cwd: spec.repo_path }); }
      catch { throw Error('CONTAINED_START_COMMIT_MISSING'); }
      const worktree = resolve(spec.worktree_path);
      await createNoCheckoutWorktree({ repoPath: spec.repo_path, worktreePath: worktree, branch: spec.branch, startCommit: spec.start_commit, expectedConfigDigest: inspection.digest, git: context,
        gate: kit.gate(write.mission_id, write.fence) });
      const head = text(await runHardenedGit(['rev-parse', '--verify', 'HEAD'], { ...context, cwd: worktree }));
      return { worktree, gitDir: inspection.gitDir, head, configDigest: inspection.digest };
    }),
    resumeWorkspace: (spec, write) => kit.guard(write.mission_id, async () => {
      const worktree = resolve(spec.worktree_path);
      const inspection = await inspectRepoConfig(spec.repo_path, ctx);
      if (inspection.rejections.length > 0) throw Error(`CONTAINED_REPO_CONFIG_REJECTED:${[...new Set(inspection.rejections.map(r => r.code))].join(',')}`);
      assertSha(spec.start_commit);
      // The interrupted creation must have left exactly what a finished one has: a directory that git lists as a worktree of this repository,
      // checked out on the Mission branch, which still points at start_commit. Anything else is not resumable.
      const stat = await lstat(worktree).catch(() => undefined);
      if (!stat?.isDirectory() || stat.isSymbolicLink()) throw Error('CONTAINED_RESUME_WORKTREE_MISSING');
      const listed = text(await runHardenedGit(['worktree', 'list', '--porcelain'], { ...ctx, cwd: spec.repo_path })).split('\n')
        .flatMap(line => line.startsWith('worktree ') ? [line.slice('worktree '.length)] : []);
      const real = await realpath(worktree);
      if (!(await Promise.all(listed.map(p => realpath(p).catch(() => p)))).includes(real)) throw Error('CONTAINED_RESUME_NOT_A_WORKTREE');
      const run = git(worktree);
      if (text(await run(['symbolic-ref', '-q', 'HEAD'], { okExitCodes: [0, 1] })) !== `refs/heads/${spec.branch}`) throw Error('CONTAINED_RESUME_BRANCH_MISMATCH');
      if (text(await run(['rev-parse', '--verify', '-q', `refs/heads/${spec.branch}`], { okExitCodes: [0, 1] })) !== spec.start_commit) throw Error('CONTAINED_RESUME_HEAD_MISMATCH');
      await restore({ ...write, worktree, branch: spec.branch, expectedHead: spec.start_commit });
      return { worktree, gitDir: inspection.gitDir, head: text(await runHardenedGit(['rev-parse', '--verify', 'HEAD'], { ...ctx, cwd: worktree })), configDigest: inspection.digest };
    }),
    qualify: (worktree, gitDir) => executor(worktree).qualify(worktree, gitDir),
    publish: ({ mission, spec, permit, body, beforeRemoteMutation, signal }) => kit.guard(mission.mission_id, async () => {
      // A revision child updates its PR's own branch through the revision publisher (phase 5-C); this path opens PRs and must never serve it.
      if (spec.publish_target) throw Error('CONTAINED_PUBLISH_TARGET_REQUIRES_REVISION');
      const p = spec.publication; if (!p) throw Error('CONTAINED_PUBLICATION_NOT_CONFIGURED');
      // A configured bridge confines publication to its repository: never fall back to host credentials for another one.
      if (options.bridge !== undefined && options.bridge.config.repository.toLowerCase() !== p.repository.toLowerCase()) throw Error('CONTAINED_BRIDGE_REPOSITORY');
      // Kill switch (OSSTACK_BRIDGE=0): refuse before the kit, any token source, any git/gh call. Never falls back to host credentials.
      if (options.bridge?.disabled === true) throw Error('BRIDGE_DISABLED');
      // The repository config that made the workspace safe must still hold before anything leaves the machine.
      await assertRepoConfigUnchanged(spec.repo_path, recordedConfigDigest(spec.worktree_path), ctx);
      if (await branchHead(spec.worktree_path, spec.branch) !== permit.head) throw Error('CONTAINED_PUBLICATION_HEAD_MISMATCH');
      // Every URL git would push to (pushurl included) must be the granted repository, before anything is pushed.
      const pushUrls = text(await git(spec.worktree_path)(['remote', 'get-url', '--push', '--all', '--', p.remote])).split('\n').filter(Boolean);
      if (pushUrls.length === 0 || pushUrls.some(url => githubRepositoryOf(url)?.toLowerCase() !== p.repository.toLowerCase())) throw Error('CONTAINED_PUBLICATION_DESTINATION');
      // App mode: only the bridge repository, and only over plain https so the App token never meets an ssh or userinfo URL.
      const app = options.bridge !== undefined ? await bridgeKit() : undefined;
      if (app) {
        const httpsUrl = new RegExp(`^https://github\\.com/${p.repository.replace(/[.]/g, '\\.')}(?:\\.git)?/?$`, 'i');
        if (pushUrls.some(url => !httpsUrl.test(url.trim()))) throw Error('CONTAINED_BRIDGE_REQUIRES_HTTPS');
      }
      const bodyFile = join(runtimeDir(spec.worktree_path), `pr-body-${permit.revision}.md`);
      writeFileSync(bodyFile, body, { mode: 0o600 });
      // Host mode launches its writes through the gated launcher; a runner injected by a caller must declare `gated` and honour the gate.
      const hostRunner = options.delivery?.runner ?? gatedHostRunner(kit, options.delivery?.binaries);
      // App mode: a fixed, whitelisted transport config, read from the host config here, before any token is minted or process started.
      const transport = app ? await appTransportConfig(hostRunner, spec.worktree_path, signal) : [];
      // The credential runner sits inside the fence, so the fence still runs before every mutation.
      const { appCredentialRunner } = app ? await import('./contained-mission-bridge.js') : { appCredentialRunner: undefined };
      const inner = app && appCredentialRunner ? appCredentialRunner(hostRunner, () => app.publisherToken(), app.exec, transport) : hostRunner;
      const runner = fencedDeliveryRunner(inner, beforeRemoteMutation, { remote: p.remote, repository: p.repository, missionId: mission.mission_id, ...(app ? { httpsOnly: true } : {}) });
      // The title is published verbatim, so it is redacted like the body; control characters never reach gh.
      const title = redactSecrets(p.title ?? `Contained Mission ${mission.mission_id.slice(3, 11)}: ${spec.goal.replace(/\s+/g, ' ').slice(0, 72)}`)
        // biome-ignore lint/suspicious/noControlCharactersInRegex: titles must not carry control characters to gh.
        .replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
      const opened = await openPullRequestToGitHub({ workspacePath: spec.worktree_path, remote: p.remote, base: p.base, branch: spec.branch, title, bodyFile,
        mergeStrategy: 'squash', ciTimeoutMs: 60_000 }, { repository: p.repository, headCommit: permit.head, draft: p.draft,
        ...(app ? { missionRulesetIds: app.config.mission_ruleset_ids } : {}), signal }, runner);
      const listed = await runner.run('git', ['ls-remote', '--', p.remote, `refs/heads/${p.base}`], { cwd: spec.worktree_path, timeoutMs: 30_000, signal });
      const baseHead = listed.exitCode === 0 ? /^([0-9a-f]{40}|[0-9a-f]{64})\s/.exec(listed.stdout)?.[1] ?? null : null;
      return { pushed_commit: opened.pushedCommit, pr: opened.pr, base_head: baseHead, stop_proof_scope: app ? 'app_isolated' as const : 'host_credential_helpers_untrusted' as const };
    }),
    ...(options.bridge && options.bridge.disabled !== true ? { publishVerifyCheck: async (mission: ContainedMission) => (await bridgeKit()).publishVerifyCheck(mission, deliveryEvidenceFacts(mission.mission_id)) } : {}),
    execute: input => executor(input.worktree).run({ worktree: input.worktree, prompt: input.prompt, signal: input.signal, onLaunched: input.onLaunched }),
    readFile: async (worktree, path) => {
      try { return utf8((await safeReadFile(worktree, path)).bytes, 'CONTAINED_FILE_NOT_UTF8'); }
      catch (error) { if (error instanceof SafeFileError && error.code === 'SAFE_PATH_NOT_FOUND') return null; throw error; }
    },
    commit: input => kit.guard(input.mission_id, async () => {
      const expectedConfigDigest = recordedConfigDigest(input.worktree);
      const modes = await headModes(git(input.worktree), input.expectedHead, input.files.map(f => f.path));
      // Keep each file's committed mode; cumulativeDiff assumes the same, so what was classified is what is committed.
      const files = input.files.map(f => f.action === 'delete' ? f : { ...f, executable: modes.get(f.path) === '100755' });
      return commitPlumbing({ worktree: input.worktree, branch: input.branch, expectedHead: input.expectedHead, files, message: input.message, author, expectedConfigDigest, git: withSignal(input), fence: input.fence,
        gate: kit.gate(input.mission_id, input.fence) });
    }),
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
    restoreWorkspace: input => kit.guard(input.mission_id, () => restore(input)),
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
    commitWorktree: input => kit.guard(input.mission_id, async () => {
      assertSha(input.tree);
      const expectedConfigDigest = recordedConfigDigest(input.worktree);
      assertSha(input.expectedHead);
      const current = await branchHead(input.worktree, input.branch);
      const run = git(input.worktree);
      // Only the ledger head is trusted ancestry: an unrecorded commit's history was never classified, so it is dropped.
      if (current !== input.expectedHead) {
        const ref = `refs/heads/${input.branch}`;
        await run(['update-ref', '-m', 'osstack: drop unrecorded commit', ref, input.expectedHead, current],
          { ...signalOf(input), ...kit.hardened(input.mission_id, input.fence, 'git_update_ref', `${await gitDirOf(input.worktree)}#${ref}`) });
      }
      const head = input.expectedHead;
      const status = nulList(await run(['diff-tree', '-r', '-z', '--no-renames', '--name-status', head, input.tree]));
      const files: Array<{ path: string; action: 'write' } | { path: string; action: 'delete' }> = [];
      for (let i = 0; i + 1 < status.length; i += 2) files.push({ path: status[i + 1]!, action: status[i] === 'D' ? 'delete' : 'write' });
      if (files.length === 0) return { head, tree: text(await run(['rev-parse', '--verify', `${head}^{tree}`])) };
      const commit = await commitPlumbing({ worktree: input.worktree, branch: input.branch, expectedHead: head, files, message: input.message, author, expectedConfigDigest, git: withSignal(input), fence: input.fence,
        gate: kit.gate(input.mission_id, input.fence) });
      if (commit.tree !== input.tree) throw Error('CONTAINED_ADOPT_TREE_MISMATCH');
      return commit;
    }),
    verify: async (mission, argv, signal) => {
      const spec = parseContainedMissionSpec(mission.spec_json);
      const binding = missionVerificationBinding(mission, { argv }); const { command } = containedCommandFromArgv(argv);
      const invocationId = containedVerifyInvocationId(mission);
      // Start needs the Mission still verifying this candidate; stop and read stay allowed after a cancel.
      const fence = (start: boolean) => () => {
        store.attention.assertOwner(store.owner);
        const current = store.get(mission.mission_id);
        if (current.verify_attempts !== mission.verify_attempts || current.candidate_head !== mission.candidate_head || (start && current.state !== 'verifying')) throw Error('CONTAINED_VERIFY_FENCE');
        // A revision child's container starts only while its chain still wants the work; image preparation awaits between the charge and here.
        if (start && spec.publish_target) {
          if (!ports.revision) throw Error('CONTAINED_VERIFY_FENCE');
          ports.revision.assertActive(current, spec);
        }
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
