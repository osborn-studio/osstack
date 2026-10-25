// Schema-generation drift guard: the committed schemas/*.schema.json MUST equal
// what the Zod source of truth produces right now. Regenerating produces zero
// diff — the same generateAll() runs here (against src) and in
// scripts/generate-schemas.mjs (against dist).

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateAll } from "./generate.js";

const SCHEMAS_DIR = fileURLToPath(new URL("../schemas", import.meta.url));

describe("generated JSON Schemas are committed and fresh", () => {
  const expected = generateAll();
  const filenames = Object.keys(expected).sort();

  it("emits one schema per public protocol contract", () => {
    expect(filenames).toEqual(
      [
        "agent-command-result.schema.json",
        "agent-command.schema.json",
        "approval-decision.schema.json",
        "approval-request.schema.json",
        "attention-inbox.schema.json",
        "attention-status.schema.json",
        "autonomy-risk-decision.schema.json",
        "autonomy-risk-level.schema.json",
        "autonomy-run-state.schema.json",
        "continuation-grant-body.schema.json",
        "continuation-output-check.schema.json",
        "follow-up-create-params.schema.json",
        "follow-up-draft-params.schema.json",
        "follow-up-list-params.schema.json",
        "follow-up-list-result.schema.json",
        "follow-up-mutation-result.schema.json",
        "follow-up-obligation.schema.json",
        "follow-up-resolve-params.schema.json",
        "delivery-contract-v2.schema.json",
        "frozen-delivery-contract-v2.schema.json",
        "delivery-verification-receipt-v2.schema.json",
        "engineering-adopt-request.schema.json",
        "engineering-answer.schema.json",
        "engineering-cancel-request.schema.json",
        "engineering-decide-request.schema.json",
        "engineering-decision-ref.schema.json",
        "engineering-defer-request.schema.json",
        "engineering-end-observation-request.schema.json",
        "engineering-observe-request.schema.json",
        "engineering-reconcile-request.schema.json",
        "event-envelope.schema.json",
        "evidence-ref.schema.json",
        "graph-checkpoint-request.schema.json",
        "graph-checkpoint-response.schema.json",
        "graph.schema.json",
        "graph-worker.schema.json",
        "policy-decision.schema.json",
        "run-summary.schema.json",
        "scoped-approval-decision.schema.json",
        "scoped-approval-request.schema.json",
        "session-continuation-request.schema.json",
        "session-decision.schema.json",
        "signed-continuation-grant.schema.json",
        "task.schema.json",
      ].sort(),
    );
  });

  for (const filename of filenames) {
    it(`schemas/${filename} matches the Zod source (zero drift)`, () => {
      const path = `${SCHEMAS_DIR}/${filename}`;
      expect(existsSync(path), `schemas/${filename} is not committed — run generate:schemas`).toBe(
        true,
      );
      expect(readFileSync(path, "utf-8")).toBe(expected[filename]);
    });
  }
});
