import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  attachKnowledgeHygieneSummaries,
  scanPortfolioKnowledgeHygiene,
} from "./hygiene-scanner.js";
import { RepoHealth, RepoRegistryEntry } from "./types.js";

function entry(path: string, index: number, enabled = true) {
  return RepoRegistryEntry.parse({
    repo_id: `repo-${index.toString().padStart(2, "0")}`,
    name: `Repo ${index}`,
    path,
    role: "app",
    enabled,
  });
}

describe("portfolio knowledge hygiene scanner", () => {
  it("scans twenty temporary repos within a bounded worker pool and registry order", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-hygiene-portfolio-"));
    const entries = await Promise.all(Array.from({ length: 20 }, async (_, index) => {
      const path = join(root, `repo-${index}`);
      await mkdir(path);
      await writeFile(join(path, "AGENTS.md"), `# Repo ${index}\n`);
      return entry(path, index);
    }));
    const started = Date.now();

    const results = await scanPortfolioKnowledgeHygiene(entries, {
      concurrency: 4,
      now: () => new Date("2026-07-17T00:00:00.000Z"),
    });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(results.map((result) => result.repo_id)).toEqual(
      entries.map((candidate) => candidate.repo_id),
    );
    expect(results).toHaveLength(20);
    expect(results.every(
      (result) => result.status === "ok" && result.hygiene.complete,
    )).toBe(true);
    expect(results.every(
      (result) => result.status === "ok"
        && result.hygiene.checked_at === "2026-07-17T00:00:00.000Z",
    )).toBe(true);
  });

  it("isolates failures, excludes disabled entries, and never exceeds concurrency", async () => {
    const entries = [
      entry("/repo/0", 0),
      entry("/repo/1", 1),
      entry("/repo/2", 2),
      entry("/repo/3", 3, false),
    ];
    let active = 0;
    let peak = 0;

    const results = await scanPortfolioKnowledgeHygiene(entries, {
      concurrency: 2,
      check: async (input) => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        active -= 1;
        if (input.repo_root === "/repo/1") throw new Error("isolated failure");
        return {
          schema_version: "1",
          generated_at: "2026-07-17T00:00:00.000Z",
          repo: { root: input.repo_root },
          input: { mode: "all" },
          completeness: { complete: true, skipped_files: 0, reasons: [] },
          summary: { error: 0, warning: 0, info: 0, suppressed: 0 },
          findings: [],
          metrics: [],
        };
      },
    });

    expect(peak).toBe(2);
    expect(results.map((result) => result.repo_id)).toEqual([
      "repo-00",
      "repo-01",
      "repo-02",
    ]);
    expect(results[1]).toEqual({
      repo_id: "repo-01",
      status: "error",
      error: "isolated failure",
    });
  });

  it("attaches summaries without affecting maturity and records isolated errors", () => {
    const health = RepoHealth.parse({
      repo_id: "repo-00",
      name: "Repo 0",
      path: "/repo/0",
      role: "app",
      exists: true,
      has_readme: true,
      has_loop_doc: false,
      has_tests: true,
      has_verify_command: true,
      closed_loop_level: 3,
    });
    const attached = attachKnowledgeHygieneSummaries([health], [{
      repo_id: "repo-00",
      status: "ok",
      hygiene: {
        complete: true,
        health_claim: "findings_present",
        coverage: [{ dimension: "mechanical", state: "complete" }],
        error_count: 0,
        warning_count: 1,
        recurring_count: 1,
        checked_at: "2026-07-17T00:00:00.000Z",
      },
    }]);

    expect(attached[0]?.closed_loop_level).toBe(3);
    expect(attached[0]?.hygiene?.warning_count).toBe(1);
  });
});
