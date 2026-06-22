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
  async function scanChangedPath(path: string, sensitivePathGlobs: string[]) {
    const report = await scanBranchStewardCandidates(
      {
        ...config,
        sensitivePathGlobs,
      },
      {
        run: async (command, args) => {
          const joined = `${command} ${args.join(" ")}`;
          if (joined === "git fetch origin --prune") return "";
          if (joined === "git branch -r --no-merged origin/main") return "  origin/feat/path\n";
          if (joined === "git rev-list --left-right --count origin/main...origin/feat/path") {
            return "0\t1\n";
          }
          if (joined === "git diff --name-only -z origin/main...origin/feat/path") {
            return `${path}\0`;
          }
          if (joined === "git diff --shortstat origin/main...origin/feat/path") {
            return " 1 file changed, 1 insertion(+)\n";
          }
          return "";
        },
      },
    );

    return report.candidates[0]?.sensitivePaths ?? [];
  }

  it("returns no candidates and no PR intents when there are no allowlisted remote branches", async () => {
    const report = await scanBranchStewardCandidates(config, {
      run: async (command, args) => {
        const joined = `${command} ${args.join(" ")}`;
        if (joined === "git fetch origin --prune") return "";
        if (joined === "git branch -r --no-merged origin/main") {
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
        if (joined === "git fetch origin --prune") return "";
        if (joined === "git branch -r --no-merged origin/main") return "  origin/feat/useful\n";
        if (joined === "git rev-list --left-right --count origin/main...origin/feat/useful") {
          return "0\t3\n";
        }
        if (joined === "git diff --name-only -z origin/main...origin/feat/useful") {
          return "packages/loop/src/discover.ts\0";
        }
        if (joined === "git diff --shortstat origin/main...origin/feat/useful") {
          return " 1 file changed, 20 insertions(+), 2 deletions(-)\n";
        }
        return "";
      },
    });

    expect(report.candidates).toHaveLength(1);
    expect(report.candidates[0]?.head).toBe("feat/useful");
    expect(report.candidates[0]?.action).toBe("create_pr");
    expect(report.prIntents).toHaveLength(1);
    expect(report.prIntents[0]?.head).toBe("feat/useful");
  });

  it("matches exact sensitive paths without matching longer filenames", async () => {
    await expect(scanChangedPath("package.json", ["package.json"])).resolves.toEqual([
      "package.json",
    ]);
    await expect(scanChangedPath("package.json.bak", ["package.json"])).resolves.toEqual([]);
  });

  it("matches sensitive directory prefixes", async () => {
    await expect(
      scanChangedPath(".github/workflows/ci.yml", [".github/workflows/"]),
    ).resolves.toEqual([".github/workflows/ci.yml"]);
  });

  it("matches single-segment sensitive globs", async () => {
    await expect(scanChangedPath("deploy.pem", ["*.pem"])).resolves.toEqual(["deploy.pem"]);
  });

  it("matches recursive sensitive globs", async () => {
    await expect(
      scanChangedPath("packages/api/src/secrets.ts", ["packages/**/secrets.ts"]),
    ).resolves.toEqual(["packages/api/src/secrets.ts"]);
  });

  it("parses NUL-delimited changed path output", async () => {
    const report = await scanBranchStewardCandidates(config, {
      run: async (command, args) => {
        const joined = `${command} ${args.join(" ")}`;
        if (joined === "git fetch origin --prune") return "";
        if (joined === "git branch -r --no-merged origin/main") return "  origin/feat/nul\n";
        if (joined === "git rev-list --left-right --count origin/main...origin/feat/nul") {
          return "0\t1\n";
        }
        if (joined === "git diff --name-only -z origin/main...origin/feat/nul") {
          return "alpha.txt\0dir/beta.txt\0";
        }
        if (joined === "git diff --shortstat origin/main...origin/feat/nul") {
          return " 2 files changed, 2 insertions(+)\n";
        }
        return "";
      },
    });

    expect(report.candidates[0]?.changedFiles).toBe(2);
  });
});
