import { createHash } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { SemanticJudgePort } from "./semantic-judge.js";
import { auditKnowledgeHygieneSemantics } from "./semantic-engine.js";
import { SemanticProviderError } from "./semantic-provider-error.js";

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

async function fourDimensionRepo(): Promise<{
  root: string;
  mirror: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "osstack-semantic-four-"));
  const memory = join(root, "explicit-memory");
  await mkdir(join(root, ".osstack"));
  await mkdir(memory);
  await writeFile(join(root, ".osstack", "neat.yaml"), `
version: 2
instructions:
  canonical: AGENTS.md
  mirrors:
    - path: CLAUDE.md
      mode: import
adapters:
  claude_code:
    enabled: true
    memory_dir: ${JSON.stringify(memory)}
`);
  await writeFile(join(root, "AGENTS.md"), `# Durable rules

Deployments must always use the release gate.
Deployments must never use the release gate.

<claude-mem-context>
ANTHROPIC_API_KEY=sk-ant-secret-value
</claude-mem-context>
`);
  const mirror = join(root, "CLAUDE.md");
  await writeFile(mirror, "# Drifted mirror\nDeployments should bypass the release gate.\n");
  await writeFile(join(memory, "alpha.md"), `# Release checklist

Use the release gate and verify the production smoke test.
`);
  await writeFile(join(memory, "beta.md"), `# Release checklist duplicate

Use the release gate and verify the production smoke test before shipping.
`);
  return { root, mirror };
}

function judge(options: { quoteMismatch?: boolean; fail?: boolean } = {}): SemanticJudgePort {
  return {
    id: "fake-no-tools",
    model_id: "fake-model",
    prompt_version: "1",
    supports_no_tools: true,
    async judge(input) {
      if (options.fail) throw new SemanticProviderError("request_timeout");
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
      provider_failure_code: "request_timeout",
    });
    expect(report.health_claim).toBe("assessment_incomplete");
  });

  it("builds bounded, redacted candidates for all four semantic dimensions", async () => {
    const fixture = await fourDimensionRepo();
    const seenPacks: string[] = [];
    const semanticJudge = judge();
    const report = await auditKnowledgeHygieneSemantics({
      repo_root: fixture.root,
      mode: "all",
      dimensions: ["narrative", "contradiction", "drift", "memory_overlap"],
      budget: { max_input_tokens: 20_000, max_output_tokens: 4_000, max_calls: 16 },
    }, {
      judge: {
        ...semanticJudge,
        async judge(input, signal) {
          seenPacks.push(JSON.stringify(input.evidence_pack));
          return semanticJudge.judge(input, signal);
        },
      },
      v2: { v1: { repo_identity: () => "repo-four" } },
    });

    expect(report.findings.map((finding) => finding.rule_id)).toEqual(
      expect.arrayContaining([
        "semantic.narrative",
        "semantic.contradiction",
        "semantic.drift",
        "semantic.memory_overlap",
      ]),
    );
    for (const dimension of [
      "narrative",
      "contradiction",
      "drift",
      "memory_overlap",
    ]) {
      expect(report.coverage).toContainEqual(expect.objectContaining({
        dimension,
        state: "partial",
        candidates_generated: expect.any(Number),
      }));
      expect(report.coverage.find((entry) => entry.dimension === dimension)
        ?.candidates_generated).toBeGreaterThan(0);
    }
    expect(seenPacks.join("\n")).not.toContain("sk-ant-secret-value");
    expect(report.coverage.filter((entry) =>
      ["narrative", "contradiction", "drift", "memory_overlap"].includes(
        entry.dimension,
      )
    ).reduce((sum, entry) => sum + entry.candidates_assessed, 0)).toBeLessThanOrEqual(16);
  });

  it("reuses a compound cache key but invalidates when the paired mirror changes", async () => {
    const fixture = await fourDimensionRepo();
    const cache = new Map<string, unknown>();
    let calls = 0;
    const baseJudge = judge();
    const ports = {
      judge: {
        ...baseJudge,
        async judge(input: Parameters<SemanticJudgePort["judge"]>[0], signal: AbortSignal) {
          calls += 1;
          return baseJudge.judge(input, signal);
        },
      },
      decision_cache: {
        read: async (key: string) => cache.get(key),
        write: async (key: string, value: unknown) => {
          cache.set(key, value);
        },
      },
      v2: { v1: { repo_identity: () => "repo-cache" } },
    };
    const input = {
      repo_root: fixture.root,
      mode: "all" as const,
      dimensions: ["drift" as const],
      budget: { max_input_tokens: 10_000, max_output_tokens: 2_000, max_calls: 4 },
    };

    await auditKnowledgeHygieneSemantics(input, ports);
    expect(calls).toBe(1);
    await auditKnowledgeHygieneSemantics(input, ports);
    expect(calls).toBe(1);

    await writeFile(
      fixture.mirror,
      "# Drifted mirror\nDeployments must bypass every release gate.\n",
    );
    await auditKnowledgeHygieneSemantics(input, ports);
    expect(calls).toBe(2);
  });
});
