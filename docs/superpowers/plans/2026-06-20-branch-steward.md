# Branch Steward Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build Branch Steward report mode: discover remote GitHub feature branches, score candidates, emit dry-run PR intents, and expose the result through osstack loop and CLI surfaces without writing to GitHub.

**Architecture:** Add a focused `@osstack/github` workspace package for branch scanning, scoring, and report rendering. Wire it into `@osstack/loop` as a `github_branch` discover source and into `@osstack/cli` as `osstack steward scan`, keeping all GitHub write operations out of the first release.

**Tech Stack:** TypeScript, pnpm workspaces, Vitest, Zod, Git CLI for local branch facts, GitHub CLI JSON output for authenticated repo metadata in report mode.

---

## File Structure

- Create `packages/github/package.json`: package metadata, build/test/typecheck scripts, workspace dependencies.
- Create `packages/github/tsconfig.json`: TypeScript project config consistent with existing packages.
- Create `packages/github/src/types.ts`: Zod schemas and TypeScript types for repo snapshots, branch candidates, scores, reports, and PR intents.
- Create `packages/github/src/branch-scorer.ts`: pure scoring and action decision logic.
- Create `packages/github/src/branch-scorer.test.ts`: unit tests for score thresholds and safety downgrades.
- Create `packages/github/src/branch-scanner.ts`: Git/GitHub-backed scanner and injectable command runner.
- Create `packages/github/src/branch-scanner.test.ts`: mocked scanner tests covering no candidates and one eligible candidate.
- Create `packages/github/src/report.ts`: human-readable and JSON-safe report formatting.
- Create `packages/github/src/report.test.ts`: report rendering tests.
- Create `packages/github/src/index.ts`: public exports.
- Modify `packages/loop/src/types.ts`: add `github_branch` to `DiscoverSource`.
- Modify `packages/loop/src/discover.ts`: add `GitHubBranchScanner` adapter that maps `BranchCandidate` to loop `Task`.
- Modify `packages/loop/src/discover.test.ts`: test source factory and task mapping.
- Modify `packages/cli/src/bin.ts`: add `steward scan` command and help text.
- Modify `package.json` only if workspace-level scripts need no change; pnpm already discovers `packages/*`.

## Task 1: Add `@osstack/github` Package Skeleton and Types

**Files:**
- Create: `packages/github/package.json`
- Create: `packages/github/tsconfig.json`
- Create: `packages/github/src/types.ts`
- Create: `packages/github/src/index.ts`

- [ ] **Step 1: Create the package metadata**

Create `packages/github/package.json`:

```json
{
  "name": "@osstack/github",
  "version": "0.0.0",
  "description": "GitHub branch stewardship helpers for osstack.",
  "license": "MIT",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p .",
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "zod": "^3.25.76"
  },
  "devDependencies": {
    "@types/node": "^22.19.19"
  }
}
```

- [ ] **Step 2: Create TypeScript config**

Create `packages/github/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "composite": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Define Branch Steward schemas**

Create `packages/github/src/types.ts`:

```ts
import { z } from "zod";

export const CheckState = z.enum(["success", "failure", "pending", "unknown"]);
export type CheckState = z.infer<typeof CheckState>;

export const BranchAction = z.enum(["report", "create_pr", "enable_auto_merge", "escalate"]);
export type BranchAction = z.infer<typeof BranchAction>;

export const BranchCandidate = z.object({
  repo: z.string().min(1),
  base: z.string().min(1),
  head: z.string().min(1),
  remote: z.string().default("origin"),
  aheadBy: z.number().int().min(0),
  behindBy: z.number().int().min(0),
  changedFiles: z.number().int().min(0),
  additions: z.number().int().min(0),
  deletions: z.number().int().min(0),
  hasOpenPr: z.boolean().default(false),
  isDraft: z.boolean().optional(),
  checksState: CheckState.default("unknown"),
  sensitivePaths: z.array(z.string()).default([]),
  author: z.string().optional(),
  updatedAt: z.string().optional(),
  title: z.string().optional(),
  reasons: z.array(z.string()).default([]),
  score: z.number().min(0).max(100).default(0),
  action: BranchAction.default("report"),
});
export type BranchCandidate = z.infer<typeof BranchCandidate>;

export const BranchStewardConfig = z.object({
  repo: z.string().min(1),
  base: z.string().default("main"),
  remote: z.string().default("origin"),
  branchPrefixAllowlist: z.array(z.string()).default(["feat/", "feature/", "codex/"]),
  sensitivePathGlobs: z.array(z.string()).default([
    ".github/workflows/",
    "package.json",
    "pnpm-lock.yaml",
  ]),
  maxChangedFiles: z.number().int().min(1).default(80),
  maxBehindBy: z.number().int().min(0).default(25),
  prThreshold: z.number().min(0).max(100).default(80),
  autoMergeThreshold: z.number().min(0).max(100).default(90),
});
export type BranchStewardConfig = z.infer<typeof BranchStewardConfig>;

export const PullRequestIntent = z.object({
  repo: z.string(),
  base: z.string(),
  head: z.string(),
  title: z.string(),
  body: z.string(),
  labels: z.array(z.string()).default(["osstack/steward", "auto-pr"]),
});
export type PullRequestIntent = z.infer<typeof PullRequestIntent>;

export const BranchStewardReport = z.object({
  repo: z.string(),
  base: z.string(),
  generatedAt: z.string(),
  candidates: z.array(BranchCandidate),
  prIntents: z.array(PullRequestIntent).default([]),
});
export type BranchStewardReport = z.infer<typeof BranchStewardReport>;
```

- [ ] **Step 4: Export the package surface**

Create `packages/github/src/index.ts`:

```ts
export * from "./types.js";
```

- [ ] **Step 5: Run the package tests**

Run: `pnpm --filter @osstack/github test`

Expected: PASS with no tests found or no test failures.

- [ ] **Step 6: Commit**

```bash
git add packages/github/package.json packages/github/tsconfig.json packages/github/src/types.ts packages/github/src/index.ts
git commit -m "feat(github): add branch steward types"
```

## Task 2: Implement Branch Scoring

**Files:**
- Create: `packages/github/src/branch-scorer.ts`
- Create: `packages/github/src/branch-scorer.test.ts`
- Modify: `packages/github/src/index.ts`

- [ ] **Step 1: Write failing scorer tests**

Create `packages/github/src/branch-scorer.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scoreBranchCandidate } from "./branch-scorer.js";
import type { BranchCandidate, BranchStewardConfig } from "./types.js";

const config: BranchStewardConfig = {
  repo: "gilosbornhello/osstack",
  base: "main",
  remote: "origin",
  branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
  sensitivePathGlobs: [".github/workflows/", "package.json", "pnpm-lock.yaml"],
  maxChangedFiles: 80,
  maxBehindBy: 25,
  prThreshold: 80,
  autoMergeThreshold: 90,
};

function candidate(overrides: Partial<BranchCandidate> = {}): BranchCandidate {
  return {
    repo: "gilosbornhello/osstack",
    base: "main",
    head: "feat/good-branch",
    remote: "origin",
    aheadBy: 4,
    behindBy: 0,
    changedFiles: 6,
    additions: 120,
    deletions: 20,
    hasOpenPr: false,
    checksState: "success",
    sensitivePaths: [],
    reasons: [],
    score: 0,
    action: "report",
    ...overrides,
  };
}

describe("scoreBranchCandidate", () => {
  it("marks a clean feature branch as auto-merge eligible", () => {
    const result = scoreBranchCandidate(candidate(), config);
    expect(result.score).toBeGreaterThanOrEqual(90);
    expect(result.action).toBe("enable_auto_merge");
    expect(result.reasons).toContain("branch prefix is allowlisted");
  });

  it("keeps failing checks in report mode", () => {
    const result = scoreBranchCandidate(candidate({ checksState: "failure" }), config);
    expect(result.action).toBe("report");
    expect(result.reasons).toContain("checks are failing");
  });

  it("escalates sensitive path changes", () => {
    const result = scoreBranchCandidate(candidate({ sensitivePaths: ["package.json"] }), config);
    expect(result.action).toBe("escalate");
    expect(result.reasons).toContain("sensitive paths changed");
  });

  it("keeps non-allowlisted branches in report mode", () => {
    const result = scoreBranchCandidate(candidate({ head: "release/v1" }), config);
    expect(result.action).toBe("report");
    expect(result.score).toBeLessThan(80);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @osstack/github test`

Expected: FAIL because `branch-scorer.ts` does not exist.

- [ ] **Step 3: Implement scoring**

Create `packages/github/src/branch-scorer.ts`:

```ts
import type { BranchCandidate, BranchStewardConfig } from "./types.js";

export function scoreBranchCandidate(
  candidate: BranchCandidate,
  config: BranchStewardConfig,
): BranchCandidate {
  let score = 50;
  const reasons: string[] = [];

  const allowedPrefix = config.branchPrefixAllowlist.some((prefix) => candidate.head.startsWith(prefix));
  if (allowedPrefix) {
    score += 20;
    reasons.push("branch prefix is allowlisted");
  } else {
    score -= 30;
    reasons.push("branch prefix is not allowlisted");
  }

  if (candidate.aheadBy > 0) {
    score += 10;
    reasons.push("branch is ahead of base");
  } else {
    score -= 25;
    reasons.push("branch has no unique commits");
  }

  if (candidate.behindBy <= config.maxBehindBy) {
    score += 10;
    reasons.push("branch is not far behind base");
  } else {
    score -= 20;
    reasons.push("branch is far behind base");
  }

  if (candidate.changedFiles <= config.maxChangedFiles) {
    score += 10;
    reasons.push("diff size is within limit");
  } else {
    score -= 25;
    reasons.push("diff size is too large");
  }

  if (candidate.checksState === "success") {
    score += 15;
    reasons.push("checks are passing");
  } else if (candidate.checksState === "failure") {
    score -= 35;
    reasons.push("checks are failing");
  } else if (candidate.checksState === "pending") {
    score -= 10;
    reasons.push("checks are pending");
  } else {
    score -= 5;
    reasons.push("checks are unknown");
  }

  if (candidate.hasOpenPr) {
    score -= 15;
    reasons.push("branch already has an open PR");
  }

  if (candidate.isDraft === true) {
    score -= 20;
    reasons.push("existing PR is draft");
  }

  if (candidate.sensitivePaths.length > 0) {
    score -= 40;
    reasons.push("sensitive paths changed");
  }

  const boundedScore = Math.max(0, Math.min(100, score));
  const action = decideAction(boundedScore, candidate, config);

  return {
    ...candidate,
    score: boundedScore,
    action,
    reasons,
  };
}

function decideAction(
  score: number,
  candidate: BranchCandidate,
  config: BranchStewardConfig,
): BranchCandidate["action"] {
  if (candidate.sensitivePaths.length > 0) return "escalate";
  if (candidate.checksState === "failure") return "report";
  if (candidate.hasOpenPr) return "report";
  if (score >= config.autoMergeThreshold && candidate.checksState === "success") return "enable_auto_merge";
  if (score >= config.prThreshold) return "create_pr";
  return "report";
}
```

- [ ] **Step 4: Export scorer**

Modify `packages/github/src/index.ts`:

```ts
export * from "./types.js";
export * from "./branch-scorer.js";
```

- [ ] **Step 5: Run scorer tests**

Run: `pnpm --filter @osstack/github test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/github/src/branch-scorer.ts packages/github/src/branch-scorer.test.ts packages/github/src/index.ts
git commit -m "feat(github): score branch steward candidates"
```

## Task 3: Implement Branch Scanner and Report Rendering

**Files:**
- Create: `packages/github/src/branch-scanner.ts`
- Create: `packages/github/src/branch-scanner.test.ts`
- Create: `packages/github/src/report.ts`
- Create: `packages/github/src/report.test.ts`
- Modify: `packages/github/src/index.ts`

- [ ] **Step 1: Write scanner tests**

Create `packages/github/src/branch-scanner.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { scanBranchStewardCandidates } from "./branch-scanner.js";
import type { BranchStewardConfig } from "./types.js";

const config: BranchStewardConfig = {
  repo: "gilosbornhello/osstack",
  base: "main",
  remote: "origin",
  branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
  sensitivePathGlobs: [".github/workflows/", "package.json", "pnpm-lock.yaml"],
  maxChangedFiles: 80,
  maxBehindBy: 25,
  prThreshold: 80,
  autoMergeThreshold: 90,
};

describe("scanBranchStewardCandidates", () => {
  it("returns no candidates when there are no allowlisted remote branches", async () => {
    const report = await scanBranchStewardCandidates(config, {
      run: async (command, args) => {
        if (command === "git" && args.join(" ") === "branch -r --no-merged origin/main") {
          return "  origin/changeset-release/main\n";
        }
        return "";
      },
    });

    expect(report.candidates).toEqual([]);
    expect(report.prIntents).toEqual([]);
  });

  it("scores one eligible feature branch and creates a dry-run PR intent", async () => {
    const report = await scanBranchStewardCandidates(config, {
      run: async (command, args) => {
        const joined = `${command} ${args.join(" ")}`;
        if (joined === "git branch -r --no-merged origin/main") return "  origin/feat/useful\n";
        if (joined === "git rev-list --left-right --count origin/main...origin/feat/useful") return "0\t3\n";
        if (joined === "git diff --name-only origin/main...origin/feat/useful") return "packages/loop/src/discover.ts\n";
        if (joined === "git diff --shortstat origin/main...origin/feat/useful") {
          return " 1 file changed, 20 insertions(+), 2 deletions(-)\n";
        }
        return "";
      },
    });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.head).toBe("feat/useful");
    expect(report.candidates[0]?.action).toBe("create_pr");
    expect(report.prIntents[0]?.head).toBe("feat/useful");
  });
});
```

- [ ] **Step 2: Write report tests**

Create `packages/github/src/report.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderBranchStewardReport } from "./report.js";
import type { BranchStewardReport } from "./types.js";

describe("renderBranchStewardReport", () => {
  it("renders the no-candidate state", () => {
    const report: BranchStewardReport = {
      repo: "gilosbornhello/osstack",
      base: "main",
      generatedAt: "2026-06-20T00:00:00.000Z",
      candidates: [],
      prIntents: [],
    };

    expect(renderBranchStewardReport(report)).toContain("No eligible branch candidates found.");
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm --filter @osstack/github test`

Expected: FAIL because scanner and report modules do not exist.

- [ ] **Step 4: Implement scanner**

Create `packages/github/src/branch-scanner.ts`:

```ts
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
      encoding: "utf-8",
      timeout: 30_000,
      maxBuffer: 1024 * 1024 * 10,
    });
    return stdout;
  },
};

export interface ScanBranchStewardOptions {
  cwd?: string;
}

export async function scanBranchStewardCandidates(
  rawConfig: BranchStewardConfig,
  runner: CommandRunner = defaultCommandRunner,
  options: ScanBranchStewardOptions = {},
): Promise<BranchStewardReport> {
  const config = BranchStewardConfig.parse(rawConfig);
  await runner.run("git", ["fetch", config.remote, "--prune"], { cwd: options.cwd });
  const refs = await runner.run("git", [
    "branch",
    "-r",
    "--no-merged",
    `${config.remote}/${config.base}`,
  ], { cwd: options.cwd });

  const candidates: BranchCandidate[] = [];
  for (const ref of parseRemoteBranches(refs, config.remote)) {
    if (!config.branchPrefixAllowlist.some((prefix) => ref.startsWith(prefix))) continue;
    const candidate = await inspectBranch(config, ref, runner, options);
    candidates.push(scoreBranchCandidate(candidate, config));
  }

  candidates.sort((a, b) => b.score - a.score);
  const prIntents = candidates
    .filter((candidate) => candidate.action === "create_pr" || candidate.action === "enable_auto_merge")
    .map((candidate) => createPullRequestIntent(candidate));

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
    .filter((line) => line.length > 0)
    .filter((line) => !line.includes(" -> "))
    .filter((line) => line.startsWith(`${remote}/`))
    .map((line) => line.slice(remote.length + 1));
}

async function inspectBranch(
  config: BranchStewardConfig,
  head: string,
  runner: CommandRunner,
  options: ScanBranchStewardOptions,
): Promise<BranchCandidate> {
  const baseRef = `${config.remote}/${config.base}`;
  const headRef = `${config.remote}/${head}`;
  const counts = await runner.run("git", ["rev-list", "--left-right", "--count", `${baseRef}...${headRef}`], { cwd: options.cwd });
  const [behindRaw = "0", aheadRaw = "0"] = counts.trim().split(/\s+/);
  const changedFilesOutput = await runner.run("git", ["diff", "--name-only", `${baseRef}...${headRef}`], { cwd: options.cwd });
  const changedPaths = changedFilesOutput.split("\n").map((line) => line.trim()).filter(Boolean);
  const shortstat = await runner.run("git", ["diff", "--shortstat", `${baseRef}...${headRef}`], { cwd: options.cwd });
  const { additions, deletions } = parseShortstat(shortstat);
  const sensitivePaths = changedPaths.filter((path) =>
    config.sensitivePathGlobs.some((glob) => path === glob || path.startsWith(glob)),
  );

  return {
    repo: config.repo,
    base: config.base,
    head,
    remote: config.remote,
    aheadBy: Number(aheadRaw),
    behindBy: Number(behindRaw),
    changedFiles: changedPaths.length,
    additions,
    deletions,
    hasOpenPr: false,
    checksState: "unknown",
    sensitivePaths,
    reasons: [],
    score: 0,
    action: "report",
  };
}

function parseShortstat(shortstat: string): { additions: number; deletions: number } {
  const additions = Number(shortstat.match(/(\d+) insertion/)?.[1] ?? 0);
  const deletions = Number(shortstat.match(/(\d+) deletion/)?.[1] ?? 0);
  return { additions, deletions };
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
```

- [ ] **Step 5: Implement report rendering**

Create `packages/github/src/report.ts`:

```ts
import type { BranchStewardReport } from "./types.js";

export function renderBranchStewardReport(report: BranchStewardReport): string {
  const lines = [
    `Branch Steward Report: ${report.repo}`,
    `Base: ${report.base}`,
    `Generated: ${report.generatedAt}`,
    "",
  ];

  if (report.candidates.length === 0) {
    lines.push("No eligible branch candidates found.");
    return lines.join("\n");
  }

  for (const candidate of report.candidates) {
    lines.push(`- ${candidate.head}: score=${candidate.score} action=${candidate.action}`);
    lines.push(`  ahead=${candidate.aheadBy} behind=${candidate.behindBy} files=${candidate.changedFiles}`);
    for (const reason of candidate.reasons) lines.push(`  - ${reason}`);
  }

  if (report.prIntents.length > 0) {
    lines.push("");
    lines.push("Dry-run PR intents:");
    for (const intent of report.prIntents) {
      lines.push(`- ${intent.head} -> ${intent.base}: ${intent.title}`);
    }
  }

  return lines.join("\n");
}
```

- [ ] **Step 6: Export scanner and report**

Modify `packages/github/src/index.ts`:

```ts
export * from "./types.js";
export * from "./branch-scorer.js";
export * from "./branch-scanner.js";
export * from "./report.js";
```

- [ ] **Step 7: Run tests**

Run: `pnpm --filter @osstack/github test`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/github/src/branch-scanner.ts packages/github/src/branch-scanner.test.ts packages/github/src/report.ts packages/github/src/report.test.ts packages/github/src/index.ts
git commit -m "feat(github): scan branch steward candidates"
```

## Task 4: Wire `github_branch` Into Loop Discovery

**Files:**
- Modify: `packages/loop/package.json`
- Modify: `packages/loop/src/types.ts`
- Modify: `packages/loop/src/discover.ts`
- Modify: `packages/loop/src/discover.test.ts`

- [ ] **Step 1: Add package dependency**

Modify `packages/loop/package.json` dependencies:

```json
"dependencies": {
  "@osstack/agents": "workspace:*",
  "@osstack/core": "workspace:*",
  "@osstack/github": "workspace:*",
  "@osstack/hermes-adapter": "workspace:*",
  "zod": "^3.25.76"
}
```

- [ ] **Step 2: Add discover source**

Modify `packages/loop/src/types.ts`:

```ts
export const DiscoverSource = z.enum([
  "git_diff",
  "gh_issue",
  "ci_log",
  "task_queue",
  "manual",
  "github_branch",
]);
```

- [ ] **Step 3: Add scanner factory branch**

Modify `packages/loop/src/discover.ts` imports:

```ts
import { scanBranchStewardCandidates } from "@osstack/github";
```

Modify `createScanner`:

```ts
case "github_branch":
  return new GitHubBranchScanner(workspacePath);
```

Add scanner class:

```ts
export class GitHubBranchScanner implements DiscoverScanner {
  readonly source: DiscoverSource = "github_branch";

  constructor(private workspacePath: string) {}

  async scan(): Promise<Task[]> {
    const repo = getRepoSlug(this.workspacePath);
    if (repo === undefined) return [];
    const report = await scanBranchStewardCandidates({
      repo,
      base: "main",
      remote: "origin",
      branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
      sensitivePathGlobs: [".github/workflows/", "package.json", "pnpm-lock.yaml"],
      maxChangedFiles: 80,
      maxBehindBy: 25,
      prThreshold: 80,
      autoMergeThreshold: 90,
    }, undefined, { cwd: this.workspacePath });

    return report.candidates.map((candidate) => Task.parse({
      task_id: `github-branch-${candidate.head.replace(/[^a-zA-Z0-9._-]/g, "-")}`,
      capability: "release.verify",
      prompt: `Evaluate ${candidate.remote}/${candidate.head} for safe PR creation into ${candidate.base}.`,
      priority: candidate.score,
      source: "github_branch",
      context: {
        repo: candidate.repo,
        base: candidate.base,
        head: candidate.head,
        score: candidate.score,
        action: candidate.action,
        reasons: candidate.reasons,
      },
    }));
  }
}

function getRepoSlug(workspacePath: string): string | undefined {
  try {
    const remote = execSync("git remote get-url origin", {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 4: Extend discover tests**

Modify imports in `packages/loop/src/discover.test.ts`:

```ts
import { GitDiffScanner, GitHubBranchScanner, TaskQueueScanner, createScanner } from "./discover.js";
```

Add expectation:

```ts
expect(createScanner("github_branch", repo)).toBeInstanceOf(GitHubBranchScanner);
```

- [ ] **Step 5: Run loop tests**

Run: `pnpm --filter @osstack/loop test`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/loop/package.json packages/loop/src/types.ts packages/loop/src/discover.ts packages/loop/src/discover.test.ts
git commit -m "feat(loop): add github branch discovery source"
```

## Task 5: Add `osstack steward scan`

**Files:**
- Modify: `packages/cli/src/bin.ts`
- Modify: `packages/cli/package.json`
- Create: `packages/cli/src/steward-cli.test.ts`

- [ ] **Step 1: Add CLI dependency**

Modify `packages/cli/package.json` dependencies to include:

```json
"@osstack/github": "workspace:*"
```

- [ ] **Step 2: Write CLI handler test**

Create `packages/cli/src/steward-cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { main } from "./bin.js";

describe("steward cli", () => {
  it("prints help for steward without a subcommand", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (value?: unknown) => { logs.push(String(value)); };
    try {
      await expect(main(["steward"])).resolves.toBe(0);
    } finally {
      console.log = originalLog;
    }
    expect(logs.join("\n")).toContain("steward scan");
  });
});
```

- [ ] **Step 3: Run CLI tests to verify failure**

Run: `pnpm --filter @osstack/cli test -- steward-cli.test.ts`

Expected: FAIL because `steward` is not handled.

- [ ] **Step 4: Add imports**

Modify `packages/cli/src/bin.ts` imports:

```ts
import { renderBranchStewardReport, scanBranchStewardCandidates } from "@osstack/github";
```

- [ ] **Step 5: Add help text**

Add to the help output:

```text
Branch Steward:
  steward scan [--repo O/R] [--base B] [--remote R] [--workspace P] [--json]
                                 Dry-run scan remote feature branches and print PR intents
```

- [ ] **Step 6: Route command**

Add before the unknown command block:

```ts
if (cmd === "steward") {
  return await handleStewardCommand(args.slice(1));
}
```

- [ ] **Step 7: Implement handler**

Add near other command handlers:

```ts
async function handleStewardCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    console.log("osstack steward scan [--repo O/R] [--base B] [--remote R] [--workspace P] [--json]");
    return 0;
  }
  if (sub !== "scan") {
    console.error(`osstack: unknown steward command '${sub}'`);
    return 1;
  }

  const workspacePath = flagValue(args, "--workspace") ?? process.cwd();
  const repo = flagValue(args, "--repo") ?? await inferRepoSlug(workspacePath);
  if (repo === undefined) {
    console.error("osstack: steward scan requires --repo when origin is not a GitHub remote");
    return 1;
  }

  const report = await scanBranchStewardCandidates({
    repo,
    base: flagValue(args, "--base") ?? "main",
    remote: flagValue(args, "--remote") ?? "origin",
    branchPrefixAllowlist: ["feat/", "feature/", "codex/"],
    sensitivePathGlobs: [".github/workflows/", "package.json", "pnpm-lock.yaml"],
    maxChangedFiles: 80,
    maxBehindBy: 25,
    prThreshold: 80,
    autoMergeThreshold: 90,
  }, undefined, { cwd: workspacePath });

  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(renderBranchStewardReport(report));
  }
  return 0;
}

async function inferRepoSlug(workspacePath: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd: workspacePath,
      encoding: "utf-8",
      timeout: 10_000,
    });
    const remote = stdout.trim();
    const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 8: Run CLI tests**

Run: `pnpm --filter @osstack/cli test -- steward-cli.test.ts`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/cli/package.json packages/cli/src/bin.ts packages/cli/src/steward-cli.test.ts
git commit -m "feat(cli): add branch steward scan command"
```

## Task 6: Verify End-to-end and Use osstack to Track the Work

**Files:**
- Create or modify: `tasks/*.json` through `osstack loop enqueue`
- Generated during verification: `LOOP-STATE.json`, `STATE.md`

- [ ] **Step 1: Before invoking osstack, check GitHub updates**

Run:

```bash
git fetch origin --prune
git status --short --branch
```

Expected: no unexpected remote updates that need to be merged before continuing.

- [ ] **Step 2: Enqueue the implementation task in osstack**

Run:

```bash
node packages/cli/dist/bin.js loop enqueue "Implement Branch Steward report mode from docs/superpowers/plans/2026-06-20-branch-steward.md" --capability release.verify --priority 90 --context-json '{"plan":"docs/superpowers/plans/2026-06-20-branch-steward.md","mode":"report"}'
```

Expected: prints a `task_id` and `path=.../tasks/<id>.json`.

- [ ] **Step 3: Run workspace verification**

Run:

```bash
pnpm build
pnpm test
pnpm --filter @osstack/github test
pnpm --filter @osstack/loop test
pnpm --filter @osstack/cli test
```

Expected: all commands pass.

- [ ] **Step 4: Run dry-run scan against the real repo**

Run:

```bash
node packages/cli/dist/bin.js steward scan --workspace /Users/gilbertchen/Documents/CODE/agentsteam/osstack --repo gilosbornhello/osstack
```

Expected today: report says no eligible branch candidates found, because there are no unmerged `feat/*` remote branches.

- [ ] **Step 5: Run loop source smoke**

Run:

```bash
node packages/cli/dist/bin.js loop run --workspace /Users/gilbertchen/Documents/CODE/agentsteam/osstack --source github_branch --json
```

Expected: loop writes `LOOP-STATE.json` and `STATE.md`; with no candidates, it exits without executing merge or PR write actions.

- [ ] **Step 6: Commit generated task only if it is intentionally part of repo state**

If `tasks/*.json` should be retained as the osstack management artifact:

```bash
git add tasks/*.json
git commit -m "chore: queue branch steward implementation task"
```

If task queue files are local runtime state for this repo, leave them untracked and mention them in the completion report.

## Self-review

- Spec coverage: report mode, candidate scoring, dry-run PR intents, loop integration, CLI scan, and no-candidate behavior are covered.
- Safety coverage: no GitHub writes, no direct merge, no branch deletion, no force push.
- Test coverage: scorer, scanner, report, loop source, CLI command, and real dry-run smoke are covered.
- Type consistency: `BranchCandidate`, `BranchStewardConfig`, `BranchStewardReport`, and `PullRequestIntent` are defined before use.
- Scope control: PR creation and auto-merge remain future phases.
