import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { scanRepo } from "./repo-scanner.js";

describe("repo scanner", () => {
  it("detects basic closed-loop repo signals", async () => {
    const dir = await mkdtemp(join(tmpdir(), "osstack-scan-"));
    try {
      await mkdir(join(dir, "docs"), { recursive: true });
      await mkdir(join(dir, "tests"), { recursive: true });
      await writeFile(join(dir, "README.md"), "# Demo\n");
      await writeFile(join(dir, "docs", "LOOP.md"), "# Closed Loop Contract\n");
      await writeFile(join(dir, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
      await writeFile(join(dir, "LOOP-STATE.json"), JSON.stringify({
        loop_id: "loop_1",
        started_at: "2026-07-07T00:00:00.000Z",
        updated_at: "2026-07-07T00:00:00.000Z",
        completed_tasks: [{ task_id: "t1", outcome: "success", iterations: 1, agent_id: "mock", duration_ms: 10 }],
      }));
      const health = await scanRepo({
        repo_id: "demo",
        name: "demo",
        path: dir,
        role: "app",
        verify_commands: ["npm test"],
        loop_doc_path: "docs/LOOP.md",
        priority: 50,
        enabled: true,
      });
      expect(health.exists).toBe(true);
      expect(health.has_readme).toBe(true);
      expect(health.has_loop_doc).toBe(true);
      expect(health.has_tests).toBe(true);
      expect(health.has_verify_command).toBe(true);
      expect(health.latest_loop_success_rate).toBe(1);
      expect(health.closed_loop_level).toBeGreaterThanOrEqual(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("returns findings for missing repo path", async () => {
    const health = await scanRepo({
      repo_id: "missing",
      name: "missing",
      path: "/tmp/definitely-missing-osstack-repo",
      role: "app",
      priority: 50,
      verify_commands: [],
      loop_doc_path: "docs/LOOP.md",
      enabled: true,
    });
    expect(health.exists).toBe(false);
    expect(health.closed_loop_level).toBe(0);
    expect(health.findings.join(" ")).toMatch(/missing|not found|does not exist/i);
  });
});
