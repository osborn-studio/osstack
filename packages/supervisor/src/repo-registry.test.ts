import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addRepoRegistryEntry, readRepoRegistry, writeRepoRegistry } from "./repo-registry.js";

describe("repo registry", () => {
  it("returns empty registry when file is absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osstack-registry-"));
    try {
      await expect(readRepoRegistry(join(dir, ".osstack", "repos.json"))).resolves.toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("round-trips entries with pretty JSON", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osstack-registry-"));
    try {
      const registryPath = join(dir, ".osstack", "repos.json");
      await writeRepoRegistry(registryPath, [{
        repo_id: "osstack",
        name: "osstack",
        path: "/tmp/osstack",
        role: "core_platform",
        priority: 100,
        verify_commands: ["pnpm test"],
        loop_doc_path: "docs/LOOP.md",
        enabled: true,
      }]);
      const raw = await readFile(registryPath, "utf8");
      expect(raw).toContain("\n  {");
      const entries = await readRepoRegistry(registryPath);
      expect(entries[0]?.repo_id).toBe("osstack");
      expect(entries[0]?.priority).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("upserts entries by repo_id", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osstack-registry-"));
    try {
      const registryPath = join(dir, ".osstack", "repos.json");
      await addRepoRegistryEntry(registryPath, {
        repo_id: "stock-monitor",
        name: "Stock Monitor",
        path: "/tmp/stock-monitor",
        role: "business_product",
      });
      await addRepoRegistryEntry(registryPath, {
        repo_id: "stock-monitor",
        name: "Stock Monitor Main",
        path: "/tmp/stock-monitor-main",
        role: "business_product",
        priority: 90,
      });
      const entries = await readRepoRegistry(registryPath);
      expect(entries).toHaveLength(1);
      expect(entries[0]?.name).toBe("Stock Monitor Main");
      expect(entries[0]?.priority).toBe(90);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
