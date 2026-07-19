import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkKnowledgeHygieneV2 } from "./engine-v2.js";

async function fixtureRepo(ignoreManagedBlock = false): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-v2-"));
  await mkdir(join(repoRoot, ".osstack"));
  await writeFile(join(repoRoot, ".osstack", "neat.yaml"), `
version: 2
instructions:
  canonical: AGENTS.md
${ignoreManagedBlock ? `ignore:
  - rule_id: rulebook.managed_context_block
    paths: [AGENTS.md]
    reason: fixture exception
` : ""}`);
  await writeFile(join(repoRoot, "AGENTS.md"), `# Instructions

Keep durable rules concise.

<claude-mem-context>
Session summary that must not be here.
</claude-mem-context>
`);
  return repoRoot;
}

describe("checkKnowledgeHygieneV2", () => {
  it("emits evidence-bound U0 findings and honest six-dimension coverage", async () => {
    const repoRoot = await fixtureRepo();
    const report = await checkKnowledgeHygieneV2({
      schema_version: "2",
      repo_root: repoRoot,
      mode: "all",
    }, {
      v1: {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        repo_identity: () => "repo-1",
      },
    });

    expect(report.schema_version).toBe("2");
    expect(report).toHaveProperty("assessment_scope.selected_rule_ids");
    expect(report.findings).toEqual([
      expect.objectContaining({
        rule_id: "rulebook.managed_context_block",
        origin: "mechanical",
        dimension: "narrative",
        closure_policy: "mechanical_sufficient",
        location: expect.objectContaining({
          kind: "repository",
          repo_id: "repo-1",
          path: "AGENTS.md",
          line: 5,
        }),
        citations: [expect.objectContaining({
          start_line: 5,
          end_line: 7,
          excerpt: expect.stringContaining("Session summary"),
        })],
      }),
    ]);
    expect(report.coverage.map((entry) => [entry.dimension, entry.state]))
      .toEqual([
        ["mechanical", "complete"],
        ["narrative", "partial"],
        ["contradiction", "not_assessed"],
        ["drift", "not_assessed"],
        ["memory_overlap", "not_assessed"],
        ["cross_repository", "partial"],
      ]);
    expect(report.health_claim).toBe("findings_present");
  });

  it("applies V2-only config suppression without leaking it into V1", async () => {
    const repoRoot = await fixtureRepo(true);
    const report = await checkKnowledgeHygieneV2({
      schema_version: "2",
      repo_root: repoRoot,
      mode: "all",
    }, {
      v1: {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        repo_identity: () => "repo-1",
      },
    });

    expect(report.findings).toEqual([]);
    expect(report.summary.suppressed).toBe(1);
    expect(report.health_claim).toBe("assessed_scope_clean");
  });

  it("does not claim narrative assessment when only a V1 rule was selected", async () => {
    const repoRoot = await fixtureRepo();
    const report = await checkKnowledgeHygieneV2({
      schema_version: "2",
      repo_root: repoRoot,
      mode: "all",
      checks: ["budget.warn_exceeded"],
    });

    expect(report.findings).toEqual([]);
    expect(report.coverage[1]).toMatchObject({
      dimension: "narrative",
      state: "not_assessed",
      reason_codes: ["not_requested"],
    });
    expect(report).toMatchObject({
      assessment_scope: { selected_rule_ids: ["budget.warn_exceeded"] },
    });
  });

  it("represents an incomplete whole-repository scan without inventing a path", async () => {
    const repoRoot = await fixtureRepo();
    const report = await checkKnowledgeHygieneV2({
      schema_version: "2",
      repo_root: repoRoot,
      mode: "all",
      checks: ["scan.incomplete"],
    }, {
      v1: {
        repo_identity: () => "repo-1",
        adapters: [],
        inventory: async () => ({
          surfaces: [],
          completeness: {
            complete: false,
            skipped_files: 1,
            reasons: ["fixture scan limit"],
          },
        }),
      },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        rule_id: "scan.incomplete",
        location: { kind: "repository_scope", repo_id: "repo-1" },
      }),
    ]);
    expect(report.coverage[0]).toMatchObject({
      dimension: "mechanical",
      state: "failed",
      reason_codes: ["scan_incomplete"],
    });
  });

  it("emits review_due for expired declared dependencies without mutating config", async () => {
    const repoRoot = await fixtureRepo();
    await writeFile(join(repoRoot, ".osstack", "neat.yaml"), `
version: 2
instructions:
  canonical: AGENTS.md
dependencies:
  - edge_id: khe_${"a".repeat(64)}
    upstream_repo_id: upstream
    direction: depends_on
    kinds: [api]
    owner: platform-owner
    evidence_refs:
      - kind: obligation
        ref: kho_fixture
        sha256: ${"b".repeat(64)}
    confirmed_at: 2026-06-01T00:00:00.000Z
    review_after: 2026-07-01T00:00:00.000Z
`);
    const report = await checkKnowledgeHygieneV2({
      schema_version: "2",
      repo_root: repoRoot,
      mode: "all",
      checks: ["dependency.review_due"],
    }, {
      v1: {
        now: () => new Date("2026-07-18T00:00:00.000Z"),
        repo_identity: () => "downstream",
      },
    });

    expect(report.findings).toEqual([
      expect.objectContaining({
        rule_id: "dependency.review_due",
        dimension: "cross_repository",
        location: expect.objectContaining({
          kind: "registry",
          edge_id: `khe_${"a".repeat(64)}`,
        }),
      }),
    ]);
    expect(report.coverage[5]).toMatchObject({
      dimension: "cross_repository",
      state: "partial",
      source_units_total: 1,
      candidates_generated: 1,
      candidates_assessed: 1,
    });
  });
});
