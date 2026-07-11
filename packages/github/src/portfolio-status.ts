// Read-only GitHub portfolio status adapter. Per registered repo with a GitHub
// remote, fetch open PRs, recent CI runs, and the latest release via the `gh`
// CLI — using the same injectable-runner pattern as stack.ts (`runner.run(...)`)
// so tests are offline fixtures with NO real `gh`/`git` calls.
//
// Degrade, never throw: a missing `gh` binary, a repo with no GitHub remote, or
// any command/network failure collapses to a per-repo `warning` string with
// empty result arrays. The daily brief surfaces the warning instead of failing.

import { z } from "zod";
import { defaultCommandRunner, type CommandRunner } from "./branch-scanner.js";

export interface RepoGithubStatusInput {
  repo_id: string;
  /** Absolute path to the local clone (used to resolve its `origin` remote). */
  path: string;
}

export interface PullRequestSummary {
  number: number;
  title: string;
  state: string;
  head: string;
  isDraft: boolean;
  url: string;
}

export interface CiRunSummary {
  databaseId: number;
  workflowName: string;
  status: string;
  conclusion: string | null;
  headBranch: string;
  event: string;
  createdAt: string;
  url: string;
}

export interface ReleaseSummary {
  tagName: string;
  name: string;
  publishedAt: string;
  url: string;
}

export interface RepoGithubStatus {
  repo_id: string;
  /** `owner/repo` slug when a GitHub remote resolved; omitted when degraded. */
  remote?: string;
  pull_requests: PullRequestSummary[];
  ci_runs: CiRunSummary[];
  latest_release?: ReleaseSummary;
  /** Present only when this repo degraded; result arrays are empty then. */
  warning?: string;
}

export interface PortfolioGithubStatusOptions {
  /** How many CI runs to request per repo (`gh run list --limit`). Default 10. */
  runLimit?: number;
  /** How many open PRs to request per repo (`gh pr list --limit`). Default 20. */
  prLimit?: number;
}

const PrListJson = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    state: z.string(),
    headRefName: z.string(),
    isDraft: z.boolean(),
    url: z.string(),
  }),
);

const RunListJson = z.array(
  z.object({
    databaseId: z.number().int(),
    workflowName: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    headBranch: z.string(),
    event: z.string(),
    createdAt: z.string(),
    url: z.string(),
  }),
);

// `gh release list --json` emits an array; empty when the repo has no releases.
const ReleaseListJson = z.array(
  z.object({
    tagName: z.string(),
    name: z.string(),
    publishedAt: z.string(),
  }),
);

/**
 * Parse a git remote URL into an `owner/repo` slug, or `undefined` when it is
 * not a github.com remote. Handles https, ssh (`git@`), and `ssh://` forms with
 * an optional trailing `.git`.
 */
export function parseGithubSlug(remoteUrl: string): string | undefined {
  const trimmed = remoteUrl.trim();
  if (trimmed === "") return undefined;
  const withoutGit = trimmed.replace(/\.git$/, "");
  // git@github.com:owner/repo  |  ssh://git@github.com/owner/repo  |  https://github.com/owner/repo
  const match = /github\.com[/:]([^/]+)\/([^/]+?)\/?$/.exec(withoutGit);
  if (!match) return undefined;
  return `${match[1]}/${match[2]}`;
}

async function resolveRemoteSlug(
  path: string,
  runner: CommandRunner,
): Promise<string | undefined> {
  const stdout = await runner.run("git", ["-C", path, "remote", "get-url", "origin"]);
  return parseGithubSlug(stdout);
}

/** Fetch the read-only GitHub status for a single repo. Never throws. */
export async function fetchRepoGithubStatus(
  input: RepoGithubStatusInput,
  runner: CommandRunner = defaultCommandRunner,
  options: PortfolioGithubStatusOptions = {},
): Promise<RepoGithubStatus> {
  const prLimit = options.prLimit ?? 20;
  const runLimit = options.runLimit ?? 10;

  const degraded = (warning: string): RepoGithubStatus => ({
    repo_id: input.repo_id,
    pull_requests: [],
    ci_runs: [],
    warning,
  });

  let slug: string | undefined;
  try {
    slug = await resolveRemoteSlug(input.path, runner);
  } catch (err) {
    return degraded(`could not read git remote: ${errMessage(err)}`);
  }
  if (slug === undefined) {
    return degraded("no GitHub remote (origin is not a github.com URL)");
  }

  try {
    const [prs, runs, release] = await Promise.all([
      fetchPullRequests(slug, prLimit, runner),
      fetchCiRuns(slug, runLimit, runner),
      fetchLatestRelease(slug, runner),
    ]);
    return {
      repo_id: input.repo_id,
      remote: slug,
      pull_requests: prs,
      ci_runs: runs,
      ...(release !== undefined ? { latest_release: release } : {}),
    };
  } catch (err) {
    return {
      repo_id: input.repo_id,
      remote: slug,
      pull_requests: [],
      ci_runs: [],
      warning: `gh query failed for ${slug}: ${errMessage(err)}`,
    };
  }
}

/** Fetch GitHub status for every repo (sequential; each repo degrades independently). */
export async function fetchPortfolioGithubStatus(
  inputs: RepoGithubStatusInput[],
  runner: CommandRunner = defaultCommandRunner,
  options: PortfolioGithubStatusOptions = {},
): Promise<RepoGithubStatus[]> {
  const statuses: RepoGithubStatus[] = [];
  for (const input of inputs) {
    statuses.push(await fetchRepoGithubStatus(input, runner, options));
  }
  return statuses;
}

async function fetchPullRequests(
  slug: string,
  limit: number,
  runner: CommandRunner,
): Promise<PullRequestSummary[]> {
  const stdout = await runner.run("gh", [
    "pr",
    "list",
    "--repo",
    slug,
    "--state",
    "open",
    "--limit",
    String(limit),
    "--json",
    "number,title,state,headRefName,isDraft,url",
  ]);
  return PrListJson.parse(JSON.parse(stdout)).map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state,
    head: pr.headRefName,
    isDraft: pr.isDraft,
    url: pr.url,
  }));
}

async function fetchCiRuns(
  slug: string,
  limit: number,
  runner: CommandRunner,
): Promise<CiRunSummary[]> {
  const stdout = await runner.run("gh", [
    "run",
    "list",
    "--repo",
    slug,
    "--limit",
    String(limit),
    "--json",
    "databaseId,workflowName,status,conclusion,headBranch,event,createdAt,url",
  ]);
  return RunListJson.parse(JSON.parse(stdout));
}

async function fetchLatestRelease(
  slug: string,
  runner: CommandRunner,
): Promise<ReleaseSummary | undefined> {
  const stdout = await runner.run("gh", [
    "release",
    "list",
    "--repo",
    slug,
    "--limit",
    "1",
    "--json",
    "tagName,name,publishedAt",
  ]);
  const releases = ReleaseListJson.parse(JSON.parse(stdout));
  const latest = releases[0];
  if (latest === undefined) return undefined;
  return {
    tagName: latest.tagName,
    name: latest.name,
    publishedAt: latest.publishedAt,
    url: `https://github.com/${slug}/releases/tag/${latest.tagName}`,
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
