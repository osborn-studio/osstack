import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalDecision, ApprovalRequest } from "@osstack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getContractApproval,
  getContractApprovalByContract,
  insertContractApproval,
  listContractDecisions,
  recordContractDecision,
} from "./contract-approvals.js";
import { openDb } from "./db.js";
import { contractApprovalRowToDecision, contractApprovalRowToRequest } from "./protocol-mappers.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-contract-approvals-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(db: ReturnType<typeof openDb>, path: string) {
  return insertContractApproval(db, path, {
    approval_id: "ap_1",
    contract_id: "ct_1",
    action: "start: Add billing dashboard",
    risk: "medium",
    requested_at: 1_700_000_000,
  });
}

describe("contract approvals persistence", () => {
  it("inserts a pending request and reads it back by contract and by id", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const inserted = seed(db, path);
      expect(inserted.status).toBe("pending");
      expect(getContractApprovalByContract(db, "ct_1")?.approval_id).toBe("ap_1");
      expect(getContractApproval(db, "ap_1")?.contract_id).toBe("ct_1");
      expect(getContractApprovalByContract(db, "missing")).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("walks the full lifecycle via recordContractDecision, appending an immutable trail", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      seed(db, path);

      const approved = recordContractDecision(db, path, {
        approval_id: "ap_1",
        contract_id: "ct_1",
        action: "approve",
        actor_type: "human",
        actor_id: "owner",
        decided_at: 1_700_000_100,
        reason: "looks good",
        decision_id: "cd_1",
      });
      expect(approved.status).toBe("approved");
      expect(approved.decided_by_type).toBe("human");
      expect(approved.reason).toBe("looks good");

      const revising = recordContractDecision(db, path, {
        approval_id: "ap_1",
        contract_id: "ct_1",
        action: "revise",
        actor_type: "human",
        actor_id: "owner",
        decided_at: 1_700_000_200,
        reason: "tighten scope",
        decision_id: "cd_2",
      });
      expect(revising.status).toBe("revising");
      expect(revising.reason).toBe("tighten scope");

      const stopped = recordContractDecision(db, path, {
        approval_id: "ap_1",
        contract_id: "ct_1",
        action: "stop",
        actor_type: "human",
        actor_id: "owner",
        decided_at: 1_700_000_300,
        reason: "descoped",
        decision_id: "cd_3",
      });
      expect(stopped.status).toBe("stopped");

      // Append-only trail preserved in order, one row per decision.
      const trail = listContractDecisions(db, "ct_1");
      expect(trail.map((d) => d.action)).toEqual(["approve", "revise", "stop"]);
      expect(trail.map((d) => d.decision_id)).toEqual(["cd_1", "cd_2", "cd_3"]);
      expect(trail[1]!.reason).toBe("tighten scope");
      expect(listContractDecisions(db, "ct_other")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("contract approval protocol mappers", () => {
  it("maps a row to a protocol ApprovalRequest that parses strictly (no run_id)", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const row = seed(db, path);
      const request = contractApprovalRowToRequest(row);
      // Strict protocol parse — the R1.5 --json surfaces must validate.
      expect(() => ApprovalRequest.parse(request)).not.toThrow();
      expect(request.approval_id).toBe("ap_1");
      expect(request.run_id).toBeUndefined();
      expect(request.requested_at).toBe(new Date(1_700_000_000 * 1000).toISOString());
    } finally {
      db.close();
    }
  });

  it("returns undefined decision while pending or revising; a strict ApprovalDecision once approved/stopped", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const pending = seed(db, path);
      expect(contractApprovalRowToDecision(pending)).toBeUndefined();

      const approved = recordContractDecision(db, path, {
        approval_id: "ap_1",
        contract_id: "ct_1",
        action: "approve",
        actor_type: "human",
        actor_id: "owner",
        decided_at: 1_700_000_100,
      });
      const decision = contractApprovalRowToDecision(approved);
      expect(decision).toBeDefined();
      expect(() => ApprovalDecision.parse(decision)).not.toThrow();
      expect(decision!.approved).toBe(true);
      expect(decision!.decided_by).toEqual({ type: "human", id: "owner" });

      // A revise is not an approve/reject verdict — no protocol decision.
      const revising = recordContractDecision(db, path, {
        approval_id: "ap_1",
        contract_id: "ct_1",
        action: "revise",
        actor_type: "human",
        actor_id: "owner",
        decided_at: 1_700_000_150,
        reason: "edits needed",
      });
      expect(contractApprovalRowToDecision(revising)).toBeUndefined();

      const stopped = recordContractDecision(db, path, {
        approval_id: "ap_1",
        contract_id: "ct_1",
        action: "stop",
        actor_type: "human",
        actor_id: "owner",
        decided_at: 1_700_000_200,
        reason: "descoped",
      });
      const stopDecision = contractApprovalRowToDecision(stopped);
      expect(stopDecision!.approved).toBe(false);
      expect(stopDecision!.reason).toBe("descoped");
    } finally {
      db.close();
    }
  });
});
