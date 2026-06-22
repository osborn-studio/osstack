import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];
let oldLang: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-cli-scorecard-"));
  logs = [];
  errors = [];
  oldLang = process.env["OSSTACK_LANG"];
  vi.spyOn(console, "log").mockImplementation((...args) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args) => {
    errors.push(args.map(String).join(" "));
  });
});

afterEach(async () => {
  if (oldLang === undefined) delete process.env["OSSTACK_LANG"];
  else process.env["OSSTACK_LANG"] = oldLang;
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

  it("uses --loop as the state-file scorecard artifact id", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["scorecard", "--loop", "cli-scorecard-loop", "--workspace", tmp]);

    expect(exitCode).toBe(0);
    const markdownPath = join(tmp, "release", "osstack-scorecard-cli-scorecard-loop.md");
    const htmlPath = join(tmp, "release", "osstack-scorecard-cli-scorecard-loop.html");
    await expect(readFile(markdownPath, "utf-8")).resolves.toContain("# Osstack Scorecard - cli-scorecard-loop");
    await expect(readFile(htmlPath, "utf-8")).resolves.toContain("<!doctype html>");
  });

  it("rejects a --loop id that does not match state", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["scorecard", "--loop", "other-loop", "--workspace", tmp]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--loop other-loop does not match state loop_id=cli-scorecard-loop");
  });

  it("renders a Chinese scorecard with --lang zh-CN", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["scorecard", "--workspace", tmp, "--lang", "zh-CN", "--stdout"]);

    expect(exitCode).toBe(0);
    const output = logs.join("\n");
    expect(output).toContain("# Osstack 评分卡 - cli-scorecard-loop");
    expect(output).toContain("## 摘要");
    expect(output).toContain("## 评分项");
  });

  it("uses OSSTACK_LANG for written scorecard artifacts", async () => {
    process.env["OSSTACK_LANG"] = "zh-CN";
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["scorecard", "--workspace", tmp]);

    expect(exitCode).toBe(0);
    const markdownPath = join(tmp, "release", "osstack-scorecard-cli-scorecard-loop.md");
    const htmlPath = join(tmp, "release", "osstack-scorecard-cli-scorecard-loop.html");
    await expect(readFile(markdownPath, "utf-8")).resolves.toContain("# Osstack 评分卡 - cli-scorecard-loop");
    await expect(readFile(htmlPath, "utf-8")).resolves.toContain("<html lang=\"zh-CN\">");
    await expect(readFile(htmlPath, "utf-8")).resolves.toContain("<title>Osstack 评分卡 - cli-scorecard-loop</title>");
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
