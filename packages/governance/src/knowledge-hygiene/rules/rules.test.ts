import { describe, expect, it } from "vitest";
import { parseKnowledgeHygieneConfigV1 } from "../config.js";
import type { InstructionSourceObservationV1 } from "../instruction-source.js";
import {
  KnowledgeSurfaceInventoryV1,
  type KnowledgeSurfaceInventoryV1 as KnowledgeSurfaceInventory,
} from "../types.js";
import {
  createKnowledgeHygieneRuleRegistry,
  evaluateKnowledgeHygieneRules,
  filterSuppressedKnowledgeHygieneFindings,
  KNOWLEDGE_HYGIENE_RULES_V1,
} from "./index.js";

function inventory(
  surfaces: KnowledgeSurfaceInventory["surfaces"],
  complete = true,
): KnowledgeSurfaceInventory {
  return KnowledgeSurfaceInventoryV1.parse({
    surfaces,
    completeness: {
      complete,
      skipped_files: complete ? 0 : 1,
      reasons: complete ? [] : ["file byte limit exceeded: AGENTS.md"],
    },
  });
}

function evaluate(input: {
  config?: ReturnType<typeof parseKnowledgeHygieneConfigV1>;
  surfaces?: KnowledgeSurfaceInventory["surfaces"];
  observations?: InstructionSourceObservationV1[];
  complete?: boolean;
}) {
  return evaluateKnowledgeHygieneRules({
    repo_identity: "repo-1",
    config: input.config,
    inventory: inventory(input.surfaces ?? [], input.complete ?? true),
    instruction_observations: input.observations ?? [],
    reference_observations: [],
    change_set: undefined,
  });
}

describe("knowledge hygiene foundation rules", () => {
  it("emits configured canonical, mirror, and drift findings with remediation", () => {
    const config = parseKnowledgeHygieneConfigV1(`
version: 1
instructions:
  canonical: AGENTS.md
  mirrors:
    - { path: CLAUDE.md, mode: import_or_symlink }
    - { path: OTHER.md, mode: symlink }
`);
    const findings = evaluate({
      config,
      surfaces: [{
        surface: "instruction",
        path: "AGENTS.md",
        kind: "file",
        exists: false,
      }],
      observations: [
        {
          status: "mirror_missing",
          canonical_path: "AGENTS.md",
          mirror_path: "CLAUDE.md",
        },
        {
          status: "mirror_drift",
          canonical_path: "AGENTS.md",
          mirror_path: "OTHER.md",
          reason: "OTHER.md must be a symlink to AGENTS.md",
        },
      ],
    });

    expect(findings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        rule_id: "instruction.canonical_missing",
        severity: "error",
        remediation: { mode: "agent_edit" },
      }),
      expect.objectContaining({
        rule_id: "instruction.mirror_missing",
        location: expect.objectContaining({ path: "CLAUDE.md" }),
        remediation: expect.objectContaining({ mode: "safe_patch" }),
      }),
      expect.objectContaining({
        rule_id: "instruction.mirror_drift",
        location: expect.objectContaining({ path: "OTHER.md" }),
        severity: "error",
        remediation: { mode: "human_decision" },
      }),
    ]));
  });

  it("does not invent required surfaces or budgets in zero-config mode", () => {
    const findings = evaluate({
      surfaces: [{
        surface: "instruction",
        path: "AGENTS.md",
        kind: "file",
        exists: true,
        bytes: 50_000,
        lines: 1_000,
      }],
    });

    expect(findings).toEqual([]);
  });

  it("reports zero-config independent instruction drift as a warning", () => {
    const findings = evaluate({
      observations: [{
        status: "mirror_drift",
        canonical_path: "AGENTS.md",
        mirror_path: "CLAUDE.md",
        reason: "CLAUDE.md content is not exactly @AGENTS.md",
      }],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        rule_id: "instruction.mirror_drift",
        severity: "warning",
      }),
    ]);
  });

  it("uses configured severity for missing surfaces and validates kind", () => {
    const config = parseKnowledgeHygieneConfigV1(`
version: 1
required_surfaces:
  - { id: decisions, path: docs/decisions, kind: directory, severity: info }
`);

    const findings = evaluate({
      config,
      surfaces: [{
        surface: "documentation",
        path: "docs/decisions",
        kind: "file",
        exists: true,
      }],
    });

    expect(findings).toEqual([
      expect.objectContaining({
        rule_id: "surface.required_missing",
        severity: "info",
        expected: expect.objectContaining({ kind: "directory" }),
      }),
    ]);
  });

  it("emits only the highest exceeded budget threshold and respects equality", () => {
    const config = parseKnowledgeHygieneConfigV1(`
version: 1
budgets:
  - id: agents
    path: AGENTS.md
    warn: { lines: 10, bytes: 100 }
    error: { lines: 20, bytes: 200 }
`);
    const atBoundary = evaluate({
      config,
      surfaces: [{
        surface: "instruction",
        path: "AGENTS.md",
        kind: "file",
        exists: true,
        lines: 20,
        bytes: 200,
      }],
    });
    const exceeded = evaluate({
      config,
      surfaces: [{
        surface: "instruction",
        path: "AGENTS.md",
        kind: "file",
        exists: true,
        lines: 21,
        bytes: 201,
        sha256: "a".repeat(64),
      }],
    });

    expect(atBoundary).toEqual([
      expect.objectContaining({ rule_id: "budget.warn_exceeded" }),
    ]);
    expect(exceeded).toEqual([
      expect.objectContaining({
        rule_id: "budget.error_exceeded",
        severity: "error",
        evidence_refs: [{
          kind: "proof",
          ref: "AGENTS.md",
          sha256: "a".repeat(64),
        }],
      }),
    ]);
  });

  it("turns incomplete inventory into a scan finding", () => {
    const findings = evaluate({ complete: false });

    expect(findings).toEqual([
      expect.objectContaining({
        rule_id: "scan.incomplete",
        severity: "error",
        observed: expect.objectContaining({ skipped_files: 1 }),
      }),
    ]);
  });

  it("separates explicitly suppressed findings and retains the reason", () => {
    const config = parseKnowledgeHygieneConfigV1(`
version: 1
required_surfaces:
  - { id: guide, path: docs/guide.md, severity: warning }
ignore:
  - rule_id: surface.required_missing
    paths: [docs/**]
    reason: generated during release
`);
    const findings = evaluate({ config });

    expect(filterSuppressedKnowledgeHygieneFindings(findings, config)).toEqual({
      active: [],
      suppressed: [{
        finding: expect.objectContaining({ rule_id: "surface.required_missing" }),
        reason: "generated during release",
      }],
    });
  });
});

describe("knowledge hygiene rule registry", () => {
  it("contains every closed v1 rule id exactly once and is frozen", () => {
    expect(KNOWLEDGE_HYGIENE_RULES_V1.map((rule) => rule.id)).toEqual([
      "instruction.canonical_missing",
      "instruction.mirror_missing",
      "instruction.mirror_drift",
      "surface.required_missing",
      "budget.warn_exceeded",
      "budget.error_exceeded",
      "reference.markdown_target_missing",
      "reference.instruction_import_missing",
      "contract.review_required",
      "memory.platform_limit_exceeded",
      "scan.incomplete",
    ]);
    expect(Object.isFrozen(KNOWLEDGE_HYGIENE_RULES_V1)).toBe(true);
  });

  it("rejects duplicate rule ids", () => {
    const rule = KNOWLEDGE_HYGIENE_RULES_V1[0];
    if (!rule) throw new Error("foundation rule missing");

    expect(() => createKnowledgeHygieneRuleRegistry([rule, rule])).toThrow(
      /duplicate rule id/i,
    );
  });
});
