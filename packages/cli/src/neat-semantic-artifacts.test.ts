import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SemanticDecisionV1,
  SemanticEvidencePackV1,
} from "@osstack/governance";
import { describe, expect, it } from "vitest";
import {
  createFileSemanticDecisionCacheV1,
  createSemanticEvidenceObserverV1,
} from "./neat-semantic-artifacts.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function decision() {
  return SemanticDecisionV1.parse({
    dimension: "narrative",
    verdict: "no_issue",
    confidence: "high",
    citations: [],
    rationale: "No issue in the bounded candidate.",
    proposed_disposition: "none",
    closure_conditions: [],
  });
}

function pack() {
  const schemaSha = "1".repeat(64);
  const body = {
    pack_id: `khep_${"2".repeat(64)}`,
    dimension: "narrative" as const,
    source_units_total: 1,
    candidate_generator: { id: "narrative-bounded-candidates", version: "1" },
    sources: [{
      source: { kind: "repository" as const, repo_id: "repo-1", path: "AGENTS.md" },
      blob_sha256: "3".repeat(64),
      excerpts: [{ start_line: 1, end_line: 1, text: "redacted evidence" }],
    }],
    candidates: [{ candidate_id: "candidate-1", source_indexes: [0] }],
    redaction_count: 1,
    prompt_version: "1",
    output_schema_sha256: schemaSha,
    budget: { max_input_tokens: 100, max_output_tokens: 100, max_calls: 1 },
  };
  return SemanticEvidencePackV1.parse({
    ...body,
    pack_sha256: digest(JSON.stringify(body)),
  });
}

describe("semantic artifact storage", () => {
  it("persists validated decisions with private directory and file modes", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "osstack-semantic-cache-"))
    );
    const cache = createFileSemanticDecisionCacheV1(root);
    const key = `khsc_${"a".repeat(64)}`;
    await cache.write(key, decision());

    expect(await cache.read(key)).toEqual(decision());
    const directory = join(root, "neat", "cache", "semantic");
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(join(directory, `${key}.json`))).mode & 0o777).toBe(0o600);
    expect(await cache.read(`khsc_${"b".repeat(64)}`)).toBeUndefined();
  });

  it("stores debug evidence only through the explicit observer and prunes expired runs", async () => {
    const root = await import("node:fs/promises").then(({ mkdtemp }) =>
      mkdtemp(join(tmpdir(), "osstack-semantic-evidence-"))
    );
    const evidenceRoot = join(root, "neat", "evidence");
    const expired = join(evidenceRoot, `khsr_${"c".repeat(64)}`);
    await mkdir(expired, { recursive: true });
    await writeFile(join(expired, "old.json"), "{}");
    const old = new Date("2026-07-01T00:00:00.000Z");
    await utimes(expired, old, old);

    const observe = createSemanticEvidenceObserverV1(root, {
      now: () => new Date("2026-07-18T00:00:00.000Z"),
    });
    const runId = `khsr_${"d".repeat(64)}`;
    const evidencePack = pack();
    await observe(evidencePack, `khsc_${"e".repeat(64)}`, runId);

    const path = join(evidenceRoot, runId, `${evidencePack.pack_id}.json`);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      cache_key: `khsc_${"e".repeat(64)}`,
      evidence_pack: { pack_id: evidencePack.pack_id },
    });
    expect((await stat(join(evidenceRoot, runId))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(stat(expired)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
