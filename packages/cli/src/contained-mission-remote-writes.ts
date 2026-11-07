// W13-C2: the Mission side of remote writes. `git push` and `gh pr create` are launched through the same gated launcher as the local
// writes (docs/design/2026-11-06-w13-host-git-survival.md sections 4.2, 4.3, 5.4): registered in the ledger first, released only after
// the publication fence passes inside the release transaction, proven stopped before the call returns. Nothing here pushes on its own;
// the publication fence (`fencedDeliveryRunner`) decides which command may be a write and hands this module the gate.
import { HostProcessError, HostProcessUnprovenError, argvDigest, parseGitConfigList, runGatedProcess, type RepoConfigEntry } from '@osstack/agents';
import { githubDeliveryEnvironment, type DeliveryCommandResult, type DeliveryCommandRunner, type DeliveryRunOptions, type DeliveryWriteGate } from '@osstack/github';
import type { HostProcessKit } from './contained-mission-host-process.js';

export const REMOTE_WRITE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** A gated write's launcher, same shape as the bridge's `BridgeExec` (the App A credentials arrive in `env`). */
export interface GatedExecOptions { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal; gate?: DeliveryWriteGate }
export type GatedExec = ((command: string, args: readonly string[], options: GatedExecOptions) => Promise<DeliveryCommandResult>) & { readonly gated: true };

/** Test seam: absolute paths for the two binaries (default: `git` and `gh` from PATH). */
export interface RemoteWriteBinaries { git?: string; gh?: string }

/** `<owner>/<repo>#refs/heads/<branch>`, repository lower-cased (one open ledger record per remote branch, across Missions). */
export function remoteTargetOf(repository: string, branch: string): string {
  return `${repository.toLowerCase()}#refs/heads/${branch}`;
}

/** The remote branch a covered write targets: the destination of a `<sha>:refs/heads/<branch>` refspec, or gh's `--head`. */
export function remoteBranchOf(command: 'git' | 'gh', args: readonly string[]): string | undefined {
  if (command === 'gh') {
    const at = args.indexOf('--head');
    return at >= 0 ? args[at + 1] : undefined;
  }
  let found: string | undefined;
  for (const arg of args) {
    const match = /^[0-9a-f]{40}(?:[0-9a-f]{24})?:refs\/heads\/(.+)$/.exec(arg);
    if (match) { if (found !== undefined) return undefined; found = match[1]!; }
  }
  return found;
}

const assertKind = (command: string, gate: DeliveryWriteGate) => { if (gate.kind !== (command === 'git' ? 'git_push' : command === 'gh' ? 'gh_pr_create' : undefined)) throw Error('CONTAINED_PUBLICATION_GATE_MISMATCH'); };
const abortedError = () => Error('CONTAINED_PUBLICATION_ABORTED');

/**
 * Launches one remote write through the gated launcher. Failure modes, all before or after a bounded process:
 * - the fence (or the ledger) refuses before release: nothing ran, the row is `stopped(never_released)`;
 * - a second open record for the same remote branch: `CONTAINED_REMOTE_BRANCH_BUSY`, nothing ran;
 * - the process could not be proven stopped: `HostProcessUnprovenError`, the row stays open (the caller stops the Mission);
 * - aborted: `CONTAINED_PUBLICATION_ABORTED` after the process group was killed and its stop proven.
 */
async function launch(kit: HostProcessKit, command: string, args: readonly string[], options: GatedExecOptions & { gate: DeliveryWriteGate }): Promise<DeliveryCommandResult> {
  const { gate } = options;
  
  let result: Awaited<ReturnType<typeof runGatedProcess>>;
  try {
    result = await runGatedProcess(command, args, {
      cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs, maxOutputBytes: REMOTE_WRITE_MAX_OUTPUT_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      journal: kit.hp, markerDir: kit.markerDir, probe: kit.probe, fence: gate.fence,
      launch: { mission_id: gate.missionId, kind: gate.kind, remote_target: gate.remoteTarget, local_target: gate.localTarget.slice(0, 1024),
        ...(gate.intentId === undefined ? {} : { intent_id: gate.intentId }), argv_digest: argvDigest(command, args), boot_id: kit.bootId() },
    });
  } catch (error) {
    if (error instanceof HostProcessError && error.code === 'HOST_PROCESS_ABORTED') throw abortedError();
    if (error instanceof Error && error.message === 'host_process_remote_busy') throw Error('CONTAINED_REMOTE_BRANCH_BUSY');
    throw error;
  }
  if (result.proof === null) throw new HostProcessUnprovenError(result.op_id, result.released);
  if (result.terminated === 'abort') throw abortedError();
  if (result.terminated === 'output_limit') throw Error('CONTAINED_PUBLICATION_OUTPUT_LIMIT');
  return { stdout: result.stdout.toString('utf8'), stderr: result.stderr, exitCode: result.terminated === 'timeout' ? 124 : result.exitCode ?? 1, opId: result.op_id };
}

/** Ungated commands (reads) run as plain bounded processes; only a command carrying a gate is a ledgered write. */
async function plain(command: string, args: readonly string[], options: GatedExecOptions): Promise<DeliveryCommandResult> {
  if (options.signal?.aborted) throw abortedError();
  const { execFile } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { cwd: options.cwd, timeout: options.timeoutMs, encoding: 'utf8', maxBuffer: REMOTE_WRITE_MAX_OUTPUT_BYTES, env: options.env, ...(options.signal === undefined ? {} : { signal: options.signal }) },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, exitCode: 0 });
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        if (options.signal?.aborted || failure.name === 'AbortError' || failure.code === 'ABORT_ERR') return reject(abortedError());
        const timedOut = failure.killed === true || failure.signal === 'SIGTERM' || failure.code === 'ETIMEDOUT';
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: timedOut ? 124 : typeof failure.code === 'number' ? failure.code : 1 });
      });
  });
}

/** The process launcher App mode hands the credentialed `git push` and `gh pr create` to. A write without a gate is refused. */
export function gatedBridgeExec(kit: HostProcessKit, binaries: RemoteWriteBinaries = {}): GatedExec {
  const exec = async (command: string, args: readonly string[], options: GatedExecOptions): Promise<DeliveryCommandResult> => {
    if (options.gate === undefined) throw Error('CONTAINED_PUBLICATION_UNGATED');
    assertKind(command, options.gate);
    const program = command === 'git' ? binaries.git ?? 'git' : command === 'gh' ? binaries.gh ?? 'gh' : command;
    return launch(kit, program, args, { ...options, gate: options.gate });
  };
  return Object.assign(exec, { gated: true as const });
}

/**
 * Host credential mode: the host's own git and gh credentials, run through the launcher for writes and plainly for reads. The
 * environment is `githubDeliveryEnvironment()`; the global and system git configuration (credential helpers, ssh) stay in effect, so
 * the stop proof only covers what stays in the process group (`host_credential_helpers_untrusted`, design section 5.4).
 */
export function gatedHostRunner(kit: HostProcessKit, binaries: RemoteWriteBinaries = {}): DeliveryCommandRunner {
  return {
    gated: true,
    async run(command: string, args: readonly string[], options: DeliveryRunOptions): Promise<DeliveryCommandResult> {
      const program = command === 'git' ? binaries.git ?? 'git' : command === 'gh' ? binaries.gh ?? 'gh' : command;
      const base: GatedExecOptions = { cwd: options.cwd, timeoutMs: options.timeoutMs, env: githubDeliveryEnvironment(), ...(options.signal === undefined ? {} : { signal: options.signal }) };
      if (options.gate === undefined) return plain(program, args, base);
      assertKind(command, options.gate);
      return launch(kit, program, args, { ...base, gate: options.gate });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// App mode: the fixed, whitelisted transport configuration (design section 5.4, round-2 audit fix)
// ---------------------------------------------------------------------------------------------

export const TRANSPORT_UNSUPPORTED = 'CONTAINED_BRIDGE_TRANSPORT_UNSUPPORTED';
/** Variables whose host value App mode carries over, as `-c` pairs, to `push`, `remote get-url --push` and `ls-remote`. */
const TRANSPORT_VARIABLES = new Set(['proxy', 'sslcainfo', 'sslcapath']);
/** http.* settings that change no trust or routing decision; every other http.* setting is dropped in App mode and so refuses publication. */
const HTTP_BENIGN = new Set(['postbuffer', 'version', 'lowspeedlimit', 'lowspeedtime', 'maxrequests', 'minsessions', 'noepsv', 'useragent']);
const GITHUB_SCOPES = new Set(['https://github.com', 'https://github.com/']);

export class TransportUnsupportedError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`${TRANSPORT_UNSUPPORTED}: ${reasons.join(',')}`);
    this.name = 'TransportUnsupportedError';
  }
}

/** A URL pattern from `http.<url>.<var>` that could apply to github.com (a wildcard, any path on it, or one we cannot read). */
function scopeAppliesToGithub(pattern: string): boolean {
  if (pattern.includes('*')) return true;
  try { return new URL(pattern).hostname.toLowerCase() === 'github.com'; } catch { return true; }
}

/**
 * Reads the host configuration (every scope, includes expanded) and returns the `-c key=value` pairs App mode pins, or throws
 * `TransportUnsupportedError`. Anything that would redirect or decorate a github.com request but is dropped by
 * `GIT_CONFIG_GLOBAL=/dev/null` (`url.*.insteadOf`, `pushInsteadOf`, `http.*.extraHeader`, `core.sshCommand`, `core.gitProxy`,
 * scoped transport overrides on github.com other than the exact `https://github.com/`) refuses publication outright: the push URL
 * re-check and the push would otherwise read different configurations.
 */
export function transportConfigOf(entries: readonly RepoConfigEntry[]): string[] {
  const pinned = new Map<string, string>();
  const unsupported = new Set<string>();
  for (const { key, value } of entries) {
    const lower = key.toLowerCase();
    if (/^url\..+\.(?:insteadof|pushinsteadof)$/.test(lower)) { unsupported.add('url_rewrite'); continue; }
    if (lower === 'core.sshcommand') { unsupported.add('ssh_command'); continue; }
    if (lower === 'core.gitproxy') { unsupported.add('git_proxy'); continue; }
    if (/^remote\..+\.(?:proxy|proxyauthmethod)$/.test(lower)) { unsupported.add('remote_proxy'); continue; }
    const http = /^(https?)\.(.*)\.([^.]+)$/.exec(key) ?? /^(https?)\.([^.]+)$/.exec(key);
    if (!http) continue;
    const scope = http.length === 4 ? http[2]! : undefined;
    const variable = (http.length === 4 ? http[3]! : http[2]!).toLowerCase();
    const section = http[1]!.toLowerCase();
    if (variable === 'extraheader') {
      if (scope === undefined || scopeAppliesToGithub(scope)) unsupported.add('extra_header');
      continue;
    }
    if (!TRANSPORT_VARIABLES.has(variable)) {
      // Dropped by GIT_CONFIG_GLOBAL=/dev/null, so the push would not see it while the reads still do: refuse unless it changes nothing that matters.
      if (!HTTP_BENIGN.has(variable) && (scope === undefined || scopeAppliesToGithub(scope))) unsupported.add('transport_setting');
      continue;
    }
    if (scope !== undefined && !GITHUB_SCOPES.has(scope)) {
      if (scopeAppliesToGithub(scope)) unsupported.add('scoped_transport');
      continue;
    }
    // A proxy with credentials (with or without a scheme) would put them in argv, where any same-user `ps` shows them.
    if (variable === 'proxy' && value !== null && value.includes('@')) { unsupported.add('proxy_credentials'); continue; }
    if (value === null || /[\n\0]/.test(value)) { unsupported.add('transport_value'); continue; }
    const name = scope === undefined ? `${section}.${variable}` : `${section}.${scope}.${variable}`;
    pinned.set(name, value);
  }
  if (unsupported.size > 0) throw new TransportUnsupportedError([...unsupported].sort());
  return [...pinned.entries()].flatMap(([name, value]) => ['-c', `${name}=${value}`]);
}

/** Reads the host configuration through the host (read) runner and derives App mode's pinned transport pairs. */
export async function appTransportConfig(runner: Pick<DeliveryCommandRunner, 'run'>, cwd: string, signal?: AbortSignal): Promise<string[]> {
  const listed = await runner.run('git', ['config', '--list', '-z', '--show-scope', '--show-origin'], { cwd, timeoutMs: 30_000, ...(signal === undefined ? {} : { signal }) });
  if (listed.exitCode !== 0) throw new TransportUnsupportedError(['config_unreadable']);
  try { return transportConfigOf(parseGitConfigList(listed.stdout)); }
  catch (error) { if (error instanceof TransportUnsupportedError) throw error; throw new TransportUnsupportedError(['config_unparseable']); }
}
