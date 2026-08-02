import { mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runKnowledgeSurfaceAdapter } from "./adapter-contract.js";
import {
  CODEX_LOCAL_MEMORY_ADAPTER_V1,
  CODEX_LOCAL_MEMORY_DOCUMENTATION,
} from "./codex-local-memory.js";

async function fakeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "osstack-codex-memory-home-"));
}

describe("Codex local read-only memory adapter", () => {
  it("inventories only the exact configured generated-memory directory without exposing content", async () => {
    const home = await fakeHome();
    const memory = join(home, "memories");
    const outside = join(home, "outside");
    await mkdir(join(memory, "project"), { recursive: true });
    await mkdir(outside);
    await writeFile(join(memory, "project", "summary.md"), "private generated summary\n");
    await writeFile(join(memory, "index.json"), '{"generated":true}\n');
    await writeFile(join(outside, "SECRET.md"), "must not be read\n");
    await symlink(join(outside, "SECRET.md"), join(memory, "linked-secret.md"));

    const before = await readFile(join(memory, "project", "summary.md"), "utf8");
    const result = await runKnowledgeSurfaceAdapter(
      CODEX_LOCAL_MEMORY_ADAPTER_V1,
      {
        repo_root: "/fixture/repo",
        enabled: true,
        options: { memory_directory: memory, home_directory: home },
      },
    );

    expect(result.status).toBe("available");
    if (result.status !== "available") throw new Error("expected inventory");
    expect(result.inventory.surfaces).toEqual([
      expect.objectContaining({
        surface: "memory",
        path: "codex-local://generated-memory/index.json",
        exists: true,
        bytes: 19,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        adapter: {
          id: "codex-local",
          version: "1",
          source: CODEX_LOCAL_MEMORY_DOCUMENTATION,
        },
      }),
      expect.objectContaining({
        path: "codex-local://generated-memory/project/summary.md",
        exists: true,
        bytes: 26,
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]);
    expect(result.inventory.completeness).toMatchObject({
      complete: false,
      skipped_files: 1,
    });
    expect(JSON.stringify(result.inventory)).not.toContain("private generated summary");
    expect(JSON.stringify(result.inventory)).not.toContain("SECRET.md");
    expect(await readFile(join(memory, "project", "summary.md"), "utf8")).toBe(before);
    expect(result.rules).toEqual([]);
  });

  it("requires one explicit absolute or supplied-home-relative directory", async () => {
    const noDirectory = await runKnowledgeSurfaceAdapter(
      CODEX_LOCAL_MEMORY_ADAPTER_V1,
      { repo_root: "/fixture/repo", enabled: true, options: {} },
    );
    expect(noDirectory.status).toBe("absent");

    await expect(runKnowledgeSurfaceAdapter(
      CODEX_LOCAL_MEMORY_ADAPTER_V1,
      {
        repo_root: "/fixture/repo",
        enabled: true,
        options: { memory_directory: "relative/memories" },
      },
    )).rejects.toThrow("Codex local memory directory must be absolute or start with ~/");
  });

  it("does not follow a configured root symlink", async () => {
    const home = await fakeHome();
    const actual = join(home, "actual");
    const linked = join(home, "linked");
    await mkdir(actual);
    await writeFile(join(actual, "private.md"), "generated\n");
    await symlink(actual, linked);

    const result = await runKnowledgeSurfaceAdapter(
      CODEX_LOCAL_MEMORY_ADAPTER_V1,
      {
        repo_root: "/fixture/repo",
        enabled: true,
        options: { memory_directory: linked },
      },
    );

    expect(result.status).toBe("absent");
  });
});
