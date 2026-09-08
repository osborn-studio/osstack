import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { listImprovementProposals, upsertImprovementProposal } from "./improvement-proposals.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-proposals-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function seed() {
  return {
    proposal_id: "prop_1",
    repo_id: "osstack",
    source_asset_ids: ["asset_1", "asset_2"],
    target: "eval",
    risk: "low" as const,
    title: "Add calibration case",
    rationale: "Regression evidence exists.",
    proposed_changes: [{ path: "eval/cases.jsonl", action: "modify" as const, summary: "Append case." }],
    required_gates: ["pnpm test"],
  };
}

describe("improvement proposals persistence", () => {
  it("round-trips json arrays and proposed changes", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const view = upsertImprovementProposal(db, path, seed());
      expect(view.status).toBe("draft");
      expect(view.source_asset_ids).toEqual(["asset_1", "asset_2"]);
      expect(view.required_gates).toEqual(["pnpm test"]);
      expect(view.proposed_changes).toEqual([{ path: "eval/cases.jsonl", action: "modify", summary: "Append case." }]);

      const listed = listImprovementProposals(db, { repo_id: "osstack", status: "draft" });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.proposed_changes[0]?.action).toBe("modify");
      expect(listImprovementProposals(db, { proposal_id: "prop_1" })).toEqual([view]);
      expect(listImprovementProposals(db, { proposal_id: "missing" })).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("updates status on upsert and filters by status", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      upsertImprovementProposal(db, path, seed());
      upsertImprovementProposal(db, path, { ...seed(), status: "approved" });
      expect(listImprovementProposals(db, { status: "draft" })).toEqual([]);
      expect(listImprovementProposals(db, { status: "approved" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  it.each([
    { repo_id: "another-repo" },
    { source_asset_ids: ["another-asset"] },
  ])("rejects a conflicting proposal identity without overwriting history: %j", (conflict) => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const original = upsertImprovementProposal(db, path, { ...seed(), status: "approved" });
      expect(() => upsertImprovementProposal(db, path, { ...seed(), ...conflict })).toThrow(/proposal.*conflict/i);
      expect(listImprovementProposals(db)).toEqual([original]);
    } finally {
      db.close();
    }
  });

  it.each(["approved", "applied", "rejected"] as const)("preserves %s when the same draft is proposed again", (status) => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const original = upsertImprovementProposal(db, path, { ...seed(), status });
      expect(upsertImprovementProposal(db, path, seed())).toEqual(original);
      expect(upsertImprovementProposal(db, path, { ...seed(), status: "draft" })).toEqual(original);
      expect(listImprovementProposals(db)).toEqual([original]);
    } finally {
      db.close();
    }
  });

  it("rejects changed content under a v2 id", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const proposal = { ...seed(), proposal_id: "prop_v2_content_bound" };
      const original = upsertImprovementProposal(db, path, proposal);
      expect(() => upsertImprovementProposal(db, path, { ...proposal, required_gates: [] })).toThrow(/proposal.*conflict/i);
      expect(listImprovementProposals(db)).toEqual([original]);
    } finally {
      db.close();
    }
  });

  it.each(["applied", "rejected"] as const)("does not overwrite %s with a late gate result", (status) => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const original = upsertImprovementProposal(db, path, { ...seed(), status });
      expect(() => upsertImprovementProposal(db, path, { ...seed(), status: "blocked" })).toThrow(/proposal.*conflict/i);
      expect(listImprovementProposals(db)).toEqual([original]);
    } finally {
      db.close();
    }
  });

  it("retains legacy draft updates with the same source", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const original = upsertImprovementProposal(db, path, seed());
      const updated = upsertImprovementProposal(db, path, { ...seed(), rationale: "Updated recurrence evidence." });
      expect(updated.rationale).toBe("Updated recurrence evidence.");
      expect(updated.created_at).toBe(original.created_at);
      expect(updated.status).toBe("draft");
      expect(listImprovementProposals(db)).toEqual([updated]);
    } finally {
      db.close();
    }
  });

  it("allows legacy drafts to append recurrence evidence in the same repository", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const original = upsertImprovementProposal(db, path, seed());
      const updated = upsertImprovementProposal(db, path, {
        ...seed(), source_asset_ids: [...seed().source_asset_ids, "asset_3"],
        rationale: "One more recurrence was observed.", status: "draft",
      });
      expect(updated.source_asset_ids).toEqual(["asset_1", "asset_2", "asset_3"]);
      expect(updated.created_at).toBe(original.created_at);
      expect(updated.status).toBe("draft");
      expect(upsertImprovementProposal(db, path, updated)).toEqual(updated);
    } finally {
      db.close();
    }
  });

  it.each([
    { source_asset_ids: ["asset_1"] },
    { source_asset_ids: ["asset_1", "asset_3"] },
    { source_asset_ids: ["asset_1", "asset_2", "asset_3"], repo_id: "other-repo" },
    { source_asset_ids: ["asset_1", "asset_2", "asset_3"], target: "other-target" },
    { source_asset_ids: ["asset_1", "asset_2", "asset_3"], status: "approved" as const },
  ])("rejects legacy draft evidence replacement or identity changes: %j", (change) => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const original = upsertImprovementProposal(db, path, seed());
      expect(() => upsertImprovementProposal(db, path, { ...seed(), ...change })).toThrow(/proposal.*conflict/i);
      expect(listImprovementProposals(db)).toEqual([original]);
    } finally {
      db.close();
    }
  });

  it.each([
    { proposal_id: "prop_v2_content_bound", status: "draft" as const },
    { proposal_id: "prop_1", status: "approved" as const },
    { proposal_id: "prop_1", status: "rejected" as const },
  ])("preserves immutable sources after v2 generation or review: %j", (identity) => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const original = upsertImprovementProposal(db, path, { ...seed(), ...identity });
      expect(() => upsertImprovementProposal(db, path, {
        ...seed(), ...identity, source_asset_ids: [...seed().source_asset_ids, "asset_3"],
      })).toThrow(/proposal.*conflict/i);
      expect(listImprovementProposals(db)).toEqual([original]);
    } finally {
      db.close();
    }
  });
});
