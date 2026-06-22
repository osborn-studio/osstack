import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-product-entry-"));
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(tmp, { recursive: true, force: true });
});

describe("product entry commands", () => {
  it("runs a top-level product doctor across loop readiness and agent availability", async () => {
    await mkdir(join(tmp, "tasks"));
    await writeFile(join(tmp, "tasks", "task.json"), JSON.stringify({
      task_id: "doctor-product-task",
      capability: "code.test",
      prompt: "Exercise top-level doctor",
    }));

    const exitCode = await main(["doctor", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(0);
    const result = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      workspace: string;
      loop: { ok: boolean; checks: Array<{ id: string; status: string }> };
      agents: {
        total: number;
        available: number;
        profiles: Array<{ id: string; auth_mode: string; roles: string[] }>;
        by_role: Record<string, string[]>;
      };
      next_steps: string[];
    };
    expect(result.workspace).toBe(tmp);
    expect(result.loop.ok).toBe(true);
    expect(result.loop.checks).toContainEqual(expect.objectContaining({
      id: "task_queue",
      status: "ok",
    }));
    expect(result.agents.total).toBeGreaterThan(0);
    expect(result.agents.profiles).toContainEqual(expect.objectContaining({
      id: "codex-cli",
      auth_mode: "subprocess/login-reuse",
      roles: expect.arrayContaining(["coding", "test-verify"]),
    }));
    expect(result.agents.by_role["coding"]).toContain("codex-cli");
    expect(result.next_steps.join("\n")).toContain("osstack loop run");
    expect(errors.join("\n")).toBe("");
  });

  it("prints runnable examples for common workflows", async () => {
    const exitCode = await main(["examples"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("Fix a bug");
    expect(output).toContain("Implement a feature");
    expect(output).toContain("Review git diff");
    expect(output).toContain("--auto-agent");
    expect(output).toContain("--worktree");
    expect(output).toContain("--proof");
  });

  it("prints a five-minute guide from install to proof", async () => {
    const exitCode = await main(["guide"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("5-minute quickstart");
    expect(output).toContain("osstack doctor");
    expect(output).toContain("osstack loop enqueue");
    expect(output).toContain("osstack loop run");
    expect(output).toContain("--report --scorecard --proof");
  });

  it("writes the guide to a requested output path", async () => {
    const output = join(tmp, "GUIDE.md");

    const exitCode = await main(["guide", "--output", output, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({ output });
    await expect(readFile(output, "utf-8")).resolves.toContain("5-minute quickstart");
  });
});
