import { describe, expect, it } from "vitest";
import {
  composeSemanticCacheKeyV1,
  redactSemanticEvidenceSourcesV1,
} from "./semantic-evidence.js";

const source = {
  source: {
    kind: "repository" as const,
    repo_id: "repo-1",
    path: "AGENTS.md",
  },
  blob_sha256: "a".repeat(64),
  excerpts: [{
    start_line: 1,
    end_line: 6,
    text: `Keep ANTHROPIC_API_KEY as an environment variable name.
ANTHROPIC_API_KEY=sk-ant-secret-value
\`\`\`env
PASSWORD: hunter2
GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz123456
\`\`\``,
  }],
};

const cacheInput = {
  evidence_pack_sha256: "1".repeat(64),
  candidate_index_sha256: "2".repeat(64),
  config_sha256: "3".repeat(64),
  rule_versions_sha256: "4".repeat(64),
  prompt_version: "1",
  output_schema_sha256: "5".repeat(64),
  model_id: "model-a",
  judge_id: "judge-a",
  budget: {
    max_input_tokens: 32_000,
    max_output_tokens: 4_000,
    max_calls: 8,
  },
  redactor_version: "1",
  associated_blob_sha256: ["6".repeat(64), "7".repeat(64)],
};

describe("semantic evidence utilities", () => {
  it("redacts secret values inside and outside code fences without removing names", () => {
    const redacted = redactSemanticEvidenceSourcesV1([source]);
    expect(redacted.redaction_count).toBe(3);
    expect(redacted.sources[0]?.excerpts[0]?.text).toContain("ANTHROPIC_API_KEY");
    expect(redacted.sources[0]?.excerpts[0]?.text).not.toContain(
      "sk-ant-secret-value",
    );
    expect(redacted.sources[0]?.excerpts[0]?.text).not.toContain("hunter2");
    expect(redacted.sources[0]?.excerpts[0]?.text).not.toContain("ghp_");
    expect(redactSemanticEvidenceSourcesV1([source])).toEqual(redacted);
  });

  it("produces a stable cache key and misses when any contract component changes", () => {
    const baseline = composeSemanticCacheKeyV1(cacheInput);
    expect(composeSemanticCacheKeyV1({
      ...cacheInput,
      associated_blob_sha256: [...cacheInput.associated_blob_sha256].reverse(),
    })).toBe(baseline);

    const mutations = [
      { evidence_pack_sha256: "8".repeat(64) },
      { candidate_index_sha256: "8".repeat(64) },
      { config_sha256: "8".repeat(64) },
      { rule_versions_sha256: "8".repeat(64) },
      { prompt_version: "2" },
      { output_schema_sha256: "8".repeat(64) },
      { model_id: "model-b" },
      { judge_id: "judge-b" },
      { budget: { ...cacheInput.budget, max_calls: 7 } },
      { redactor_version: "2" },
      { associated_blob_sha256: ["9".repeat(64)] },
    ];
    for (const mutation of mutations) {
      expect(composeSemanticCacheKeyV1({ ...cacheInput, ...mutation }))
        .not.toBe(baseline);
    }
  });
});
