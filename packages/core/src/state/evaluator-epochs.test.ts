import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db.js";
import {
  closeEvaluatorEpoch,
  createEvaluatorEpoch,
  insertScoreQuarantine,
  listAnchorCases,
  listEvaluatorVersions,
  listScoreQuarantine,
  upsertAnchorCase,
  upsertEvaluatorVersion,
} from "./evaluator-epochs.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "osstack-evaluator-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("evaluator versions persistence", () => {
  it("upserts and lists frozen evaluators", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      upsertEvaluatorVersion(db, path, {
        evaluator_id: "eval_v1",
        repo_id: "stock-monitor",
        kind: "llm_judge",
        version: "1",
        title: "Memo judge",
        rubric: "Reject overconfident calls.",
        status: "frozen",
      });
      const frozen = listEvaluatorVersions(db, { repo_id: "stock-monitor", status: "frozen" });
      expect(frozen).toHaveLength(1);
      expect(frozen[0]?.evaluator_id).toBe("eval_v1");
    } finally {
      db.close();
    }
  });
});

describe("anchor cases persistence", () => {
  it("coerces the adversarial boolean through SQLite integer storage and filters on it", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      upsertAnchorCase(db, path, {
        case_id: "anchor_1",
        repo_id: "stock-monitor",
        source_trace_id: "trace_1",
        input_summary: "Overconfident buy before drawdown.",
        expected_verdict: "reject",
        evidence_refs: ["human: reject"],
        adversarial: true,
      });
      upsertAnchorCase(db, path, {
        case_id: "anchor_2",
        repo_id: "stock-monitor",
        input_summary: "Well-supported call.",
        expected_verdict: "accept",
        evidence_refs: [],
        adversarial: false,
      });
      const adversarial = listAnchorCases(db, { repo_id: "stock-monitor", adversarial: true });
      expect(adversarial).toHaveLength(1);
      expect(adversarial[0]?.adversarial).toBe(true);
      expect(adversarial[0]?.evidence_refs).toEqual(["human: reject"]);
      expect(listAnchorCases(db, { repo_id: "stock-monitor", adversarial: false })).toHaveLength(1);
    } finally {
      db.close();
    }
  });
});

describe("evaluator epochs persistence", () => {
  it("creates an open epoch and closes it with a promotion decision", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const epoch = createEvaluatorEpoch(db, path, {
        epoch_id: "epoch_1",
        repo_id: "stock-monitor",
        frozen_evaluator_id: "eval_v1",
        anchor_case_ids: ["anchor_1"],
        challenger_evaluator_ids: ["eval_v2"],
      });
      expect(epoch.ended_at).toBeNull();
      expect(epoch.promotion_decision).toBeNull();
      expect(epoch.anchor_case_ids).toEqual(["anchor_1"]);

      const closed = closeEvaluatorEpoch(db, path, "epoch_1", {
        promoted: true,
        promoted_evaluator_id: "eval_v2",
        reason: "beat incumbent",
        anchor_accuracy_delta: 0.1,
      });
      expect(closed?.ended_at).not.toBeNull();
      expect(closed?.promotion_decision).toMatchObject({ promoted: true, promoted_evaluator_id: "eval_v2" });
    } finally {
      db.close();
    }
  });
});

describe("score quarantine persistence", () => {
  it("records and lists quarantined scores by evaluator", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      insertScoreQuarantine(db, path, {
        quarantine_id: "q1",
        repo_id: "stock-monitor",
        score_id: "s1",
        evaluator_id: "eval_v1",
        reason: "evaluator eval_v1 was displaced",
      });
      const listed = listScoreQuarantine(db, { evaluator_id: "eval_v1" });
      expect(listed).toHaveLength(1);
      expect(listed[0]?.score_id).toBe("s1");
    } finally {
      db.close();
    }
  });
});
