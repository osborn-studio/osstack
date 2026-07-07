import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, upsertFeedbackAsset } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-supervise-cli-"));
  logs = [];
  errors = [];
  oldHome = process.env["OSSTACK_HOME"];
  process.env["OSSTACK_HOME"] = join(tmp, "home");
  vi.spyOn(console, "log").mockImplementation((...a) => { logs.push(a.map(String).join(" ")); });
  vi.spyOn(console, "error").mockImplementation((...a) => { errors.push(a.map(String).join(" ")); });
});

afterEach(async () => {
  if (oldHome === undefined) delete process.env["OSSTACK_HOME"];
  else process.env["OSSTACK_HOME"] = oldHome;
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

async function seedAsset(overrides: Partial<Parameters<typeof upsertFeedbackAsset>[2]> = {}) {
  const home = join(tmp, "home");
  await mkdir(home, { recursive: true });
  const path = join(home, "state.db");
  const db = openDb({ path });
  try {
    upsertFeedbackAsset(db, path, {
      asset_id: "asset_1",
      repo_id: "stock-monitor",
      source_trace_id: "trace_1",
      kind: "eval_case",
      failure_family: "bad_reasoning",
      summary: "Confidence miscalibrated.",
      evidence: ["expected lower confidence"],
      ...overrides,
    });
  } finally {
    db.close();
  }
}

describe("supervise CLI", () => {
  it("registers a repo into a JSON registry (upsert)", async () => {
    const registry = join(tmp, "repos.json");
    const repoPath = join(tmp, "myrepo");
    await mkdir(repoPath, { recursive: true });

    const code = await main(["supervise", "register", repoPath,
      "--role", "business_product", "--priority", "90", "--verify", "true",
      "--registry", registry, "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as { entry: { repo_id: string; role: string; priority: number } };
    expect(parsed.entry).toMatchObject({ repo_id: "myrepo", role: "business_product", priority: 90 });
    const onDisk = JSON.parse(await readFile(registry, "utf8")) as unknown[];
    expect(onDisk).toHaveLength(1);
  });

  it("rejects an invalid role", async () => {
    const code = await main(["supervise", "register", join(tmp, "r"), "--role", "not_a_role", "--registry", join(tmp, "repos.json")]);
    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/invalid --role/);
  });

  it("scans registered repos into a portfolio report", async () => {
    const registry = join(tmp, "repos.json");
    const repoPath = join(tmp, "scanme");
    await mkdir(repoPath, { recursive: true });
    await writeFile(join(repoPath, "README.md"), "# scanme\n");
    await main(["supervise", "register", repoPath, "--role", "app", "--verify", "true", "--registry", registry]);
    logs = [];

    const code = await main(["supervise", "scan", "--registry", registry, "--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(logs.join("\n")) as { repo_count: number; repos: Array<{ has_readme: boolean }> };
    expect(report.repo_count).toBe(1);
    expect(report.repos[0]?.has_readme).toBe(true);
  });

  it("init-loop-doc writes docs/LOOP.md and does not overwrite without --overwrite", async () => {
    const registry = join(tmp, "repos.json");
    const repoPath = join(tmp, "loopme");
    await mkdir(repoPath, { recursive: true });
    await main(["supervise", "register", repoPath, "--repo-id", "loopme", "--role", "app", "--registry", registry]);
    logs = [];

    const code = await main(["supervise", "init-loop-doc", "--repo", "loopme", "--registry", registry]);
    expect(code).toBe(0);
    await expect(readFile(join(repoPath, "docs", "LOOP.md"), "utf8")).resolves.toContain("Closed Loop Contract");

    logs = [];
    await main(["supervise", "init-loop-doc", "--repo", "loopme", "--registry", registry]);
    expect(logs.join("\n")).toMatch(/already exists/);
  });

  it("lists feedback assets and meta eval counts", async () => {
    await seedAsset();
    const code = await main(["feedback", "assets", "--repo", "stock-monitor", "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as { assets: Array<{ asset_id: string; kind: string }> };
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets[0]).toMatchObject({ asset_id: "asset_1", kind: "eval_case" });

    logs = [];
    await main(["meta", "eval", "--repo", "stock-monitor", "--json"]);
    const meta = JSON.parse(logs.join("\n")) as { advisory: boolean; counts: { feedback_assets: number } };
    expect(meta.advisory).toBe(true);
    expect(meta.counts.feedback_assets).toBe(1);
  });
});
