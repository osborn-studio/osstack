import { describe, expect, it } from "vitest";
import { parseKnowledgeHygieneConfigV1 } from "../config.js";
import {
  KnowledgeHygieneChangeSetV1,
  KnowledgeSurfaceInventoryV1,
} from "../types.js";
import { CHANGE_CONTRACT_RULE_V1 } from "./change-contract-rule.js";

function config(enforcement: "advisory" | "required" = "advisory") {
  return parseKnowledgeHygieneConfigV1(`
version: 1
contracts:
  - id: cli-public-surface
    when:
      any_path: [packages/cli/src/**]
    review:
      any_path: [README.md, docs/inventory/CLI_COMMANDS.md]
    enforcement: ${enforcement}
`);
}

function changeSet(paths: string[]) {
  return KnowledgeHygieneChangeSetV1.parse({
    schema_version: "1",
    repo_root: "/repo",
    mode: "range",
    base_ref: "main",
    base_sha: "a".repeat(40),
    head_ref: "HEAD",
    head_sha: "b".repeat(40),
    changes: paths.map((path) => ({ path, status: "modified" })),
    changed_paths: [...paths].sort(),
    diff_id: `diff_${"c".repeat(64)}`,
  });
}

const emptyInventory = KnowledgeSurfaceInventoryV1.parse({
  surfaces: [],
  completeness: { complete: true, skipped_files: 0, reasons: [] },
});

function evaluate(paths: string[], enforcement?: "advisory" | "required") {
  return CHANGE_CONTRACT_RULE_V1.evaluate({
    repo_identity: "repo-1",
    config: config(enforcement),
    inventory: emptyInventory,
    instruction_observations: [],
    change_set: changeSet(paths),
  });
}

describe("change review contract rule", () => {
  it("emits nothing when the contract is not triggered", () => {
    expect(evaluate(["packages/core/src/index.ts"])).toEqual([]);
  });

  it("emits nothing when a declared review target changed", () => {
    expect(evaluate([
      "packages/cli/src/bin.ts",
      "docs/inventory/CLI_COMMANDS.md",
    ])).toEqual([]);
  });

  it("emits an advisory warning with trigger and candidate evidence", () => {
    const findings = evaluate([
      "packages/cli/src/bin.ts",
      "packages/cli/src/neat-command.ts",
    ]);

    expect(findings).toEqual([
      expect.objectContaining({
        rule_id: "contract.review_required",
        severity: "warning",
        confidence: "medium",
        observed: expect.objectContaining({
          contract_id: "cli-public-surface",
          triggering_paths: [
            "packages/cli/src/bin.ts",
            "packages/cli/src/neat-command.ts",
          ],
        }),
        expected: expect.objectContaining({
          review_any_path: ["README.md", "docs/inventory/CLI_COMMANDS.md"],
        }),
        evidence_refs: [
          { kind: "proof", ref: "packages/cli/src/bin.ts" },
          { kind: "proof", ref: "packages/cli/src/neat-command.ts" },
          { kind: "external", ref: "README.md" },
          { kind: "external", ref: "docs/inventory/CLI_COMMANDS.md" },
        ],
        remediation: { mode: "human_decision" },
      }),
    ]);
  });

  it("turns required enforcement into an error requiring an edit", () => {
    expect(evaluate(["packages/cli/src/bin.ts"], "required")).toEqual([
      expect.objectContaining({
        severity: "error",
        remediation: { mode: "agent_edit" },
      }),
    ]);
  });
});
