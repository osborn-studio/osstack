import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import { listFeedbackAssets, upsertFeedbackAsset } from "./feedback-assets.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-assets-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

function seed() {
  return {
    asset_id: "asset_1",
    repo_id: "stock-monitor",
    source_trace_id: "trace_1",
    kind: "eval_case",
    failure_family: "bad_reasoning",
    summary: "Confidence miscalibrated.",
    evidence: ["expected lower confidence"],
  };
}

describe("feedback assets persistence", () => {
  it("inserts and lists an asset, parsing evidence back into an array", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const view = upsertFeedbackAsset(db, path, seed());
      expect(view.status).toBe("proposed");
      expect(view.evidence).toEqual(["expected lower confidence"]);
      expect(view.source_trace_id).toBe("trace_1");
      const listed = listFeedbackAssets(db, { repo_id: "stock-monitor" });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.evidence).toEqual(["expected lower confidence"]);
    } finally {
      db.close();
    }
  });

  it("upserts by asset_id (updates status, preserves created_at) and filters by status", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const first = upsertFeedbackAsset(db, path, seed());
      const updated = upsertFeedbackAsset(db, path, { ...seed(), status: "accepted", summary: "Now accepted." });
      expect(updated.status).toBe("accepted");
      expect(updated.summary).toBe("Now accepted.");
      expect(updated.created_at).toBe(first.created_at);
      expect(listFeedbackAssets(db, { status: "proposed" })).toEqual([]);
      expect(listFeedbackAssets(db, { status: "accepted" })).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
