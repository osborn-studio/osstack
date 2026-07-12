import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApprovalDecision, ApprovalRequest } from "@osstack/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getContractApproval,
  getContractApprovalByContract,
  insertContractApproval,
  reopenContractApproval,
  resolveContractApproval,
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

  it("resolves to approved with the deciding actor, then reopen returns it to pending", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      seed(db, path);
      const approved = resolveContractApproval(db, path, "ap_1", {
        status: "approved",
        decided_by_type: "human",
        decided_by_id: "owner",
        decided_at: 1_700_000_100,
        reason: "looks good",
      });
      expect(approved.status).toBe("approved");
      expect(approved.decided_by_type).toBe("human");
      expect(approved.reason).toBe("looks good");

      const reopened = reopenContractApproval(db, path, "ap_1", "tighten scope");
      expect(reopened.status).toBe("pending");
      expect(reopened.decided_by_type).toBeNull();
      expect(reopened.decided_at).toBeNull();
      expect(reopened.reason).toBe("tighten scope");
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

  it("returns undefined decision while pending; a strict ApprovalDecision once resolved", () => {
    const path = join(tmp, "state.db");
    const db = openDb({ path });
    try {
      const pending = seed(db, path);
      expect(contractApprovalRowToDecision(pending)).toBeUndefined();

      const approved = resolveContractApproval(db, path, "ap_1", {
        status: "approved",
        decided_by_type: "human",
        decided_by_id: "owner",
        decided_at: 1_700_000_100,
      });
      const decision = contractApprovalRowToDecision(approved);
      expect(decision).toBeDefined();
      expect(() => ApprovalDecision.parse(decision)).not.toThrow();
      expect(decision!.approved).toBe(true);
      expect(decision!.decided_by).toEqual({ type: "human", id: "owner" });

      const stopped = resolveContractApproval(db, path, "ap_1", {
        status: "stopped",
        decided_by_type: "human",
        decided_by_id: "owner",
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
