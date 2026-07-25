import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDevelopmentCorpusV1,
  materializeDevelopmentCorpusV1,
  scanCorpusSecretsV1,
} from "./corpus.js";

const created: string[] = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("neat parity development corpus", () => {
  it("freezes 30 isolated cases, 120 labels, five repos, and >= one-third natural-derived defects", () => {
    const corpus = buildDevelopmentCorpusV1();
    expect(corpus.cases).toHaveLength(30);
    expect(corpus.repositories).toHaveLength(5);
    expect(corpus.cases.flatMap((entry) => entry.defects)).toHaveLength(120);
    expect(corpus.summary.natural_derived_defects).toBeGreaterThanOrEqual(40);
    expect(new Set(corpus.cases.map((entry) => entry.case_id)).size).toBe(30);
    expect(corpus.hidden_protocol.external_bundle_required).toBe(true);
  });

  it("materializes clean/rot snapshots deterministically and rejects secret-like payloads", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-parity-corpus-"));
    created.push(root);
    const first = await materializeDevelopmentCorpusV1(root);
    const second = await materializeDevelopmentCorpusV1(root);
    expect(first.manifest_sha256).toBe(second.manifest_sha256);
    expect(first.tree_sha256).toBe(second.tree_sha256);
    expect(first.files_written).toBeGreaterThan(180);
    const rot = await readFile(
      join(root, "cases", "case-001", "rot", "AGENTS.md"),
      "utf8",
    );
    expect(rot).not.toContain("DEFECT:");
    expect(scanCorpusSecretsV1({ "safe.md": "hello" })).toEqual([]);
    expect(scanCorpusSecretsV1({
      "bad.md": "-----BEGIN PRIVATE KEY-----",
    })).toEqual([expect.objectContaining({ path: "bad.md" })]);
  });
});
