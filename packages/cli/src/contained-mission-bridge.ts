// Bridge-only effects for contained Missions (plan phase 3): App A credentials for the PR-only
// publication and the App B `osstack/verify` check run. Loaded lazily, only when a bridge is configured.
import { execFile } from 'node:child_process';
import { githubDeliveryEnvironment, type DeliveryCommandResult, type DeliveryCommandRunner, type DeliveryRunOptions, type DeliveryWriteGate } from '@osstack/github';
import type { ContainedMission } from '@osstack/core';
import { redactBridge } from './contained-mission-redact.js';
import {
  EVIDENCE_PERMISSIONS,
  PUBLISHER_PERMISSIONS,
  createInstallationTokenSource,
  type BridgeConfig,
  type InstallationTokenSource,
} from './contained-mission-github-app.js';

const PAGE_SIZE = 100;
const MAX_LOOKUP_PAGES = 10;
/** Total check-run page requests per lookup, across all suites (bounds a worst case of suites x pages). */
const MAX_RUN_PAGE_REQUESTS = PAGE_SIZE * MAX_LOOKUP_PAGES;

export type BridgeExec = ((
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv; signal?: AbortSignal; gate?: DeliveryWriteGate },
) => Promise<DeliveryCommandResult>) & {
  /** True only for a launcher that registers the process in the host-process ledger and honours `gate` (W13). */
  readonly gated?: true;
};
export interface BridgeOptions {
  config: BridgeConfig;
  /** Runs the two credentialed commands (git push, gh pr create); injectable for tests. */
  exec?: BridgeExec;
  fetchImpl?: typeof fetch;
  now?: () => number;
}
export interface DeliveryEvidenceFacts {
  head: string;
  repository: string;
  evidence_digest: string;
  verify: { argv: readonly string[]; exit_code: number };
}
export interface VerifyCheckResult {
  check_run_id: number;
  created: boolean;
}

export const CHECK_NAME = 'osstack/verify';
const API = 'https://api.github.com';
const PUSH_TOKEN_ENV = 'OSSTACK_BRIDGE_PUSH_TOKEN';
const PUSH_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${PUSH_TOKEN_ENV}"; }; f`;

export { redactBridge };

/** Ungated: the contained publication fence refuses a write through it. Kept for tooling that never publishes a Mission. */
export const defaultBridgeExec: BridgeExec = (command, args, options) =>
  new Promise((resolve, reject) => {
    if (options.gate !== undefined) return reject(new Error('CONTAINED_PUBLICATION_UNGATED'));
    execFile(
      command,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: options.env, ...(options.signal === undefined ? {} : { signal: options.signal }) },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, exitCode: 0 });
        if (options.signal?.aborted) return reject(new Error('CONTAINED_PUBLICATION_ABORTED'));
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
        const timedOut = failure.killed === true || failure.signal === 'SIGTERM' || failure.code === 'ETIMEDOUT';
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), exitCode: timedOut ? 124 : typeof failure.code === 'number' ? failure.code : 1 });
      },
    );
  });

/** Index of the git subcommand after any leading `-c key=value` pairs. */
function gitSubcommandIndex(args: readonly string[]): number {
  let i = 0;
  while (args[i] === '-c' && args[i + 1] !== undefined) i += 2;
  return i;
}

/** App mode never reads the user's git configuration for a credentialed command: no global or system file, no ssh agent. */
function isolate(env: NodeJS.ProcessEnv): void {
  env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  delete env['SSH_AUTH_SOCK'];
  delete env['XDG_CONFIG_HOME'];
}

/**
 * Only `git push` and `gh pr create` carry App A's token; every other command (all reads) goes to `inner` with the host's own
 * credentials. Place this INSIDE the publication fence. W13-C2: the two writes go to `exec` with the gate the fence attached, in an
 * isolated git configuration plus the fixed `transport` pairs (`-c` proxy/CA settings read from the host config at preflight, also
 * applied to `remote get-url` and `ls-remote` so the destination re-check and the push read the same transport).
 */
export function appCredentialRunner(
  inner: DeliveryCommandRunner,
  publisherToken: () => Promise<string>,
  exec: BridgeExec,
  transport: readonly string[] = [],
): DeliveryCommandRunner {
  const credentialed = async (
    command: string,
    args: readonly string[],
    options: DeliveryRunOptions,
    env: NodeJS.ProcessEnv,
  ): Promise<DeliveryCommandResult> => {
    try {
      const done = await exec(command, args, {
        cwd: options.cwd, timeoutMs: options.timeoutMs, env,
        ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.gate === undefined ? {} : { gate: options.gate }),
      });
      return { stdout: redactBridge(done.stdout), stderr: redactBridge(done.stderr), exitCode: done.exitCode, ...(done.opId === undefined ? {} : { opId: done.opId }) };
    } catch (error) {
      if (error instanceof Error && error.name === 'HostProcessUnprovenError') throw error;
      const failure = new Error(redactBridge(error instanceof Error ? error.message : String(error)));
      throw failure;
    }
  };
  const withTransport = (args: readonly string[]): string[] => {
    const at = gitSubcommandIndex(args);
    return [...args.slice(0, at), ...transport, ...args.slice(at)];
  };
  return {
    ...(exec.gated === true ? { gated: true as const } : {}),
    async run(command, args, options) {
      if (command === 'git') {
        const at = gitSubcommandIndex(args);
        if (args[at] === 'push') {
          const token = await publisherToken();
          const env = githubDeliveryEnvironment();
          delete env['GH_TOKEN'];
          delete env['GITHUB_TOKEN'];
          isolate(env);
          env[PUSH_TOKEN_ENV] = token;
          // Clear both the generic list and the github.com-specific one (`gh auth setup-git` writes the latter).
          return credentialed('git', ['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=', '-c', `credential.helper=${PUSH_HELPER}`, ...transport, ...args], options, env);
        }
        if (args[at] === 'remote' || args[at] === 'ls-remote') return inner.run(command, withTransport(args), options);
      } else if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        const token = await publisherToken();
        const env = githubDeliveryEnvironment();
        for (const key of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
        isolate(env);
        env['GH_TOKEN'] = token;
        env['GH_HOST'] = 'github.com';
        return credentialed('gh', args, options, env);
      }
      return inner.run(command, args, options);
    },
  };
}

interface CheckRun {
  id: number;
  head_sha?: string;
  external_id?: string | null;
  app?: { id?: number } | null;
}
interface CheckSuite {
  id: number;
  head_sha?: string;
  app?: { id?: number } | null;
}
const flat = (text: string, max: number): string =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: check summaries must not carry control characters.
  redactBridge(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, ' ').slice(0, max);

export interface BridgeKit {
  readonly config: BridgeConfig;
  readonly exec: BridgeExec;
  publisherToken(): Promise<string>;
  publishVerifyCheck(mission: ContainedMission, evidence: DeliveryEvidenceFacts | undefined): Promise<VerifyCheckResult>;
}

/** Token sources are created once per kit and cache their tokens. */
export function createBridgeKit(options: BridgeOptions): BridgeKit {
  const { config } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const deps = { fetchImpl, ...(options.now ? { now: options.now } : {}) };
  const publisher: InstallationTokenSource = createInstallationTokenSource(config.publisher, { repository: config.repository, permissions: PUBLISHER_PERMISSIONS }, deps);
  const evidence: InstallationTokenSource = createInstallationTokenSource(config.evidence, { repository: config.repository, permissions: EVIDENCE_PERMISSIONS }, deps);

  async function api(method: 'GET' | 'POST' | 'PATCH', path: string, body?: unknown): Promise<unknown> {
    const token = await evidence.token();
    let response: Response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'user-agent': 'osstack-bridge',
          'x-github-api-version': '2022-11-28',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new Error('CONTAINED_VERIFY_CHECK_NETWORK');
    }
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) throw new Error(redactBridge(`CONTAINED_VERIFY_CHECK_HTTP:${response.status}`));
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      throw new Error('CONTAINED_VERIFY_CHECK_MALFORMED');
    }
  }

  async function publishVerifyCheck(mission: ContainedMission, facts: DeliveryEvidenceFacts | undefined): Promise<VerifyCheckResult> {
    if (mission.state !== 'pr_opened') throw new Error('CONTAINED_VERIFY_CHECK_STATE');
    if (!facts) throw new Error('CONTAINED_VERIFY_CHECK_EVIDENCE');
    const head = mission.candidate_head;
    if (!head || facts.head !== head) throw new Error('CONTAINED_VERIFY_CHECK_HEAD');
    if (facts.repository.toLowerCase() !== config.repository.toLowerCase()) throw new Error('CONTAINED_VERIFY_CHECK_REPOSITORY');
    if (facts.verify.exit_code !== 0) throw new Error('CONTAINED_VERIFY_CHECK_EVIDENCE');
    const key = `${mission.mission_id}:${head}`;
    const repo = config.repository;
    const output = {
      title: 'OSStack verification passed',
      summary: flat([
        `Mission: ${mission.mission_id}`, `Candidate head: ${head}`,
        `Verification: ${facts.verify.argv.join(' ')} (exit code ${facts.verify.exit_code})`,
        `Delivery evidence digest: ${facts.evidence_digest}`, '',
        "The OSStack ledger's `delivery_evidence` event is authoritative; this check run is a display copy.",
      ].join('\n'), 4000),
    };
    const success = { status: 'completed', conclusion: 'success', output };
    // GET /commits/{ref}/check-runs only covers a ref's 1,000 most recent check suites, so an existing check could
    // be missed (and duplicated). Walk this App's suites for the head, then each suite's runs, both paged and capped.
    const pageAll = async <T>(path: string, query: string, pick: (body: unknown) => T[], spend: () => void = () => {}): Promise<T[]> => {
      const out: T[] = [];
      for (let page = 1; ; page++) {
        // More than MAX_LOOKUP_PAGES full pages is not safe to deduplicate against.
        if (page > MAX_LOOKUP_PAGES) throw new Error('CONTAINED_VERIFY_CHECK_LIMIT');
        spend();
        const items = pick(await api('GET', `${path}?${query}&per_page=${PAGE_SIZE}&page=${page}`));
        out.push(...items);
        if (items.length < PAGE_SIZE) break;
      }
      return out;
    };
    const lookup = async (): Promise<number[]> => {
      let runRequests = 0;
      const spendRunRequest = (): void => {
        if (++runRequests > MAX_RUN_PAGE_REQUESTS) throw new Error('CONTAINED_VERIFY_CHECK_LIMIT');
      };
      const suites = await pageAll<CheckSuite>(`/repos/${repo}/commits/${head}/check-suites`, `app_id=${config.evidence.app_id}`,
        (body) => (body as { check_suites?: CheckSuite[] } | null)?.check_suites ?? []);
      // Another App's suite never counts.
      const suiteIds = [...new Set(suites
        .filter((suite) => suite.app?.id === config.evidence.app_id && suite.head_sha === head && Number.isInteger(suite.id))
        .map((suite) => suite.id))];
      const found = new Set<number>();
      for (const suiteId of suiteIds) {
        const runs = await pageAll<CheckRun>(`/repos/${repo}/check-suites/${suiteId}/check-runs`, `check_name=${encodeURIComponent(CHECK_NAME)}&filter=all`,
          (body) => (body as { check_runs?: CheckRun[] } | null)?.check_runs ?? [], spendRunRequest);
        for (const run of runs) {
          // Another App's same-named check never counts.
          if (run.app?.id === config.evidence.app_id && run.external_id === key && run.head_sha === head && Number.isInteger(run.id)) found.add(run.id);
        }
      }
      return [...found].sort((a, b) => a - b);
    };

    let ids = await lookup();
    let created = false;
    if (ids.length === 0) {
      const made = (await api('POST', `/repos/${repo}/check-runs`, { name: CHECK_NAME, head_sha: head, external_id: key, ...success })) as { id?: number } | null;
      created = true;
      ids = await lookup();
      if (typeof made?.id === 'number' && !ids.includes(made.id)) ids = [...ids, made.id].sort((a, b) => a - b);
    }
    const keep = ids[0];
    if (keep === undefined) throw new Error('CONTAINED_VERIFY_CHECK_MALFORMED');
    if (!created) await api('PATCH', `/repos/${repo}/check-runs/${keep}`, success);
    for (const id of ids.slice(1)) {
      await api('PATCH', `/repos/${repo}/check-runs/${id}`, {
        status: 'completed', conclusion: 'neutral',
        output: { title: 'Duplicate of an OSStack verification check', summary: `Duplicate of check run ${keep} for ${key}; check run ${keep} is the one that counts.` },
      });
    }
    return { check_run_id: keep, created };
  }

  return {
    config,
    exec: options.exec ?? defaultBridgeExec,
    publisherToken: () => publisher.token(),
    publishVerifyCheck,
  };
}
