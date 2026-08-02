import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { initProject } from "./scaffold.js";

describe("initProject", () => {
  it("creates the documented skeleton and is idempotent", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-init-project-"));

    const first = initProject(root);
    const second = initProject(root);

    expect(first.project).toBe(basename(root));
    expect(first.created).toEqual(expect.arrayContaining([
      join(root, ".agent"),
      join(root, "docs"),
      join(root, "tasks"),
      join(root, "AGENTS.md"),
      join(root, ".agent", "PROJECT_CONTEXT.md"),
      join(root, "docs", "PRD.md"),
      join(root, "docs", "ARCHITECTURE.md"),
      join(root, "docs", "SPRINTS.md"),
    ]));
    expect(second.created).toEqual([]);
    expect(second.skipped).toHaveLength(first.created.length);
    await expect(readFile(join(root, "AGENTS.md"), "utf8"))
      .resolves.toContain("This project is managed by **osstack**");
    await expect(readFile(join(root, ".agent", "PROJECT_CONTEXT.md"), "utf8"))
      .resolves.toContain(`**Project:** ${basename(root)}`);
  });

  it("never overwrites an existing instruction source", async () => {
    const root = await mkdtemp(join(tmpdir(), "osstack-init-project-"));
    const agents = join(root, "AGENTS.md");
    await writeFile(agents, "# Existing rules\n");

    const result = initProject(root);

    expect(result.skipped).toContain(agents);
    await expect(readFile(agents, "utf8")).resolves.toBe("# Existing rules\n");
  });
});
