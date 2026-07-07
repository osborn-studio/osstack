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
});
