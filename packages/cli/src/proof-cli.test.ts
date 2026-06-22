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
    await writeFile(join(tmp, "unsafe.ts"), "const api_key = \"sk-test-secret-token\";\n");

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
      expect.objectContaining({ path: "governance-results.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    await expect(readFile(join(proofDir, "report.md"), "utf-8")).resolves.toContain("# Osstack Loop Report - cli-proof-loop");
    await expect(readFile(join(proofDir, "scorecard.html"), "utf-8")).resolves.toContain("<!doctype html>");
    const governance = JSON.parse(await readFile(join(proofDir, "governance-results.json"), "utf-8")) as {
      status: string;
      scanned_files: number;
      findings: Array<{ rule_id: string; file: string }>;
    };
    expect(governance).toMatchObject({
      status: "fail",
      scanned_files: expect.any(Number),
      findings: [expect.objectContaining({ rule_id: "secret.api_key", file: join(tmp, "unsafe.ts") })],
    });
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

  it("includes supplied events JSONL in the proof pack", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const eventsPath = join(tmp, "events.jsonl");
    await writeFile(eventsPath, [
      JSON.stringify({
        event_id: "evt-proof-1",
        loop_id: "cli-proof-loop",
        type: "loop.plan.done",
        seq: 1,
        created_at: 1782090000000,
        payload: {
          task_id: "proof-task",
          agent_id: "codex-cli",
          routing_reason: "matched code.test capability",
        },
      }),
      JSON.stringify({
        event_id: "evt-proof-2",
        loop_id: "cli-proof-loop",
        type: "loop.verify.done",
        seq: 2,
        created_at: 1782090001000,
        payload: {
          task_id: "proof-task",
          pass: true,
          score: 1,
          reviewer_agent_id: "local-verifier",
          summary: "Verifier passed.",
        },
      }),
      JSON.stringify({
        event_id: "evt-proof-3",
        loop_id: "cli-proof-loop",
        type: "loop.worktree.merged",
        seq: 3,
        created_at: 1782090002000,
        payload: {
          task_id: "proof-task",
          branch: "osstack/loop/proof",
          commit: "abc123",
        },
      }),
    ].join("\n") + "\n");

    const exitCode = await main(["proof", "--workspace", tmp, "--events", eventsPath]);

    expect(exitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    await expect(readFile(join(proofDir, "events.jsonl"), "utf-8")).resolves.toContain("loop.verify.done");
    await expect(readFile(join(proofDir, "report.md"), "utf-8")).resolves.toContain("## Verify Results");
    await expect(readFile(join(proofDir, "policy-decision.json"), "utf-8")).resolves.toContain("matched code.test capability");
    const verifyResults = JSON.parse(await readFile(join(proofDir, "verify-results.json"), "utf-8")) as {
      status: string;
      results: Array<{ task_id: string; pass: boolean; reviewer_agent_id: string }>;
    };
    expect(verifyResults).toMatchObject({
      status: "pass",
      results: [{
        task_id: "proof-task",
        pass: true,
        reviewer_agent_id: "local-verifier",
      }],
    });
    const worktreeStatus = JSON.parse(await readFile(join(proofDir, "worktree-status.json"), "utf-8")) as {
      status: string;
      entries: Array<{ task_id: string; status: string; branch: string; commit: string }>;
    };
    expect(worktreeStatus).toMatchObject({
      status: "recorded",
      entries: [{
        task_id: "proof-task",
        status: "merged",
        branch: "osstack/loop/proof",
        commit: "abc123",
      }],
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
