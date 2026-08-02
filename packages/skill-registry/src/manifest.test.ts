import { existsSync } from "node:fs";
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
