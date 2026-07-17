import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { inspectInstructionSource } from "./instruction-source.js";

async function tempRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "osstack-instructions-"));
}

describe("inspectInstructionSource", () => {
  it("classifies both missing, missing mirror, and missing canonical", async () => {
    const repoRoot = await tempRepo();
    await expect(inspectInstructionSource({
      repo_root: repoRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "import_or_symlink",
    })).resolves.toMatchObject({ status: "both_missing" });

    await writeFile(join(repoRoot, "AGENTS.md"), "# Canonical\n");
    await expect(inspectInstructionSource({
      repo_root: repoRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "import_or_symlink",
    })).resolves.toMatchObject({ status: "mirror_missing" });

    const mirrorOnlyRoot = await tempRepo();
    await writeFile(join(mirrorOnlyRoot, "CLAUDE.md"), "@AGENTS.md\n");
    await expect(inspectInstructionSource({
      repo_root: mirrorOnlyRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "import_or_symlink",
    })).resolves.toMatchObject({ status: "canonical_missing" });
  });

  it("accepts an exact trimmed import in import mode", async () => {
    const repoRoot = await tempRepo();
    await writeFile(join(repoRoot, "AGENTS.md"), "# Canonical\n");
    await writeFile(join(repoRoot, "CLAUDE.md"), "  @AGENTS.md  \n");

    await expect(inspectInstructionSource({
      repo_root: repoRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "import",
    })).resolves.toEqual({
      status: "valid_mirror",
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_kind: "import",
    });
  });

  it("accepts a confined symlink and rejects a wrong symlink", async () => {
    const repoRoot = await tempRepo();
    await writeFile(join(repoRoot, "AGENTS.md"), "# Canonical\n");
    await symlink("AGENTS.md", join(repoRoot, "CLAUDE.md"));

    await expect(inspectInstructionSource({
      repo_root: repoRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "symlink",
    })).resolves.toMatchObject({ status: "valid_mirror", mirror_kind: "symlink" });

    const wrongRoot = await tempRepo();
    await writeFile(join(wrongRoot, "AGENTS.md"), "# Canonical\n");
    await writeFile(join(wrongRoot, "OTHER.md"), "# Other\n");
    await symlink("OTHER.md", join(wrongRoot, "CLAUDE.md"));
    await expect(inspectInstructionSource({
      repo_root: wrongRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "import_or_symlink",
    })).resolves.toMatchObject({
      status: "mirror_drift",
      reason: "CLAUDE.md symlink points to OTHER.md",
    });
  });

  it("reports an outside-root symlink without treating it as a valid mirror", async () => {
    const repoRoot = await tempRepo();
    const externalRoot = await tempRepo();
    const externalFile = join(externalRoot, "AGENTS.md");
    await writeFile(join(repoRoot, "AGENTS.md"), "# Canonical\n");
    await writeFile(externalFile, "# External\n");
    await symlink(externalFile, join(repoRoot, "CLAUDE.md"));

    await expect(inspectInstructionSource({
      repo_root: repoRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "import_or_symlink",
    })).resolves.toMatchObject({
      status: "mirror_drift",
      reason: "CLAUDE.md symlink resolves outside repository",
    });
  });

  it("reports independent-file drift and enforces the configured mirror mode", async () => {
    const repoRoot = await tempRepo();
    await writeFile(join(repoRoot, "AGENTS.md"), "# Canonical\n");
    await writeFile(join(repoRoot, "CLAUDE.md"), "# Independent\n");

    await expect(inspectInstructionSource({
      repo_root: repoRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "import_or_symlink",
    })).resolves.toMatchObject({
      status: "mirror_drift",
      reason: "CLAUDE.md content is not exactly @AGENTS.md",
    });

    const importRoot = await tempRepo();
    await writeFile(join(importRoot, "AGENTS.md"), "# Canonical\n");
    await writeFile(join(importRoot, "CLAUDE.md"), "@AGENTS.md\n");
    await expect(inspectInstructionSource({
      repo_root: importRoot,
      canonical_path: "AGENTS.md",
      mirror_path: "CLAUDE.md",
      mirror_mode: "symlink",
    })).resolves.toMatchObject({
      status: "mirror_drift",
      reason: "CLAUDE.md must be a symlink to AGENTS.md",
    });
  });

  it("supports a configured canonical direction", async () => {
    const repoRoot = await tempRepo();
    await writeFile(join(repoRoot, "CLAUDE.md"), "# Canonical\n");
    await writeFile(join(repoRoot, "AGENTS.md"), "@CLAUDE.md\n");

    await expect(inspectInstructionSource({
      repo_root: repoRoot,
      canonical_path: "CLAUDE.md",
      mirror_path: "AGENTS.md",
      mirror_mode: "import_or_symlink",
    })).resolves.toMatchObject({
      status: "valid_mirror",
      mirror_kind: "import",
    });
  });
});
