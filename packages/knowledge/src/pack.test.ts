import { mkdtempSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assembleKnowledgeSnippet,
  loadKnowledgePack,
  searchKnowledgePacks,
  validateKnowledgePackManifest,
} from "./index.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-knowledge-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("knowledge packs", () => {
  it("loads an osstack-native manifest from a file", async () => {
    const path = join(tmp, "pack.json");
    await writeFile(path, JSON.stringify(samplePack(), null, 2));

    const pack = await loadKnowledgePack(path);

    expect(pack.manifest).toMatchObject({
      id: "osstack-web-quality",
      version: "2026.06.22",
      license: "MIT-derived-processed",
      source_kind: "processed_mit",
      quality_score: 91,
    });
    expect(JSON.parse(await readFile(path, "utf-8"))).toHaveProperty("chunks");
  });

  it("rejects manifests without required ownership metadata", () => {
    expect(() => validateKnowledgePackManifest({
      id: "bad",
      version: "1",
      name: "Bad",
      chunks: [],
    })).toThrow(/license/);
  });

  it("searches local packs and assembles prompt snippets", async () => {
    const path = join(tmp, "pack.json");
    await writeFile(path, JSON.stringify(samplePack(), null, 2));
    const pack = await loadKnowledgePack(path);

    const results = searchKnowledgePacks([pack], "frontend governance", { limit: 2 });

    expect(results[0]).toMatchObject({
      pack_id: "osstack-web-quality",
      chunk_id: "chunk-frontend-governance",
      title: "Frontend governance checks",
    });
    expect(assembleKnowledgeSnippet(results)).toContain("pack=osstack-web-quality@2026.06.22");
  });
});

function samplePack() {
  return {
    id: "osstack-web-quality",
    version: "2026.06.22",
    name: "Osstack Web Quality Knowledge",
    license: "MIT-derived-processed",
    source_kind: "processed_mit",
    quality_score: 91,
    generated_at: "2026-06-22T00:00:00.000Z",
    source_attribution: ["curated from MIT-compatible engineering notes"],
    chunks: [
      {
        chunk_id: "chunk-frontend-governance",
        title: "Frontend governance checks",
        body: "Frontend governance should catch placeholder text, hardcoded template palettes, fake emoji icons, and inaccessible controls before proof generation.",
        tags: ["frontend", "governance"],
        source_refs: ["osstack-governance-v1"],
      },
      {
        chunk_id: "chunk-loop-proof",
        title: "Loop proof evidence",
        body: "Loop proof packs should include manifest checksums, verify results, policy decisions, and replayable events.",
        tags: ["proof", "loop"],
      },
    ],
  };
}
