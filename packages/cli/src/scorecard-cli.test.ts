import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-cli-scorecard-"));
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

describe("scorecard CLI", () => {
  it("writes markdown and html scorecards from workspace state", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["scorecard", "--workspace", tmp]);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("markdown=");
    const markdownPath = join(tmp, "release", "osstack-scorecard-cli-scorecard-loop.md");
    const htmlPath = join(tmp, "release", "osstack-scorecard-cli-scorecard-loop.html");
    await expect(readFile(markdownPath, "utf-8")).resolves.toContain("# Osstack Scorecard - cli-scorecard-loop");
    await expect(readFile(htmlPath, "utf-8")).resolves.toContain("<!doctype html>");
  });

  it("prints markdown instead of writing files with --stdout", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["scorecard", "--workspace", tmp, "--stdout"]);

    expect(exitCode).toBe(0);
    expect(logs.join("\n")).toContain("# Osstack Scorecard - cli-scorecard-loop");
  });

  it("fails when state is missing", async () => {
    const exitCode = await main(["scorecard", "--workspace", tmp]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("osstack: no loop state found");
  });
});

async function writeState(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    loop_id: "cli-scorecard-loop",
    started_at: "2026-06-22T03:00:00.000Z",
    updated_at: "2026-06-22T03:05:00.000Z",
    completed_tasks: [{
      task_id: "scorecard-task",
      capability: "code.test",
      outcome: "success",
      iterations: 1,
      agent_id: "codex-cli",
      duration_ms: 1000,
    }],
    in_progress: [],
    pending: [],
    decisions: [],
  }, null, 2));
}
