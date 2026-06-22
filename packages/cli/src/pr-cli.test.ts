import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "./bin.js";

let tmp: string;
let logs: string[];
let errors: string[];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-pr-cli-"));
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

describe("pr CLI", () => {
  it("writes a dry-run PR body from loop state, events, and proof evidence", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const eventsPath = join(tmp, "events.jsonl");
    await writeEvents(eventsPath);
    const proofDir = join(tmp, "release", "osstack-proof-cli-pr-loop");
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, "governance-results.json"), JSON.stringify({
      status: "fail",
      ok: false,
      scanned_files: 2,
      findings: [{
        rule_id: "secret.api_key",
        severity: "error",
        file: join(tmp, "unsafe.ts"),
        line: 1,
        message: "Possible API key or token assignment.",
      }],
    }, null, 2));
    await writeFile(join(proofDir, "knowledge-results.json"), JSON.stringify({
      mode: "local",
      status: "recorded",
      packs: [{ id: "osstack-cloud-bootstrap", version: "2026.06.22", source_kind: "processed_mit" }],
      results: [{ chunk_id: "chunk-cloud-governance", title: "Cloud governance trace", score: 2 }],
    }, null, 2));

    const exitCode = await main([
      "pr",
      "--workspace",
      tmp,
      "--events",
      eventsPath,
      "--proof-dir",
      proofDir,
      "--dry-run",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as { path: string; mode: string };
    expect(summary).toMatchObject({
      mode: "dry-run",
      path: join(tmp, "reports", "pr-body-cli-pr-loop.md"),
    });
    const body = await readFile(summary.path, "utf-8");
    expect(body).toContain("# PR Evidence - cli-pr-loop");
    expect(body).toContain("## Summary");
    expect(body).toContain("cli-pr-task");
    expect(body).toContain("## Agent Selection");
    expect(body).toContain("matched code.test capability");
    expect(body).toContain("osstack agent scorecard codex-cli");
    expect(body).toContain("## Verification");
    expect(body).toContain("Verifier passed.");
    expect(body).toContain("## Governance");
    expect(body).toContain("secret.api_key");
    expect(body).toContain("## Knowledge Trace");
    expect(body).toContain("osstack-cloud-bootstrap@2026.06.22");
    expect(body).toContain("## Proof Pack");
    expect(body).toContain(proofDir);
  });

  it("fails closed for create mode until GitHub creation is implemented", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["pr", "--workspace", tmp, "--create"]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("osstack pr --create is not implemented yet");
  });
});

async function writeState(path: string): Promise<void> {
  await writeFile(path, JSON.stringify({
    loop_id: "cli-pr-loop",
    started_at: "2026-06-22T02:00:00.000Z",
    updated_at: "2026-06-22T02:05:00.000Z",
    completed_tasks: [{
      task_id: "cli-pr-task",
      capability: "code.test",
      outcome: "success",
      iterations: 1,
      agent_id: "codex-cli",
      duration_ms: 1000,
    }],
    in_progress: [],
    pending: [],
    decisions: ["Keep PR evidence deterministic."],
  }, null, 2));
}

async function writeEvents(path: string): Promise<void> {
  await writeFile(path, [
    JSON.stringify({
      event_id: "evt-pr-1",
      loop_id: "cli-pr-loop",
      type: "loop.plan.done",
      seq: 1,
      created_at: 1782090000000,
      payload: {
        task_id: "cli-pr-task",
        agent_id: "codex-cli",
        routing_reason: "matched code.test capability",
      },
    }),
    JSON.stringify({
      event_id: "evt-pr-2",
      loop_id: "cli-pr-loop",
      type: "loop.verify.done",
      seq: 2,
      created_at: 1782090001000,
      payload: {
        task_id: "cli-pr-task",
        pass: true,
        score: 1,
        reviewer_agent_id: "local-verifier",
        summary: "Verifier passed.",
      },
    }),
  ].join("\n") + "\n");
}
