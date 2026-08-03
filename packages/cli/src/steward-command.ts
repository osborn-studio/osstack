import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  renderBranchStewardReport,
  scanBranchStewardCandidates,
  type BranchStewardConfig,
  type BranchStewardReport,
} from "@osstack/github";

const execFileAsync = promisify(execFile);

export interface StewardCommandDeps {
  scanCandidates?: typeof scanBranchStewardCandidates;
  renderReport?: (report: BranchStewardReport) => string;
  inferRepo?: (workspacePath: string, remote: string) => Promise<string | undefined>;
  cwd?: () => string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

function printStewardHelp(stdout: (line: string) => void): void {
  stdout(`osstack steward — Branch Steward dry-run reports

  osstack steward scan [--repo O/R] [--base B] [--remote R] [--workspace P] [--json]
  osstack steward help
`);
}

export async function handleStewardCommand(
  args: string[],
  deps: StewardCommandDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const sub = args[0];

  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printStewardHelp(stdout);
    return 0;
  }

  if (sub !== "scan") {
    stderr(`osstack: unknown steward subcommand "${sub}"`);
    return 1;
  }

  const workspacePathValue = stewardFlagValue(args, "--workspace");
  const repoValue = stewardFlagValue(args, "--repo");
  const baseValue = stewardFlagValue(args, "--base");
  const remoteValue = stewardFlagValue(args, "--remote");
  if (workspacePathValue instanceof Error) {
    stderr(`osstack: ${workspacePathValue.message}`);
    return 1;
  }
  if (repoValue instanceof Error) {
    stderr(`osstack: ${repoValue.message}`);
    return 1;
  }
  if (baseValue instanceof Error) {
    stderr(`osstack: ${baseValue.message}`);
    return 1;
  }
  if (remoteValue instanceof Error) {
    stderr(`osstack: ${remoteValue.message}`);
    return 1;
  }

  const workspacePath = workspacePathValue ?? (deps.cwd ?? process.cwd)();
  const remote = remoteValue ?? "origin";
  const repo = repoValue ?? await (deps.inferRepo ?? inferGitHubRepoSlug)(workspacePath, remote);
  if (repo === undefined) {
    stderr(`osstack: unable to infer GitHub repo from ${remote} remote; pass --repo owner/repo`);
    return 1;
  }

  const config: BranchStewardConfig = {
    repo,
    base: baseValue ?? "main",
    remote,
    branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
    sensitivePathGlobs: [".github/workflows/", "package.json", "pnpm-lock.yaml"],
    maxChangedFiles: 80,
    maxBehindBy: 25,
    prThreshold: 80,
    autoMergeThreshold: 90,
  };

  let report: BranchStewardReport;
  try {
    report = await (deps.scanCandidates ?? scanBranchStewardCandidates)(
      config,
      undefined,
      { cwd: workspacePath },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    stderr(`osstack: steward scan failed: ${message}`);
    return 1;
  }
  if (args.includes("--json")) {
    stdout(JSON.stringify(report, null, 2));
  } else {
    stdout((deps.renderReport ?? renderBranchStewardReport)(report));
  }
  return 0;
}

async function inferGitHubRepoSlug(
  workspacePath: string,
  remote: string,
): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", remote], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 10_000,
    });
    return parseGitHubRepoSlug(String(stdout).trim());
  } catch {
    return undefined;
  }
}

function stewardFlagValue(args: string[], name: string): string | undefined | Error {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return new Error(`${name} requires a value`);
  }
  return value;
}

export function parseGitHubRepoSlug(remoteUrl: string): string | undefined {
  const match = remoteUrl.match(
    /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s:]+)\/([^/\s]+?)(?:\.git)?\/?$/,
  );
  if (match === null) return undefined;
  return `${match[1]}/${match[2]}`;
}
