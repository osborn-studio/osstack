import {
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseKnowledgeHygieneConfigV1 } from "./config.js";
import { inventoryKnowledgeSurfaces } from "./repository-reader.js";

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "osstack-neat-inventory-"));
}

describe("inventoryKnowledgeSurfaces", () => {
  it("inventories only recognized root and docs Markdown surfaces", async () => {
    const repoRoot = await tempRepo();
    await mkdir(join(repoRoot, "docs", "guides"), { recursive: true });
    await mkdir(join(repoRoot, "packages", "feature"), { recursive: true });
    await mkdir(join(repoRoot, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(repoRoot, "AGENTS.md"), "one\r\ntwo\r\n");
    await writeFile(join(repoRoot, "README.md"), "# Readme\n");
    await writeFile(join(repoRoot, "docs", "guides", "start.md"), "# Start\n");
    await writeFile(join(repoRoot, "docs", "ignored.txt"), "not Markdown\n");
    await writeFile(join(repoRoot, "packages", "feature", "private.md"), "# Private\n");
    await writeFile(join(repoRoot, "node_modules", "pkg", "README.md"), "# Vendor\n");

    const inventory = await inventoryKnowledgeSurfaces({ repo_root: repoRoot });

    expect(inventory.completeness).toEqual({
      complete: true,
      skipped_files: 0,
      reasons: [],
    });
    expect(inventory.surfaces.map((surface) => surface.path)).toEqual([
      "AGENTS.md",
      "README.md",
      "docs/guides/start.md",
    ]);
    expect(inventory.surfaces[0]).toMatchObject({
      surface: "instruction",
      bytes: 10,
      lines: 2,
      content: "one\r\ntwo\r\n",
    });
  });

  it("adds explicitly configured exact files and directories", async () => {
    const repoRoot = await tempRepo();
    await mkdir(join(repoRoot, "architecture"));
    await writeFile(join(repoRoot, "CONTEXT.txt"), "context\n");
    const config = parseKnowledgeHygieneConfigV1(`
version: 1
required_surfaces:
  - { id: architecture, path: architecture, kind: directory }
budgets:
  - id: context
    path: CONTEXT.txt
    warn: { bytes: 100 }
`);

    const inventory = await inventoryKnowledgeSurfaces({
      repo_root: repoRoot,
      config,
    });

    expect(inventory.surfaces).toEqual([
      expect.objectContaining({ path: "CONTEXT.txt", kind: "file", exists: true }),
      expect.objectContaining({ path: "architecture", kind: "directory", exists: true }),
    ]);
  });

  it("marks oversized and file-count-limited inventories incomplete", async () => {
    const repoRoot = await tempRepo();
    await mkdir(join(repoRoot, "docs"));
    await writeFile(join(repoRoot, "README.md"), "12345");
    await writeFile(join(repoRoot, "docs", "a.md"), "a\n");
    await writeFile(join(repoRoot, "docs", "b.md"), "b\n");

    const inventory = await inventoryKnowledgeSurfaces({
      repo_root: repoRoot,
      limits: {
        max_files: 2,
        max_file_bytes: 4,
        max_total_bytes: 100,
      },
    });

    expect(inventory.completeness.complete).toBe(false);
    expect(inventory.completeness.skipped_files).toBeGreaterThanOrEqual(2);
    expect(inventory.completeness.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining("file byte limit"),
      expect.stringContaining("recognized file limit"),
    ]));
  });

  it("does not traverse a symlinked docs directory outside the repository", async () => {
    const repoRoot = await tempRepo();
    const externalRoot = await tempRepo();
    await writeFile(join(externalRoot, "external.md"), "# Must not read\n");
    await symlink(externalRoot, join(repoRoot, "docs"));

    const inventory = await inventoryKnowledgeSurfaces({ repo_root: repoRoot });

    expect(inventory.surfaces).toEqual([]);
    expect(inventory.completeness).toMatchObject({ complete: false });
    expect(inventory.completeness.reasons).toContain(
      "symlink directory skipped: docs",
    );
  });
});
