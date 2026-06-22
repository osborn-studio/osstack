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
  tmp = mkdtempSync(join(tmpdir(), "osstack-cli-proof-"));
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

describe("proof CLI", () => {
  it("writes a proof pack with manifest checksums", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["proof", "--workspace", tmp]);

    expect(exitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifest = JSON.parse(await readFile(join(proofDir, "manifest.json"), "utf-8")) as {
      loop_id: string;
      artifacts: Array<{ path: string; sha256: string }>;
    };
    expect(logs.join("\n")).toContain(`proof=${proofDir}`);
    expect(manifest.loop_id).toBe("cli-proof-loop");
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "report.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "scorecard.html", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "loop-state.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    await expect(readFile(join(proofDir, "report.md"), "utf-8")).resolves.toContain("# Osstack Loop Report - cli-proof-loop");
    await expect(readFile(join(proofDir, "scorecard.html"), "utf-8")).resolves.toContain("<!doctype html>");
  });

  it("prints JSON summary with --json", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["proof", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      loop_id: "cli-proof-loop",
      proof_dir: join(tmp, "release", "osstack-proof-cli-proof-loop"),
    });
  });

  it("fails when state is missing", async () => {
    const exitCode = await main(["proof", "--workspace", tmp]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("osstack: no loop state found");
  });
});

async function writeState(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    loop_id: "cli-proof-loop",
    started_at: "2026-06-22T04:00:00.000Z",
    updated_at: "2026-06-22T04:05:00.000Z",
    completed_tasks: [{
      task_id: "proof-task",
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
