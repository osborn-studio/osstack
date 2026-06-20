import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scoreBranchCandidate } from "./branch-scorer.js";
import {
  BranchStewardConfig,
  BranchStewardReport,
  type BranchCandidate,
  type PullRequestIntent,
} from "./types.js";

const execFileAsync = promisify(execFile);

export interface CommandRunner {
  run(command: string, args: string[], options?: { cwd?: string }): Promise<string>;
}

export const defaultCommandRunner: CommandRunner = {
  async run(command, args, options) {
    const { stdout } = await execFileAsync(command, args, {
      cwd: options?.cwd,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
      timeout: 30_000,
    });
    return stdout;
  },
};

export interface ScanBranchStewardOptions {
  cwd?: string;
  skipFetch?: boolean;
}

export async function scanBranchStewardCandidates(
  rawConfig: BranchStewardConfig,
  runner: CommandRunner = defaultCommandRunner,
  options: ScanBranchStewardOptions = {},
): Promise<BranchStewardReport> {
  const config = BranchStewardConfig.parse(rawConfig);

  if (options.skipFetch !== true) {
    await runner.run("git", ["fetch", config.remote, "--prune"], commandOptions(options));
  }

  const branchRefs = await runner.run(
    "git",
    ["branch", "-r", "--no-merged", `${config.remote}/${config.base}`],
    commandOptions(options),
  );

  const candidates: BranchCandidate[] = [];
  for (const head of parseRemoteBranches(branchRefs, config.remote)) {
    if (!isAllowlistedBranch(head, config)) continue;

    const candidate = await inspectBranch(config, head, runner, options);
    candidates.push(scoreBranchCandidate(candidate, config));
  }

  candidates.sort((left, right) => right.score - left.score);

  const prIntents = candidates
    .filter(
      (candidate) =>
        candidate.action === "create_pr" || candidate.action === "enable_auto_merge",
    )
    .map(createPullRequestIntent);

  return BranchStewardReport.parse({
    repo: config.repo,
    base: config.base,
    generatedAt: new Date().toISOString(),
    candidates,
    prIntents,
  });
}

function parseRemoteBranches(output: string, remote: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.includes(" -> "))
    .filter((line) => line.startsWith(`${remote}/`))
    .map((line) => line.slice(remote.length + 1));
}

function isAllowlistedBranch(head: string, config: BranchStewardConfig): boolean {
  return config.branchPrefixAllowlist.some((prefix) => head.startsWith(prefix));
}

async function inspectBranch(
  config: BranchStewardConfig,
  head: string,
  runner: CommandRunner,
  options: ScanBranchStewardOptions,
): Promise<BranchCandidate> {
  const baseRef = `${config.remote}/${config.base}`;
  const headRef = `${config.remote}/${head}`;
  const range = `${baseRef}...${headRef}`;

  const counts = await runner.run(
    "git",
    ["rev-list", "--left-right", "--count", range],
    commandOptions(options),
  );
  const [behindRaw = "0", aheadRaw = "0"] = counts.trim().split(/\s+/);

  const changedFilesOutput = await runner.run(
    "git",
    ["diff", "--name-only", "-z", range],
    commandOptions(options),
  );
  const changedPaths = changedFilesOutput
    .split("\0")
    .filter(Boolean);

  const shortstat = await runner.run(
    "git",
    ["diff", "--shortstat", range],
    commandOptions(options),
  );
  const { additions, deletions } = parseShortstat(shortstat);

  return {
    repo: config.repo,
    base: config.base,
    head,
    remote: config.remote,
    aheadBy: parseCount(aheadRaw),
    behindBy: parseCount(behindRaw),
    changedFiles: changedPaths.length,
    additions,
    deletions,
    hasOpenPr: false,
    checksState: "unknown",
    sensitivePaths: findSensitivePaths(changedPaths, config.sensitivePathGlobs),
    reasons: [],
    score: 0,
    action: "report",
  };
}

function commandOptions(options: ScanBranchStewardOptions): { cwd?: string } {
  return options.cwd === undefined ? {} : { cwd: options.cwd };
}

function parseCount(raw: string): number {
  const count = Number.parseInt(raw, 10);
  return Number.isFinite(count) ? count : 0;
}

function parseShortstat(shortstat: string): { additions: number; deletions: number } {
  return {
    additions: Number.parseInt(shortstat.match(/(\d+) insertion/)?.[1] ?? "0", 10),
    deletions: Number.parseInt(shortstat.match(/(\d+) deletion/)?.[1] ?? "0", 10),
  };
}

function findSensitivePaths(paths: string[], sensitivePathGlobs: string[]): string[] {
  return paths.filter((path) =>
    sensitivePathGlobs.some((glob) => matchesSensitivePathGlob(path, glob)),
  );
}

function matchesSensitivePathGlob(path: string, glob: string): boolean {
  if (glob.endsWith("/")) {
    return path.startsWith(glob);
  }

  return matchesSegments(path.split("/"), glob.split("/"));
}

function matchesSegments(pathSegments: string[], globSegments: string[]): boolean {
  function matchFrom(pathIndex: number, globIndex: number): boolean {
    if (globIndex === globSegments.length) {
      return pathIndex === pathSegments.length;
    }

    const globSegment = globSegments[globIndex];
    if (globSegment === "**") {
      for (let nextPathIndex = pathIndex; nextPathIndex <= pathSegments.length; nextPathIndex += 1) {
        if (matchFrom(nextPathIndex, globIndex + 1)) return true;
      }
      return false;
    }

    return (
      pathIndex < pathSegments.length &&
      matchesSegment(pathSegments[pathIndex] ?? "", globSegment ?? "") &&
      matchFrom(pathIndex + 1, globIndex + 1)
    );
  }

  return matchFrom(0, 0);
}

function matchesSegment(pathSegment: string, globSegment: string): boolean {
  const escaped = globSegment
    .split("*")
    .map((part) => part.replace(/[\\^$+?.()|[\]{}]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(pathSegment);
}

function createPullRequestIntent(candidate: BranchCandidate): PullRequestIntent {
  return {
    repo: candidate.repo,
    base: candidate.base,
    head: candidate.head,
    title: `Branch Steward: ${candidate.head}`,
    body: [
      "Branch Steward found this branch as a dry-run PR candidate.",
      "",
      `Score: ${candidate.score}`,
      `Action: ${candidate.action}`,
      "",
      "Reasons:",
      ...candidate.reasons.map((reason) => `- ${reason}`),
    ].join("\n"),
    labels: ["osstack/steward", "auto-pr"],
  };
}
