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
      packs: [expect.objectContaining({
        id: "engineering-readiness",
        version: "2026.06.22",
        certification_claim: "none",
      })],
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
});

async function writeProofEvidence(proofDir: string): Promise<void> {
  await mkdir(proofDir, { recursive: true });
  await writeFile(join(proofDir, "manifest.json"), JSON.stringify({
    artifacts: [
      { path: "verify-results.json", sha256: "a".repeat(64) },
      { path: "policy-decision.json", sha256: "b".repeat(64) },
    ],
  }, null, 2));
  await writeFile(join(proofDir, "verify-results.json"), JSON.stringify({ status: "pass" }, null, 2));
  await writeFile(join(proofDir, "policy-decision.json"), JSON.stringify({
    status: "recorded",
    decisions: [{ task_id: "t1", agent_id: "codex-cli", reason: "best fit" }],
  }, null, 2));
  await writeFile(join(proofDir, "governance-results.json"), JSON.stringify({ status: "pass", findings: [] }, null, 2));
  await writeFile(join(proofDir, "worktree-status.json"), JSON.stringify({ status: "recorded", entries: [] }, null, 2));
}
