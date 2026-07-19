import { describe, expect, it } from "vitest";
import {
  KnowledgeHygieneConfigV2Schema,
  parseKnowledgeHygieneConfigV2,
  projectKnowledgeHygieneConfigV1ToV2,
} from "./config-v2.js";
import { parseKnowledgeHygieneConfigV1 } from "./config.js";

const sha = "a".repeat(64);

describe("KnowledgeHygieneConfigV2", () => {
  it("parses strict V2 config and applies the frozen semantic defaults", () => {
    expect(parseKnowledgeHygieneConfigV2(`
version: 2
instructions:
  canonical: AGENTS.md
semantic:
  enabled: true
  judge_id: anthropic-no-tools
dependencies:
  - edge_id: khe_${sha}
    upstream_repo_id: shared-api
    direction: depends_on
    kinds: [api, symbol]
    owner: platform
    evidence_refs:
      - kind: obligation
        ref: registry/edge-1
        sha256: ${sha}
    confirmed_at: 2026-07-18T00:00:00.000Z
    review_after: 2026-08-18T00:00:00.000Z
`)).toMatchObject({
      version: 2,
      semantic: {
        enabled: true,
        judge_id: "anthropic-no-tools",
        dimensions: ["narrative"],
        schedule: "manual",
        max_input_tokens: 32_000,
        max_output_tokens: 4_000,
        max_calls: 8,
      },
      dependencies: [{
        edge_id: `khe_${sha}`,
        kinds: ["api", "symbol"],
      }],
    });
  });

  it("projects V1 without inventing enabled semantic work", () => {
    const v1 = parseKnowledgeHygieneConfigV1(`
version: 1
ignore:
  - rule_id: scan.incomplete
    paths: [docs/**]
    reason: generated
`);
    expect(projectKnowledgeHygieneConfigV1ToV2(v1)).toEqual({
      version: 2,
      required_surfaces: [],
      budgets: [],
      contracts: [],
      ignore: [{
        rule_id: "scan.incomplete",
        paths: ["docs/**"],
        reason: "generated",
      }],
      semantic: {
        enabled: false,
        dimensions: ["narrative"],
        schedule: "manual",
        max_input_tokens: 32_000,
        max_output_tokens: 4_000,
        max_calls: 8,
      },
      dependencies: [],
    });
  });

  it.each([
    ["enabled without judge", { version: 2, semantic: { enabled: true } }],
    [
      "disabled with judge",
      { version: 2, semantic: { enabled: false, judge_id: "judge" } },
    ],
    [
      "daily multi-dimension",
      {
        version: 2,
        semantic: {
          enabled: true,
          judge_id: "judge",
          schedule: "daily",
          dimensions: ["narrative", "drift"],
        },
      },
    ],
    [
      "duplicate dependency",
      {
        version: 2,
        dependencies: [
          {
            edge_id: `khe_${sha}`,
            upstream_repo_id: "a",
            direction: "depends_on",
            kinds: ["api"],
            owner: "owner",
            evidence_refs: [{
              kind: "obligation",
              ref: "one",
              sha256: sha,
            }],
            confirmed_at: "2026-07-18T00:00:00.000Z",
            review_after: "2026-08-18T00:00:00.000Z",
          },
          {
            edge_id: `khe_${sha}`,
            upstream_repo_id: "b",
            direction: "depends_on",
            kinds: ["api"],
            owner: "owner",
            evidence_refs: [{
              kind: "obligation",
              ref: "two",
              sha256: sha,
            }],
            confirmed_at: "2026-07-18T00:00:00.000Z",
            review_after: "2026-08-18T00:00:00.000Z",
          },
        ],
      },
    ],
    [
      "backwards review date",
      {
        version: 2,
        dependencies: [{
          edge_id: `khe_${sha}`,
          upstream_repo_id: "a",
          direction: "depends_on",
          kinds: ["api"],
          owner: "owner",
          evidence_refs: [{ kind: "obligation", ref: "one", sha256: sha }],
          confirmed_at: "2026-08-18T00:00:00.000Z",
          review_after: "2026-07-18T00:00:00.000Z",
        }],
      },
    ],
    ["unknown field", { version: 2, permissive: true }],
  ])("rejects %s", (_label, value) => {
    expect(KnowledgeHygieneConfigV2Schema.safeParse(value).success).toBe(false);
  });
});
