import { execFileSync } from "node:child_process";
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
      run_id: string;
      osstack_version: string;
      workspace: string;
      agent_id: string;
      agent_ids: string[];
      artifacts: Array<{ path: string; sha256: string }>;
    };
    expect(logs.join("\n")).toContain(`proof=${proofDir}`);
    expect(manifest.loop_id).toBe("cli-proof-loop");
    expect(manifest.run_id).toBe("cli-proof-loop");
    expect(manifest.osstack_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.workspace).toBe(tmp);
    expect(manifest.agent_id).toBe("codex-cli");
    expect(manifest.agent_ids).toEqual(["codex-cli"]);
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "report.md", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "scorecard.html", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "loop-state.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "agent-runtime.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "governance-results.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "knowledge-results.json", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "sha256sums.txt", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    await expect(readFile(join(proofDir, "report.md"), "utf-8")).resolves.toContain("# Osstack Loop Report - cli-proof-loop");
    await expect(readFile(join(proofDir, "scorecard.html"), "utf-8")).resolves.toContain("<!doctype html>");
    const sha256sums = await readFile(join(proofDir, "sha256sums.txt"), "utf-8");
    expect(sha256sums).toContain("  report.md\n");
    expect(sha256sums).toContain("  governance-results.json\n");
    expect(sha256sums).toContain("  git-diff.patch\n");
    expect(sha256sums).not.toContain("manifest.json");
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

  it("includes a redacted git diff artifact in the proof pack", async () => {
    execFileSync("git", ["init"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: tmp });
    execFileSync("git", ["config", "user.name", "Test User"], { cwd: tmp });
    await writeState(join(tmp, "LOOP-STATE.json"));
    await writeFile(join(tmp, "app.ts"), "export const value = 'safe';\n");
    execFileSync("git", ["add", "LOOP-STATE.json", "app.ts"], { cwd: tmp, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: tmp, stdio: "ignore" });
    await writeFile(join(tmp, "app.ts"), "export const api_key = \"sk-1234567890abcdefghijklmnop\";\n");

    const exitCode = await main(["proof", "--workspace", tmp]);

    expect(exitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifest = JSON.parse(await readFile(join(proofDir, "manifest.json"), "utf-8")) as {
      artifacts: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "git-diff.patch", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    const diff = await readFile(join(proofDir, "git-diff.patch"), "utf-8");
    expect(diff).toContain("diff --git a/app.ts b/app.ts");
    expect(diff).toContain("[REDACTED:openai_key]");
    expect(diff).not.toContain("sk-1234567890abcdefghijklmnop");
  });

  it("records local knowledge trace evidence in the proof pack", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const packPath = join(tmp, "knowledge-pack.json");
    await writeFile(packPath, JSON.stringify({
      id: "osstack-cloud-bootstrap",
      version: "2026.06.22",
      name: "Osstack Cloud Bootstrap",
      license: "MIT-derived-processed",
      source_kind: "processed_mit",
      quality_score: 88,
      chunks: [{
        chunk_id: "chunk-cloud-governance",
        title: "Cloud governance trace",
        body: "Osstack Knowledge Cloud records pack ids and chunk ids in proof evidence.",
        tags: ["cloud", "governance"],
      }],
    }, null, 2));

    const exitCode = await main([
      "proof",
      "--workspace",
      tmp,
      "--knowledge-pack",
      packPath,
      "--knowledge-query",
      "cloud governance",
    ]);

    expect(exitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const knowledge = JSON.parse(await readFile(join(proofDir, "knowledge-results.json"), "utf-8")) as {
      mode: string;
      status: string;
      packs: Array<{ id: string; source_kind: string }>;
      results: Array<{ chunk_id: string }>;
    };
    expect(knowledge).toMatchObject({
      mode: "local",
      status: "recorded",
      packs: [expect.objectContaining({ id: "osstack-cloud-bootstrap", source_kind: "processed_mit" })],
      results: [expect.objectContaining({ chunk_id: "chunk-cloud-governance" })],
    });
  });

  it("can include an engineering readiness compliance report in the proof pack", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main([
      "proof",
      "--workspace",
      tmp,
      "--compliance-pack",
      "engineering-readiness",
    ]);

    expect(exitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifest = JSON.parse(await readFile(join(proofDir, "manifest.json"), "utf-8")) as {
      artifacts: Array<{ path: string }>;
    };
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "compliance-engineering-readiness.md" }),
    ]));
    await expect(readFile(join(proofDir, "compliance-engineering-readiness.md"), "utf-8"))
      .resolves.toContain("External certification claim: `none`");
  });

  it("renders an audience proof view from an existing proof pack without repacking evidence", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestBefore = await readFile(join(proofDir, "manifest.json"), "utf-8");

    logs = [];
    const viewExitCode = await main([
      "proof",
      "view",
      "cli-proof-loop",
      "--audience",
      "auditor",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(viewExitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as {
      run_id: string;
      audience: string;
      output: string;
      proof_dir: string;
    };
    expect(summary).toMatchObject({
      run_id: "cli-proof-loop",
      audience: "auditor",
      proof_dir: proofDir,
      output: join(tmp, "reports", "proof-view-auditor-cli-proof-loop.md"),
    });
    await expect(readFile(summary.output, "utf-8")).resolves.toContain("# Osstack Proof View - auditor");
    await expect(readFile(summary.output, "utf-8")).resolves.toContain("This view rearranges existing proof evidence");
    await expect(readFile(join(proofDir, "manifest.json"), "utf-8")).resolves.toBe(manifestBefore);
  });

  it("fails open from cloud knowledge mode to local proof evidence", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const packPath = join(tmp, "knowledge-pack.json");
    await writeFile(packPath, JSON.stringify({
      id: "osstack-cloud-bootstrap",
      version: "2026.06.22",
      name: "Osstack Cloud Bootstrap",
      license: "MIT-derived-processed",
      source_kind: "processed_mit",
      quality_score: 88,
      chunks: [{
        chunk_id: "chunk-cloud-governance",
        title: "Cloud governance trace",
        body: "Osstack Knowledge Cloud records pack ids and chunk ids in proof evidence.",
        tags: ["cloud", "governance"],
      }],
    }, null, 2));

    const exitCode = await main([
      "proof",
      "--workspace",
      tmp,
      "--knowledge-mode",
      "cloud",
      "--knowledge-pack",
      packPath,
      "--knowledge-query",
      "cloud governance",
    ]);

    expect(exitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const knowledge = JSON.parse(await readFile(join(proofDir, "knowledge-results.json"), "utf-8")) as {
      mode: string;
      status: string;
      fallback_mode: string;
      reason: string;
      results: Array<{ chunk_id: string }>;
    };
    expect(knowledge).toMatchObject({
      mode: "local",
      status: "recorded",
      fallback_mode: "local",
      results: [expect.objectContaining({ chunk_id: "chunk-cloud-governance" })],
    });
    expect(knowledge.reason).toContain("cloudUrl is required");
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
    await expect(readFile(join(proofDir, "report.md"), "utf-8")).resolves.toContain("subprocess/login-reuse");
    await expect(readFile(join(proofDir, "policy-decision.json"), "utf-8")).resolves.toContain("matched code.test capability");
    const agentRuntime = JSON.parse(await readFile(join(proofDir, "agent-runtime.json"), "utf-8")) as {
      status: string;
      agents: Array<{ agent_id: string; auth_mode: string; roles: string[] }>;
    };
    expect(agentRuntime).toMatchObject({
      status: "recorded",
      agents: [expect.objectContaining({
        agent_id: "codex-cli",
        auth_mode: "subprocess/login-reuse",
        roles: ["coding", "test-verify", "reviewer", "release/proof"],
      })],
    });
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
