// Bridge-only effects for contained Missions (plan phase 3): App A credentials for the PR-only
// publication and the App B `osstack/verify` check run. Loaded lazily, only when a bridge is configured.
import { execFile } from 'node:child_process';
import { githubDeliveryEnvironment, type DeliveryCommandResult, type DeliveryCommandRunner } from '@osstack/github';
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

export type BridgeExec = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<DeliveryCommandResult>;
export interface BridgeOptions {
  config: BridgeConfig;
  /** `OSSTACK_BRIDGE=0` kill switch: publication for the configured repository is refused (BRIDGE_DISABLED) before any token, push or check. */
  disabled?: boolean;
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

export const defaultBridgeExec: BridgeExec = (command, args, options) =>
  new Promise((resolve) => {
    execFile(
      command,
      [...args],
      { cwd: options.cwd, timeout: options.timeoutMs, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: options.env },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr, exitCode: 0 });
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

/**
 * Only `git push` and `gh pr create` carry App A's token; every other command (all reads) goes to `inner`
 * with the host's own credentials. Place this INSIDE the publication fence.
 */
export function appCredentialRunner(
  inner: DeliveryCommandRunner,
  publisherToken: () => Promise<string>,
  exec: BridgeExec,
): DeliveryCommandRunner {
  const credentialed = async (
    command: string,
    args: readonly string[],
    options: { cwd: string; timeoutMs: number },
    env: NodeJS.ProcessEnv,
  ): Promise<DeliveryCommandResult> => {
    try {
      const done = await exec(command, args, { ...options, env });
      return { stdout: redactBridge(done.stdout), stderr: redactBridge(done.stderr), exitCode: done.exitCode };
    } catch (error) {
      throw new Error(redactBridge(error instanceof Error ? error.message : String(error)));
    }
  };
  return {
    async run(command, args, options) {
      if (command === 'git') {
        const at = gitSubcommandIndex(args);
        if (args[at] === 'push') {
          const token = await publisherToken();
          const env = githubDeliveryEnvironment();
          delete env['GH_TOKEN'];
          delete env['GITHUB_TOKEN'];
          env[PUSH_TOKEN_ENV] = token;
          // Clear both the generic list and the github.com-specific one (`gh auth setup-git` writes the latter).
          return credentialed('git', ['-c', 'credential.helper=', '-c', 'credential.https://github.com.helper=', '-c', `credential.helper=${PUSH_HELPER}`, ...args], options, env);
        }
      } else if (command === 'gh' && args[0] === 'pr' && args[1] === 'create') {
        const token = await publisherToken();
        const env = githubDeliveryEnvironment();
        for (const key of ['GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete env[key];
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
