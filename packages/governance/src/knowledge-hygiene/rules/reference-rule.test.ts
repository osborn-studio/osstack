import {
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KnowledgeSurfaceInventoryV1 } from "../types.js";
import {
  inspectKnowledgeReferences,
  REFERENCE_RULES_V1,
} from "./reference-rule.js";

function inventory(surfaces: Array<{
  path: string;
  surface: "instruction" | "documentation";
  content: string;
}>) {
  return KnowledgeSurfaceInventoryV1.parse({
    surfaces: surfaces.map((surface) => ({
      ...surface,
      kind: "file",
      exists: true,
      bytes: Buffer.byteLength(surface.content),
      lines: surface.content.split("\n").length,
    })),
    completeness: { complete: true, skipped_files: 0, reasons: [] },
  });
}

async function evaluate(repoRoot: string, surfaces: Parameters<typeof inventory>[0]) {
  const surfaceInventory = inventory(surfaces);
  const observations = await inspectKnowledgeReferences({
    repo_root: repoRoot,
    inventory: surfaceInventory,
  });
  return REFERENCE_RULES_V1.flatMap((rule) => rule.evaluate({
    repo_identity: "repo-1",
    config: undefined,
    inventory: surfaceInventory,
    instruction_observations: [],
    reference_observations: observations,
    change_set: undefined,
  }));
}

describe("conservative reference rules", () => {
  it("reports a missing relative Markdown target with the source line", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-reference-"));
    await mkdir(join(repoRoot, "docs"));
    await writeFile(join(repoRoot, "README.md"), "# Exists\n");
    const findings = await evaluate(repoRoot, [{
      path: "docs/guide.md",
      surface: "documentation",
      content: "[works](../README.md)\n[missing](missing.md)\n",
    }]);

    expect(findings).toEqual([
      expect.objectContaining({
        rule_id: "reference.markdown_target_missing",
        severity: "warning",
        location: {
          path: "docs/guide.md",
          line: 2,
          anchor: "target:docs/missing.md",
        },
        observed: expect.objectContaining({
          target: "missing.md",
          resolved_path: "docs/missing.md",
        }),
      }),
    ]);
  });

  it("ignores URLs, images, fragments, code fences, wikilinks, variables, and prose", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-reference-"));
    const findings = await evaluate(repoRoot, [{
      path: "docs/guide.md",
      surface: "documentation",
      content: [
        "[web](https://example.com)",
        "[mail](mailto:test@example.com)",
        "[section](#heading)",
        "![image](missing.png)",
        "[[missing-wikilink]]",
        "See missing.md when ready.",
        "[variable]($" + "{DOC_ROOT}/guide.md)",
        "[ambiguous](missing.md \"title\")",
        "```md",
        "[example](missing.md)",
        "```",
      ].join("\n"),
    }]);

    expect(findings).toEqual([]);
  });

  it("checks exact-line instruction imports and ignores path-like instruction prose", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-reference-"));
    await writeFile(join(repoRoot, "EXISTS.md"), "# Exists\n");
    const findings = await evaluate(repoRoot, [{
      path: "AGENTS.md",
      surface: "instruction",
      content: [
        "@EXISTS.md",
        "@MISSING.md",
        "Ask @someone about docs/missing.md",
      ].join("\n"),
    }]);

    expect(findings).toEqual([
      expect.objectContaining({
        rule_id: "reference.instruction_import_missing",
        severity: "error",
        location: {
          path: "AGENTS.md",
          line: 2,
          anchor: "target:MISSING.md",
        },
      }),
    ]);
  });

  it("does not follow a reference target symlink outside the repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "osstack-neat-reference-"));
    const externalRoot = await mkdtemp(join(tmpdir(), "osstack-neat-external-"));
    await mkdir(join(repoRoot, "docs"));
    await writeFile(join(externalRoot, "secret.md"), "# External\n");
    await symlink(
      join(externalRoot, "secret.md"),
      join(repoRoot, "docs", "external.md"),
    );

    const findings = await evaluate(repoRoot, [{
      path: "README.md",
      surface: "documentation",
      content: "[external](docs/external.md)\n",
    }]);

    expect(findings).toEqual([
      expect.objectContaining({
        rule_id: "reference.markdown_target_missing",
        observed: expect.objectContaining({ unsafe_symlink: true }),
      }),
    ]);
  });
});
