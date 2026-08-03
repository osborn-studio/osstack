import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDevelopmentCorpusV1,
  fetchFrozenBaselineV1,
  hashFrozenBaselineBundleV1,
  KHAZIX_NEAT_FREAK_V3_RUNTIME_FILES,
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
  it("keeps the committed v3 runtime manifest synchronized with the evaluator", async () => {
    const manifest = JSON.parse(await readFile(
      resolve(process.cwd(), "../../eval/neat-parity/khazix-neat-freak-v3-baseline.json"),
      "utf8",
    ));
    const corpus = buildDevelopmentCorpusV1();

    expect(manifest).toEqual(expect.objectContaining({
      schema_version: "1",
      repository: corpus.baseline.repository,
      commit: corpus.baseline.commit,
      path: corpus.baseline.path,
      bundle_sha256: corpus.baseline.sha256,
      license: corpus.baseline.license,
    }));
    expect(manifest.files).toEqual(KHAZIX_NEAT_FREAK_V3_RUNTIME_FILES);
    expect(manifest.scope).toEqual({
      included: "neat-freak runtime instructions, references, and audit script",
      excluded: ["neat-freak/evals"],
      exclusion_reason: "Upstream evaluation fixtures are not runtime dependencies and would leak test material into arm A.",
    });
  });

  it("freezes 30 isolated cases, 120 labels, five repos, and >= one-third natural-derived defects", () => {
    const corpus = buildDevelopmentCorpusV1();
    expect(corpus.cases).toHaveLength(30);
    expect(corpus.repositories).toHaveLength(5);
    expect(corpus.cases.flatMap((entry) => entry.defects)).toHaveLength(120);
    expect(corpus.summary.natural_derived_defects).toBeGreaterThanOrEqual(40);
    expect(new Set(corpus.cases.map((entry) => entry.case_id)).size).toBe(30);
    expect(corpus.hidden_protocol.external_bundle_required).toBe(true);
    expect(corpus.baseline).toEqual({
      repository: "KKKKhazix/khazix-skills",
      commit: "2b4a645cfdc894156ae347d897723562f719ce95",
      path: "neat-freak",
      sha256: "e77e30e39e67f05d3159548605057d396794d1bde20bd59a070670e109c3d904",
      license: "MIT",
    });
    expect(corpus.cases[1]?.defects[0]?.provenance).toEqual(
      expect.objectContaining({
        source_commit: "2b4a645cfdc894156ae347d897723562f719ce95",
        source_sha256: "6c0ca2236d3518ccaad710f6db8e9c4aa7af67b685dc699ad347ae42186951e1",
      }),
    );
  });

  it("hashes a complete baseline directory and rejects symlinked bundle entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-baseline-"));
    created.push(root);
    await mkdir(join(root, "references"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "SKILL.md"), "skill\n");
    await writeFile(join(root, "references", "governance.md"), "rules\n");
    await writeFile(join(root, "scripts", "audit.sh"), "#!/bin/sh\n");
    await chmod(join(root, "scripts", "audit.sh"), 0o755);

    const first = await hashFrozenBaselineBundleV1(root);
    const second = await hashFrozenBaselineBundleV1(root);
    expect(first).toEqual(second);
    expect(first.files.map((entry) => [entry.path, entry.mode])).toEqual([
      ["SKILL.md", "100644"],
      ["references/governance.md", "100644"],
      ["scripts/audit.sh", "100755"],
    ]);

    await symlink("SKILL.md", join(root, "ALIAS.md"));
    await expect(hashFrozenBaselineBundleV1(root)).rejects.toThrow(
      "baseline bundle contains unsupported entry: ALIAS.md",
    );
  });

  it("fails closed on mismatched downloads and existing destinations", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-neat-fetch-"));
    created.push(root);
    const output = join(root, "baseline");
    let redirect: "error" | undefined;
    const mismatchedFetch: typeof fetch = async (_input, init) => {
      redirect = init?.redirect === "error" ? "error" : undefined;
      return new Response("not the committed upstream file", { status: 200 });
    };

    await expect(fetchFrozenBaselineV1(output, mismatchedFetch)).rejects.toThrow(
      "downloaded baseline file does not match manifest: SKILL.md",
    );
    expect(redirect).toBe("error");

    await writeFile(output, "occupied\n");
    await expect(fetchFrozenBaselineV1(output, mismatchedFetch)).rejects.toThrow(
      "baseline output already exists",
    );
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
