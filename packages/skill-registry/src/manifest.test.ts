import { existsSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  addSource,
  readManifest,
  removeSource,
  SkillManifest,
  SkillSource,
  writeManifest,
} from "./manifest.js";

describe("skill registry manifest", () => {
  it("returns starter sources without creating a missing manifest", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-skill-registry-"));
    const path = join(root, "nested", "skills.config.yaml");

    const manifest = readManifest(path);

    expect(manifest.version).toBe(1);
    expect(manifest.sources.map((source) => source.id)).toEqual([
      "gstack",
      "everything-claude-code",
      "anthropic-skills",
    ]);
    expect(existsSync(path)).toBe(false);
  });

  it("round-trips a strict manifest and preserves source defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-skill-registry-"));
    const path = join(root, "nested", "skills.config.yaml");
    const source = SkillSource.parse({
      id: "neat-freak",
      origin: "https://github.com/KKKKhazix/khazix-skills.git",
    });
    const manifest = SkillManifest.parse({
      version: 1,
      sources: [source],
    });

    writeManifest(manifest, path);

    expect(readManifest(path)).toEqual(manifest);
    expect(source).toMatchObject({
      ref: "main",
      blessed_sha: null,
      auto_minor: false,
    });
  });

  it("adds, replaces, and removes sources without mutating the input", () => {
    const initial = SkillManifest.parse({ version: 1, sources: [] });
    const added = addSource(initial, {
      id: "upstream",
      origin: "https://example.com/upstream.git",
    });
    const replaced = addSource(added, {
      id: "upstream",
      origin: "https://example.com/replacement.git",
      ref: "stable",
    });

    expect(initial.sources).toEqual([]);
    expect(added.sources).toHaveLength(1);
    expect(replaced.sources).toEqual([
      expect.objectContaining({
        id: "upstream",
        origin: "https://example.com/replacement.git",
        ref: "stable",
      }),
    ]);
    expect(removeSource(replaced, "upstream").sources).toEqual([]);
  });
});


describe("source subtree and independent package version registration", () => {
  const legacy = { id: "pstack", origin: "https://github.com/cursor/plugins.git", ref: "main", blessed_sha: "a".repeat(40), auto_minor: false };

  it("adds root/null defaults while retaining all legacy values", () => {
    expect(SkillSource.parse(legacy)).toEqual({ ...legacy, name: "", last_checked: null, notes: "", subdir: ".", package_version: null });
  });

  it("preserves subtree and version through add, replace, YAML write and read without blessing", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-manifest-subtree-"));
    const path = join(root, "skills.config.yaml");
    const original = SkillManifest.parse({ sources: [] });
    const registered = addSource(original, { ...legacy, subdir: "pstack", package_version: "0.15.36" });
    writeManifest(registered, path);
    expect(readManifest(path)).toEqual(registered);
    expect(readManifest(path).sources[0]).toMatchObject({ subdir: "pstack", package_version: "0.15.36", ref: "main", blessed_sha: legacy.blessed_sha, auto_minor: false });
    const replaced = addSource(registered, { ...legacy, subdir: "packages/skills", package_version: "release-candidate" });
    expect(replaced.sources[0]).toMatchObject({ subdir: "packages/skills", package_version: "release-candidate", blessed_sha: legacy.blessed_sha });
    expect(registered.sources[0]?.package_version).toBe("0.15.36");
    expect(original.sources).toEqual([]);
  });

  it.each([".", "pstack", "skills/中文", "dir with space/skill", "a".repeat(512), Array(64).fill("a").join("/"), "é".repeat(256)])("accepts the legal Git subtree unchanged: %s", subdir => {
    expect(SkillSource.parse({ ...legacy, subdir }).subdir).toBe(subdir);
  });

  it.each(["", "/pstack", "../pstack", "a/../b", "a/./b", "./pstack", "a//b", "a/", "a\\b", "C:dir", ".git", "a/.GiT/b", "a./b", "a /b", "a\n/b", "a\u007f/b", "a".repeat(513), Array(65).fill("a").join("/"), "é".repeat(257)])("rejects unsafe or over-budget subtrees: %s", subdir => {
    expect(SkillSource.safeParse({ ...legacy, subdir }).success).toBe(false);
  });

  it.each([null, "0.15.36", "v0.15.36-rc.1", "package release", "é".repeat(64)])("preserves valid independent version labels: %s", package_version => {
    const parsed = SkillSource.parse({ ...legacy, package_version });
    expect(parsed.package_version).toBe(package_version);
    expect(parsed.ref).toBe(legacy.ref); expect(parsed.blessed_sha).toBe(legacy.blessed_sha);
  });

  it.each(["", " 0.15.36", "0.15.36 ", "a\nb", "a\u007fb", "a\u0085b", "é".repeat(65), 15.36, ["0.15.36"]])("rejects malformed version labels: %s", package_version => {
    expect(SkillSource.safeParse({ ...legacy, package_version }).success).toBe(false);
  });

  it("rejects unknown source and manifest fields, including YAML hand edits", async () => {
    expect(SkillSource.safeParse({ ...legacy, subtree: "pstack" }).success).toBe(false);
    expect(SkillManifest.safeParse({ sources: [], auto_minor: true }).success).toBe(false);
    const root = await mkdtemp(join(tmpdir(), "osstack-manifest-unknown-"));
    const path = join(root, "skills.config.yaml");
    writeFileSync(path, "version: 1\nsources: []\nunrecognized: true\n");
    expect(() => readManifest(path)).toThrow();
  });
});
