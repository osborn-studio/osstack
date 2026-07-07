import { mkdtempSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listImprovementProposals, openDb, upsertFeedbackAsset, upsertImprovementProposal } from "@osstack/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldHome: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-improve-cli-"));
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

async function withDb<T>(fn: (db: ReturnType<typeof openDb>, path: string) => T): Promise<T> {
  const home = join(tmp, "home");
  await mkdir(home, { recursive: true });
  const path = join(home, "state.db");
  const db = openDb({ path });
  try {
    return fn(db, path);
  } finally {
    db.close();
  }
}

function seedProposal(risk: "low" | "medium", gates: string[]) {
  return withDb((db, path) => upsertImprovementProposal(db, path, {
    proposal_id: `prop_${risk}`,
    repo_id: "osstack",
    source_asset_ids: ["asset_1"],
    target: risk === "low" ? "eval" : "prompt",
    risk,
    title: "Test proposal",
    rationale: "evidence",
    proposed_changes: [{ path: "eval/cases.jsonl", action: "modify", summary: "append" }],
    required_gates: gates,
  }));
}

describe("improve CLI", () => {
  it("proposes low-risk eval proposals from stored assets", async () => {
    await withDb((db, path) => upsertFeedbackAsset(db, path, {
      asset_id: "asset_1",
      repo_id: "osstack",
      source_trace_id: "trace_1",
      kind: "eval_case",
      failure_family: "bad_reasoning",
      summary: "needs a case",
      evidence: [],
    }));

    const code = await main(["improve", "propose", "--repo", "osstack", "--registry", join(tmp, "repos.json"), "--json"]);
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join("\n")) as { proposals: Array<{ target: string; risk: string }> };
    expect(parsed.proposals[0]).toMatchObject({ target: "eval", risk: "low" });
  });

  it("apply defaults to a dry run that changes nothing", async () => {
    await seedProposal("low", ["true"]);
    const code = await main(["improve", "apply", "--proposal", "prop_low"]);
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/DRY RUN/);
    expect(logs.join("\n")).toMatch(/No files were modified/);
    const stored = await withDb((db) => listImprovementProposals(db, { limit: 10 }));
    expect(stored.find((p) => p.proposal_id === "prop_low")?.status).toBe("draft");
  });

  it("apply --yes applies a low-risk proposal after its gate passes", async () => {
    await seedProposal("low", ["true"]);
    const code = await main(["improve", "apply", "--proposal", "prop_low", "--yes", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ applied: true });
    const stored = await withDb((db) => listImprovementProposals(db, { limit: 10 }));
    expect(stored.find((p) => p.proposal_id === "prop_low")?.status).toBe("applied");
  });

  it("apply --yes refuses a medium-risk proposal (needs human)", async () => {
    await seedProposal("medium", ["true"]);
    const code = await main(["improve", "apply", "--proposal", "prop_medium", "--yes", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ applied: false, action: "needs_human" });
  });

  it("apply --yes blocks and exits 2 when a gate fails", async () => {
    await seedProposal("low", ["false"]);
    const code = await main(["improve", "apply", "--proposal", "prop_low", "--yes", "--json"]);
    expect(code).toBe(2);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ applied: false, action: "blocked" });
  });
});
