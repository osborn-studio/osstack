import { z } from 'zod';
import { defaultGhExec, type GhExec } from './contained-mission-bridge-reader.js';
import { computeFollowupStats, FOLLOWUP_RULE, hasHotfixSubject, type FollowupReadPort, type LaterCommit, type MergedChain } from './contained-mission-ci-chain-followup.js';

const ref = '([A-Za-z0-9_.-]+(?:%2F[A-Za-z0-9_.-]+)*)';
const sha = '[0-9a-f]{40}';
const iso = '[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z';
const page = 'per_page=100&page=[1-9][0-9]*';
const allowedSuffixes = [
  /^$/,
  new RegExp(`^/compare/${ref}\\.\\.\\.${sha}$`),
  new RegExp(`^/commits/${sha}\\?${page}$`),
  new RegExp(`^/commits\\?sha=${ref}&since=${iso}&until=${iso}&${page}$`),
];
const dotSegment = (segment: string) => segment === '.' || segment === '..';

export class FollowupReadDenied extends Error {}

export function assertFollowupPathAllowed(path: string, repository: string): void {
  const base = `repos/${repository}`;
  if (path.length <= 512 && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)
    && !repository.split('/').some(dotSegment) && path.startsWith(base)) {
    const suffix = path.slice(base.length);
    for (const pattern of allowedSuffixes) {
      const match = pattern.exec(suffix);
      if (match && !match[1]?.split('%2F').some(dotSegment)) return;
    }
  }
  throw new FollowupReadDenied('Follow-up GET path denied');
}

const shaSchema = z.string().regex(new RegExp(`^${sha}$`));
const committer = z.object({ date: z.string().datetime({ offset: true }).transform(value => Date.parse(value)).pipe(z.number().finite()) });
const filePage = z.object({ commit: z.object({ committer }), files: z.array(z.object({
  filename: z.string().min(1), previous_filename: z.string().min(1).optional(),
})).max(100) });
const commitPage = z.array(z.object({ sha: shaSchema, commit: z.object({ committer, message: z.string() }) })).max(100);
const branchResponse = z.object({ default_branch: z.string().min(1) });
const ancestor = z.object({ status: z.enum(['behind', 'identical']) });

type Get = (path: string, signal: AbortSignal) => Promise<unknown>;
interface Options {
  get?: Get;
  exec?: GhExec;
  limits?: { maxRequests?: number; maxCommitPages?: number; maxFilePages?: number };
}

export function createFollowupReadPort({ get, exec = defaultGhExec, limits = {} }: Options = {}): FollowupReadPort {
  const { maxRequests = 200, maxCommitPages = 10, maxFilePages = 30 } = limits;
  const branches = new Map<string, string>();
  let used = 0;

  async function read(repository: string, suffix: string, signal: AbortSignal): Promise<unknown> {
    const path = `repos/${repository}${suffix}`;
    assertFollowupPathAllowed(path, repository);
    signal.throwIfAborted();
    if (used >= maxRequests) throw Error('request limit');
    used++;
    if (get) return get(path, signal);
    const result = await exec(['api', '--hostname', 'github.com', '--method', 'GET', path], { timeoutMs: 15_000, signal });
    if (result.exitCode !== 0) throw Error('GET failed');
    return JSON.parse(result.stdout);
  }

  async function defaultBranch(repository: string, signal: AbortSignal) {
    const cached = branches.get(repository);
    if (cached !== undefined) return cached;
    const body = branchResponse.parse(await read(repository, '', signal));
    const branch = encodeURIComponent(body.default_branch);
    branches.set(repository, branch);
    return branch;
  }

  async function readFiles(repository: string, commitSha: string, signal: AbortSignal) {
    const files = new Set<string>();
    for (let n = 1; n <= maxFilePages; n++) {
      const body = filePage.parse(await read(repository, `/commits/${commitSha}?per_page=100&page=${n}`, signal));
      for (const file of body.files) {
        files.add(file.filename);
        if (file.previous_filename) files.add(file.previous_filename);
      }
      if (body.files.length < 100) return { files: [...files], merge_committed_at_ms: body.commit.committer.date };
    }
    throw Error('file page limit');
  }

  return {
    async mergedFiles({ repository, merge_commit_sha }, signal) {
      try {
        shaSchema.parse(merge_commit_sha);
        const branch = await defaultBranch(repository, signal);
        ancestor.parse(await read(repository, `/compare/${branch}...${merge_commit_sha}`, signal));
        return await readFiles(repository, merge_commit_sha, signal);
      } catch { return null; }
    },
    async laterCommits(chain, sinceMs, untilMs, signal) {
      try {
        const branch = await defaultBranch(chain.repository, signal);
        const since = new Date(Math.floor(sinceMs / 1000) * 1000).toISOString().replace('.000Z', 'Z');
        const until = new Date(Math.ceil(untilMs / 1000) * 1000).toISOString().replace('.000Z', 'Z');
        const commits: LaterCommit[] = [];
        for (let n = 1; n <= maxCommitPages; n++) {
          const suffix = `/commits?sha=${branch}&since=${since}&until=${until}&per_page=100&page=${n}`;
          const batch = commitPage.parse(await read(chain.repository, suffix, signal));
          for (const { sha, commit } of batch) {
            const time = commit.committer.date;
            if (sha === chain.merge_commit_sha || time <= sinceMs || time > untilMs) continue;
            const files = hasHotfixSubject(commit.message) ? (await readFiles(chain.repository, sha, signal)).files : [];
            commits.push({ sha, message: commit.message, committed_at_ms: time, files });
          }
          if (batch.length < 100) return commits;
        }
        return null;
      } catch { return null; }
    },
  };
}

export async function measureCiChainFollowup(merged: readonly MergedChain[], port: FollowupReadPort, nowMs: number, signal: AbortSignal) {
  const stats = await computeFollowupStats(merged, port, nowMs, signal);
  if (stats.unknown) return { ...stats, measured: false as const, reason: 'incomplete_read', rate: null };
  return { ...stats, measured: true as const, rule: FOLLOWUP_RULE };
}
