import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkKnowledgeHygiene } from "./engine.js";
import { loadKnowledgeHygieneConfig } from "./config.js";

const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));

describe("osstack neat dogfood config", () => {
  it("keeps declared obligations real and the full audit clean", async () => {
    const loaded = await loadKnowledgeHygieneConfig({ repo_root: repoRoot });
    expect(loaded.mode).toBe("configured");
    if (loaded.mode !== "configured") return;

    expect(loaded.config.instructions).toEqual({
      canonical: "AGENTS.md",
      mirrors: [{ path: "CLAUDE.md", mode: "import_or_symlink" }],
    });
    for (const surface of loaded.config.required_surfaces) {
      const metadata = await lstat(new URL(surface.path, `file://${repoRoot}/`));
      expect(
        surface.kind === "directory"
          ? metadata.isDirectory()
          : metadata.isFile(),
      ).toBe(true);
    }
    for (const contract of loaded.config.contracts) {
      for (const reviewPath of contract.review.any_path) {
        const metadata = await lstat(new URL(reviewPath, `file://${repoRoot}/`));
        expect(metadata.isFile()).toBe(true);
      }
    }

    const report = await checkKnowledgeHygiene({
      repo_root: repoRoot,
      mode: "all",
    });
    expect(report.completeness.complete).toBe(true);
    expect(report.findings).toEqual([]);
  });
});
