import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImprovementExecutionRepository, improvementProposalDigest, listImprovementProposals, openDb, upsertFeedbackAsset, upsertImprovementProposal } from "@osstack/core";
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

function seedProposal(risk: "low" | "medium", gates: string[], proposedPath = "eval/cases.jsonl") {
  return withDb((db, path) => upsertImprovementProposal(db, path, {
    proposal_id: `prop_${risk}`,
    repo_id: "osstack",
    source_asset_ids: ["asset_1"],
    target: risk === "low" ? "eval" : "prompt",
    risk,
    title: "Test proposal",
    rationale: "evidence",
    proposed_changes: [{ path: proposedPath, action: "modify", summary: "append" }],
    required_gates: gates,
  }));
}

describe("improve CLI", () => {
  it("inspects the definition, previews approval, then approves only its exact digest", async () => {
    const proposal = await seedProposal("low", ["true"]);
    const digest = improvementProposalDigest(proposal);
    expect(await main(["improve", "inspect", "--proposal", proposal.proposal_id])).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ proposal_digest: digest, proposal: { status: "draft" }, executions: [] });
    logs.length = 0;
    const args = ["improve", "approve", "--proposal", proposal.proposal_id, "--digest", digest];
    expect(await main(args)).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ dry_run: true, digest_matches: true });
    expect((await withDb((db) => listImprovementProposals(db)))[0]?.status).toBe("draft");
    logs.length = 0;
    expect(await main([...args, "--yes"])).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ authorization: "local_operator_candidate_only", proposal: { status: "approved" } });
  });

  it("rejects stale approval digests without changing the proposal", async () => {
    const original = await seedProposal("low", ["true"]);
    expect(await main(["improve", "approve", "--proposal", original.proposal_id, "--digest", "0".repeat(64), "--yes"])).toBe(1);
    expect(await withDb((db) => listImprovementProposals(db))).toEqual([original]);
  });

  it("does not substitute cwd when the execution repository is unregistered", async () => {
    const original = await seedProposal("low", ["true"]);
    const args = ["--proposal", original.proposal_id, "--digest", improvementProposalDigest(original)];
    expect(await main(["improve", "approve", ...args, "--yes"])).toBe(0);
    expect(await main(["improve", "execute", ...args, "--execution", "missing-registry", "--registry", join(tmp, "missing.json"), "--yes"])).toBe(1);
    expect(errors.join("\n")).toContain("enabled registry entry");
    expect(await withDb((db, path) => new ImprovementExecutionRepository(db, path).list({}))).toEqual([]);
  });

  it("shows persisted uncertain work without restarting it", async () => {
    const original = await seedProposal("low", ["true"]);
    const digest = improvementProposalDigest(original);
    expect(await main(["improve", "approve", "--proposal", original.proposal_id, "--digest", digest, "--yes"])).toBe(0);
    await withDb((db, path) => new ImprovementExecutionRepository(db, path).claim({ execution_id: "unfinished", proposal_id: original.proposal_id, request: { proposal_digest: digest }, now: 1 }));
    logs.length = 0;
    expect(await main(["improve", "status", "--execution", "unfinished"])).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ applied: false, execution: { state: "claimed" } });
  });

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

  it("reproposing the same evidence preserves and reports the reviewed state", async () => {
    await withDb((db, path) => upsertFeedbackAsset(db, path, {
      asset_id: "asset_1", repo_id: "osstack", source_trace_id: "trace_1",
      kind: "eval_case", failure_family: "bad_reasoning", summary: "needs a case", evidence: [],
    }));
    const args = ["improve", "propose", "--repo", "osstack", "--registry", join(tmp, "repos.json"), "--json"];
    expect(await main(args)).toBe(0);
    const original = await withDb((db, path) => {
      const proposal = listImprovementProposals(db)[0]!;
      return upsertImprovementProposal(db, path, { ...proposal, status: "approved" });
    });
    logs.length = 0;
    expect(await main(args)).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ proposals: [{ proposal_id: original.proposal_id, status: "approved" }] });
    expect(await withDb((db) => listImprovementProposals(db))).toEqual([original]);
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

  it("apply --yes reports only gate checks, without claiming implementation or changing the proposal", async () => {
    const artifact = join(tmp, "candidate.jsonl");
    await writeFile(artifact, "original\n");
    await seedProposal("low", ["true"], artifact);
    const before = await withDb((db) => listImprovementProposals(db));
    const code = await main(["improve", "apply", "--proposal", "prop_low", "--yes", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      applied: false,
      action: "gates_passed",
      implementation_status: "not_implemented",
    });
    const stored = await withDb((db) => listImprovementProposals(db, { limit: 10 }));
    expect(stored).toEqual(before);
    expect(await readFile(artifact, "utf8")).toBe("original\n");
  });

  it.each(["applied", "rejected"] as const)("preserves legacy %s records without rerunning gates or asserting new implementation", async (status) => {
    const seeded = await seedProposal("low", ["false"]);
    const original = await withDb((db, path) => upsertImprovementProposal(db, path, { ...seeded, status }));
    const code = await main(["improve", "apply", "--proposal", "prop_low", "--yes", "--json"]);
    expect(code).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ applied: false, action: "unchanged", stored_status: status });
    expect(await withDb((db) => listImprovementProposals(db))).toEqual([original]);
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
