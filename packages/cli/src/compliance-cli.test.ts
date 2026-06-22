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
  tmp = mkdtempSync(join(tmpdir(), "osstack-compliance-cli-"));
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

describe("compliance CLI", () => {
  it("lists built-in compliance packs", async () => {
    const exitCode = await main(["compliance", "list", "--json"]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      packs: expect.arrayContaining([
        expect.objectContaining({ id: "engineering-readiness", version: "2026.06.22", certification_claim: "none" }),
        expect.objectContaining({ id: "soc2-lite", version: "2026.06.22", certification_claim: "none" }),
        expect.objectContaining({ id: "iso27001-lite", version: "2026.06.22", certification_claim: "none" }),
        expect.objectContaining({ id: "eu-ai-act-lite", version: "2026.06.22", certification_claim: "none" }),
        expect.objectContaining({ id: "internal-audit", version: "2026.06.22", certification_claim: "none" }),
      ]),
    });
  });

  it("renders engineering readiness from a proof directory", async () => {
    const proofDir = join(tmp, "release", "osstack-proof-run_123");
    await writeProofEvidence(proofDir);

    const exitCode = await main([
      "compliance",
      "render",
      "run_123",
      "--pack",
      "engineering-readiness",
      "--proof-dir",
      proofDir,
      "--output",
      join(tmp, "compliance.md"),
      "--json",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      run_id: "run_123",
      pack_id: "engineering-readiness",
      pack_version: "2026.06.22",
      output: join(tmp, "compliance.md"),
    });
    await expect(readFile(join(tmp, "compliance.md"), "utf-8")).resolves.toContain("External certification claim: `none`");
  });

  it("renders a Chinese engineering readiness report with --lang zh-CN", async () => {
    const proofDir = join(tmp, "release", "osstack-proof-run_123");
    await writeProofEvidence(proofDir);

    const exitCode = await main([
      "compliance",
      "render",
      "run_123",
      "--pack",
      "engineering-readiness",
      "--proof-dir",
      proofDir,
      "--output",
      join(tmp, "compliance-zh.md"),
      "--lang",
      "zh-CN",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const markdown = await readFile(join(tmp, "compliance-zh.md"), "utf-8");
    expect(markdown).toContain("# Osstack 合规映射报告 - engineering-readiness");
    expect(markdown).toContain("外部认证声明：`none`");
    expect(markdown).toContain("| 控制项 | 状态 | 证据 | 映射 |");
  });
});

async function writeProofEvidence(proofDir: string): Promise<void> {
  await mkdir(proofDir, { recursive: true });
  await writeFile(join(proofDir, "manifest.json"), JSON.stringify({
    artifacts: [
      { path: "verify-results.json", sha256: "a".repeat(64), bytes: 128 },
      { path: "policy-decision.json", sha256: "b".repeat(64), bytes: 128 },
    ],
  }, null, 2));
  await writeFile(join(proofDir, "verify-results.json"), JSON.stringify({
    status: "pass",
    results: [{
      task_id: "t1",
      pass: true,
      score: 1,
      reviewer_agent_id: "local-verifier",
      summary: "verification passed",
      event_seq: 2,
    }],
  }, null, 2));
  await writeFile(join(proofDir, "policy-decision.json"), JSON.stringify({
    status: "recorded",
    decisions: [{
      task_id: "t1",
      agent_id: "codex-cli",
      auth_mode: "subprocess/login-reuse",
      roles: ["coding", "test-verify"],
      reason: "best fit",
      event_seq: 1,
    }],
  }, null, 2));
  await writeFile(join(proofDir, "agent-runtime.json"), JSON.stringify({
    status: "recorded",
    agents: [{
      agent_id: "codex-cli",
      auth_mode: "subprocess/login-reuse",
      roles: ["coding", "test-verify"],
      plan_event_seqs: [1],
    }],
  }, null, 2));
  await writeFile(join(proofDir, "governance-results.json"), JSON.stringify({ status: "pass", findings: [] }, null, 2));
  await writeFile(join(proofDir, "worktree-status.json"), JSON.stringify({
    status: "recorded",
    entries: [{
      task_id: "t1",
      status: "merged",
      branch: "codex/t1",
      commit: "abc",
      path: "/tmp/osstack-t1",
      event_seq: 3,
    }],
  }, null, 2));
}
