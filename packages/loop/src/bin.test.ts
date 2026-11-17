import { mkdtempSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, printLoopRun } from "./bin.js";

let workspace: string;
let stdoutSpy: ReturnType<typeof vi.spyOn>;
let stderrSpy: ReturnType<typeof vi.spyOn>;
let stdout: string[];
let stderr: string[];

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "osstack-loop-bin-"));
  stdout = [];
  stderr = [];
  stdoutSpy = vi.spyOn(console, "log").mockImplementation((message?: unknown) => {
    stdout.push(String(message ?? ""));
  });
  stderrSpy = vi.spyOn(console, "error").mockImplementation((...messages: unknown[]) => {
    stderr.push(messages.map((message) => String(message)).join(" "));
  });
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  stderrSpy.mockRestore();
  await rm(workspace, { recursive: true, force: true });
});

describe("osstack-loop standalone CLI", () => {
  it("prints invalid deviation warnings in text and preserves JSON data", () => {
    const result = { loop_id: "loop", json_path: "state.json", markdown_path: "state.md",
      completed_tasks: [{ task_id: "task", outcome: "success" as const, iterations: 1,
        agent_id: "builder", duration_ms: 1, verify_issues: [{ rule: "verify.deviations_invalid", message: "report invalid: json" }] }],
    };
    printLoopRun(result, false);
    expect(stdout).toContain("    warning: report invalid: json");
    stdout = [];
    printLoopRun(result, true);
    expect(JSON.parse(stdout.join("\n"))).toEqual(result);
  });
  it("enqueues, runs, and renders status without the osstack CLI package", async () => {
    await expect(main([
      "enqueue",
      "Run local checks",
      "--workspace",
      workspace,
      "--capability",
      "code.test",
      "--id",
      "task-standalone",
      "--priority",
      "80",
    ])).resolves.toBe(0);
    expect(stdout.join("\n")).toContain("task_id=task-standalone");

    stdout = [];
    await expect(main([
      "run",
      "--workspace",
      workspace,
      "--source",
      "task_queue",
      "--execute",
      "node -e \"require('fs').writeFileSync('done.txt','ok')\"",
      "--verify",
      "node -e \"process.exit(require('fs').existsSync('done.txt') ? 0 : 1)\"",
    ])).resolves.toBe(0);
    expect(stdout.join("\n")).toContain("tasks=1 success_rate=100%");
    await expect(readFile(join(workspace, "done.txt"), "utf-8")).resolves.toBe("ok");

    stdout = [];
    await expect(main(["status", "--workspace", workspace])).resolves.toBe(0);
    expect(stdout.join("\n")).toContain("# Loop State");
    expect(stdout.join("\n")).toContain("task-standalone - success");
  });

  it("reports doctor warnings before a queue or state exists", async () => {
    await expect(main(["doctor", "--workspace", workspace, "--json"])).resolves.toBe(0);

    const result = JSON.parse(stdout.join("\n")) as {
      ok: boolean;
      checks: Array<{ id: string; status: string }>;
    };
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "workspace", status: "ok" }),
      expect.objectContaining({ id: "task_queue", status: "warn" }),
      expect.objectContaining({ id: "state", status: "warn" }),
    ]));
  });

  it("rejects invalid arguments with a non-zero exit code", async () => {
    await expect(main(["enqueue", "Bad", "--workspace", workspace, "--priority", "101"])).resolves.toBe(1);
    expect(stderr.join("\n")).toContain("--priority must be between 1 and 100");

    stderr = [];
    await expect(main(["run", "--workspace", workspace, "--cycles", "0"])).resolves.toBe(1);
    expect(stderr.join("\n")).toContain("--cycles must be a positive integer");
  });
});
