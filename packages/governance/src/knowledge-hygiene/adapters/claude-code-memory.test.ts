import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runKnowledgeSurfaceAdapter } from "./adapter-contract.js";
import {
  CLAUDE_CODE_MEMORY_ADAPTER_V1,
  CLAUDE_CODE_MEMORY_INDEX_MAX_BYTES,
  CLAUDE_CODE_MEMORY_INDEX_MAX_LINES,
} from "./claude-code-memory.js";

async function fakeHome(): Promise<string> {
  return mkdtemp(join(tmpdir(), "osstack-claude-memory-home-"));
}

describe("Claude Code read-only memory adapter", () => {
  it("inventories only the exact configured memory directory", async () => {
    const home = await fakeHome();
    const memory = join(home, "chosen-project", "memory");
    const otherProject = join(home, "other-project", "memory");
    await mkdir(memory, { recursive: true });
    await mkdir(otherProject, { recursive: true });
    const memoryContent = `${Array.from({ length: 201 }, (_, index) =>
      `line ${index + 1}`).join("\n")}\n`;
    await writeFile(join(memory, "MEMORY.md"), memoryContent);
    await writeFile(join(memory, "debugging.md"), "# Debugging\n");
    await writeFile(join(memory, "ignored.txt"), "not a memory topic\n");
    await writeFile(join(otherProject, "SECRET.md"), "must not be read\n");

    const before = await readFile(join(memory, "MEMORY.md"), "utf8");
    const result = await runKnowledgeSurfaceAdapter(
      CLAUDE_CODE_MEMORY_ADAPTER_V1,
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
        path: "claude-code://auto-memory/MEMORY.md",
        exists: true,
        lines: 201,
        adapter: {
          id: "claude-code",
          version: "1",
          source: "https://code.claude.com/docs/en/memory",
        },
      }),
      expect.objectContaining({
        surface: "memory",
        path: "claude-code://auto-memory/debugging.md",
        exists: true,
        lines: 1,
      }),
    ]);
    expect(JSON.stringify(result.inventory)).not.toContain("SECRET.md");
    expect(await readFile(join(memory, "MEMORY.md"), "utf8")).toBe(before);
    expect({
      lines: CLAUDE_CODE_MEMORY_INDEX_MAX_LINES,
      bytes: CLAUDE_CODE_MEMORY_INDEX_MAX_BYTES,
    }).toEqual({ lines: 200, bytes: 25 * 1024 });
  });

  it("expands a documented ~/ custom directory only from the supplied fake home", async () => {
    const home = await fakeHome();
    const memory = join(home, "custom-memory");
    await mkdir(memory);
    await writeFile(join(memory, "MEMORY.md"), "# Memory\n");

    const result = await runKnowledgeSurfaceAdapter(
      CLAUDE_CODE_MEMORY_ADAPTER_V1,
      {
        repo_root: "/fixture/repo",
        enabled: true,
        options: {
          memory_directory: "~/custom-memory",
          home_directory: home,
        },
      },
    );

    expect(result.status).toBe("available");
    if (result.status === "available") {
      expect(result.inventory.surfaces[0]?.path)
        .toBe("claude-code://auto-memory/MEMORY.md");
    }
  });

  it("returns a clean absent detection for a missing configured platform", async () => {
    const home = await fakeHome();

    const result = await runKnowledgeSurfaceAdapter(
      CLAUDE_CODE_MEMORY_ADAPTER_V1,
      {
        repo_root: "/fixture/repo",
        enabled: true,
        options: {
          memory_directory: join(home, "missing-memory"),
          home_directory: home,
        },
      },
    );

    expect(result).toMatchObject({
      status: "absent",
      adapter_id: "claude-code",
      adapter_version: "1",
    });
  });

  it("does not use the process home or probe defaults when no exact directory is supplied", async () => {
    const result = await runKnowledgeSurfaceAdapter(
      CLAUDE_CODE_MEMORY_ADAPTER_V1,
      {
        repo_root: "/fixture/repo",
        enabled: true,
        options: {},
      },
    );

    expect(result.status).toBe("absent");
  });
});
