import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SemanticJudgePort } from "./semantic-judge.js";
import { auditKnowledgeHygieneSemantics } from "./semantic-engine.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

async function repo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "osstack-semantic-engine-"));
  await mkdir(join(root, ".osstack"));
  await writeFile(join(root, ".osstack", "neat.yaml"), `
version: 2
instructions:
  canonical: AGENTS.md
`);
  await writeFile(join(root, "AGENTS.md"), `# Durable rules

<claude-mem-context>
Session summary from yesterday.
</claude-mem-context>
`);
  return root;
}

function judge(options: { quoteMismatch?: boolean; fail?: boolean } = {}): SemanticJudgePort {
  return {
    id: "fake-no-tools",
    model_id: "fake-model",
    prompt_version: "1",
    supports_no_tools: true,
    async judge(input) {
      if (options.fail) throw new Error("provider unavailable");
      const source = input.evidence_pack.sources[0];
      const excerpt = source?.excerpts[0];
      if (source === undefined || excerpt === undefined) {
        throw new Error("fixture expected evidence");
      }
      const text = options.quoteMismatch ? `${excerpt.text} changed` : excerpt.text;
      return {
        nonce: input.nonce,
        raw_output: {
          dimension: input.evidence_pack.dimension,
          verdict: "issue",
          confidence: "high",
          citations: [{
            source: source.source,
            blob_sha256: source.blob_sha256,
            start_line: excerpt.start_line,
            end_line: excerpt.end_line,
            text_sha256: digest(text),
            excerpt: text,
          }],
          rationale: "Transient session narrative is not a durable rule.",
          proposed_disposition: "move",
          closure_conditions: [],
        },
        usage: { input_tokens: 20, output_tokens: 20, calls: 1 },
      };
    },
  };
}

describe("auditKnowledgeHygieneSemantics", () => {
  it("turns a verified semantic decision into a citation-bound V2 finding", async () => {
    const root = await repo();
    const report = await auditKnowledgeHygieneSemantics({
      repo_root: root,
      mode: "all",
      dimensions: ["narrative"],
      budget: { max_input_tokens: 1000, max_output_tokens: 1000, max_calls: 2 },
    }, {
      judge: judge(),
      v2: { v1: { repo_identity: () => "repo-1" } },
    });

    expect(report.findings.map((finding) => finding.rule_id)).toContain(
      "semantic.narrative",
    );
    expect(report.findings.find((finding) => finding.rule_id === "semantic.narrative"))
      .toMatchObject({
        origin: "semantic",
        dimension: "narrative",
        closure_policy: "semantic_confirmation_required",
        citations: [expect.objectContaining({
          source: expect.objectContaining({ path: "AGENTS.md" }),
        })],
      });
    expect(report.coverage[1]).toMatchObject({
      dimension: "narrative",
      state: "partial",
      candidates_generated: 1,
      candidates_assessed: 1,
      candidates_skipped: 0,
    });
  });

  it("rejects quote mismatch before it becomes a finding", async () => {
    const root = await repo();
    const report = await auditKnowledgeHygieneSemantics({
      repo_root: root,
      mode: "all",
      dimensions: ["narrative"],
      budget: { max_input_tokens: 1000, max_output_tokens: 1000, max_calls: 2 },
    }, { judge: judge({ quoteMismatch: true }) });

    expect(report.findings.some((finding) => finding.rule_id === "semantic.narrative"))
      .toBe(false);
    expect(report.rejection_counts.quote_mismatch).toBe(1);
  });

  it("declares provider failure instead of returning a false clean result", async () => {
    const root = await repo();
    const report = await auditKnowledgeHygieneSemantics({
      repo_root: root,
      mode: "all",
      dimensions: ["narrative"],
      budget: { max_input_tokens: 1000, max_output_tokens: 1000, max_calls: 2 },
    }, { judge: judge({ fail: true }) });

    expect(report.coverage[1]).toMatchObject({
      dimension: "narrative",
      state: "failed",
      reason_codes: ["provider_error"],
    });
    expect(report.health_claim).toBe("assessment_incomplete");
  });
});
