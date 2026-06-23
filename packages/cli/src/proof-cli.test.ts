import { execFileSync } from "node:child_process";
import { readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
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
      created_at: string;
      generated_at: string;
      workspace: string;
      agent_id: string;
      agent_ids: string[];
      artifacts: Array<{ path: string; sha256: string }>;
    };
    expect(logs.join("\n")).toContain(`proof=${proofDir}`);
    expect(manifest.loop_id).toBe("cli-proof-loop");
    expect(manifest.run_id).toBe("cli-proof-loop");
    expect(manifest.osstack_version).toMatch(/^\d+\.\d+\.\d+/);
    expect(manifest.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.generated_at).toBe(manifest.created_at);
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
    const governanceText = await readFile(join(proofDir, "governance-results.json"), "utf-8");
    expect(governanceText).toContain("[REDACTED:openai_key]");
    expect(governanceText).not.toContain("sk-test-secret-token");
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

  it("can include compliance reports in the proof pack manifest and zip", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main([
      "proof",
      "--workspace",
      tmp,
      "--compliance-pack",
      "engineering-readiness",
      "--compliance-pack",
      "soc2-lite",
      "--json",
    ]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as { proof_zip: string };
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifest = JSON.parse(await readFile(join(proofDir, "manifest.json"), "utf-8")) as {
      artifacts: Array<{ path: string }>;
      compliance_reports: Array<{ pack_id: string; path: string; certification_claim: string }>;
    };
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "compliance-engineering-readiness.md" }),
      expect.objectContaining({ path: "compliance-soc2-lite.md" }),
    ]));
    expect(manifest.compliance_reports).toEqual([
      {
        pack_id: "engineering-readiness",
        path: "compliance-engineering-readiness.md",
        certification_claim: "none",
      },
      {
        pack_id: "soc2-lite",
        path: "compliance-soc2-lite.md",
        certification_claim: "none",
      },
    ]);
    await expect(readFile(join(proofDir, "compliance-engineering-readiness.md"), "utf-8"))
      .resolves.toContain("External certification claim: `none`");
    await expect(readFile(join(proofDir, "compliance-soc2-lite.md"), "utf-8"))
      .resolves.toContain("External certification claim: `none`");
    const listing = execFileSync("unzip", ["-Z1", summary.proof_zip], { encoding: "utf-8" });
    expect(listing).toContain("compliance-engineering-readiness.md");
    expect(listing).toContain("compliance-soc2-lite.md");
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

  it("renders a Chinese audience proof view with --lang zh-CN", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);

    logs = [];
    const viewExitCode = await main([
      "proof",
      "view",
      "cli-proof-loop",
      "--audience",
      "auditor",
      "--workspace",
      tmp,
      "--lang",
      "zh-CN",
      "--json",
    ]);

    expect(viewExitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as { output: string };
    const markdown = await readFile(summary.output, "utf-8");
    expect(markdown).toContain("# Osstack 证据视图 - auditor");
    expect(markdown).toContain("受众：`auditor`");
    expect(markdown).toContain("此视图会重排已有 proof 证据，不会创建新证据。");
    expect(markdown).toContain("## 缺失证据");
    expect(markdown).toContain("| 证据 | 状态 | 来源 | 关注点 |");
    expect(markdown).toContain("| 证据完整性 |");
    expect(markdown).toContain("带 checksum 的证据清单");
  });

  it("highlights missing evidence in rendered proof views", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    await unlink(join(proofDir, "governance-results.json"));

    logs = [];
    const viewExitCode = await main([
      "proof",
      "view",
      "cli-proof-loop",
      "--audience",
      "customer",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(viewExitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as { output: string };
    const markdown = await readFile(summary.output, "utf-8");
    expect(markdown).toContain("## Missing Evidence");
    expect(markdown).toContain("- REQUIRED EVIDENCE MISSING: Secure coding control (`governance-results.json`) - safety checks summary");
    expect(markdown).toContain("| Secure coding control | <strong style=\"color:#b00020\">MISSING</strong> |");
  });

  it("validates proof evidence as a machine-readable release gate", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const eventsPath = join(tmp, "events.jsonl");
    await writeProofEvents(eventsPath);
    const proofExitCode = await main(["proof", "--workspace", tmp, "--events", eventsPath]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");

    logs = [];
    const validExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);
    expect(validExitCode).toBe(0);
    expect(JSON.parse(logs.join("\n"))).toMatchObject({
      run_id: "cli-proof-loop",
      proof_dir: proofDir,
      ok: true,
      missing: [],
    });

    await unlink(join(proofDir, "governance-results.json"));
    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      missing: Array<{ control_id: string; evidence_path: string }>;
    };
    expect(summary.ok).toBe(false);
    expect(summary.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({ control_id: "secure-coding-control", evidence_path: "governance-results.json" }),
    ]));
  });

  it("rejects proof packs when manifest artifact hashes no longer match files", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    await writeFile(join(proofDir, "report.md"), "# Tampered report\n");

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity).toMatchObject({ ok: false });
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "report.md", code: "sha256_mismatch" }),
      expect.objectContaining({ path: "report.md", code: "bytes_mismatch" }),
    ]));
  });

  it("rejects proof packs when sha256sums entries diverge from the manifest", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const sha256sumsPath = join(proofDir, "sha256sums.txt");
    const sha256sums = await readFile(sha256sumsPath, "utf-8");
    await writeFile(
      sha256sumsPath,
      sha256sums.replace(/^[a-f0-9]{64} {2}report\.md$/m, `${"b".repeat(64)}  report.md`),
    );

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "report.md", code: "sha256sums_mismatch" }),
    ]));
  });

  it("rejects proof checksum inventories with traversal paths", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const sha256sumsPath = join(proofDir, "sha256sums.txt");
    const sha256sums = await readFile(sha256sumsPath, "utf-8");
    await writeFile(
      sha256sumsPath,
      `${sha256sums}${"a".repeat(64)}  nested/../report.md\n`,
    );

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "nested/../report.md", code: "sha256sums_unsafe_path" }),
    ]));
  });

  it("rejects proof checksum inventories with duplicate and absolute paths", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const sha256sumsPath = join(proofDir, "sha256sums.txt");
    const sha256sums = await readFile(sha256sumsPath, "utf-8");
    const reportLine = sha256sums.match(/^[a-f0-9]{64} {2}report\.md$/m)?.[0];
    expect(reportLine).toBeDefined();
    await writeFile(
      sha256sumsPath,
      `${sha256sums}${reportLine}\n${"a".repeat(64)}  /tmp/osstack-proof-leak.txt\n`,
    );

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "report.md", code: "sha256sums_duplicate_entry" }),
      expect.objectContaining({ path: "/tmp/osstack-proof-leak.txt", code: "sha256sums_unsafe_path" }),
    ]));
  });

  it("rejects proof manifests missing required timestamps", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      created_at?: string;
    };
    delete manifest.created_at;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "manifest.json", code: "manifest_missing_created_at" }),
    ]));
  });

  it("rejects proof manifests with invalid identity fields", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      kind?: string;
      schema_version?: number;
    };
    manifest.kind = "not.osstack.proof_pack";
    manifest.schema_version = 0;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "manifest.json", code: "manifest_invalid_kind" }),
      expect.objectContaining({ path: "manifest.json", code: "manifest_invalid_schema_version" }),
    ]));
  });

  it("rejects proof manifests missing required run and agent identity", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      run_id?: string;
      osstack_version?: string;
      agent_ids?: string[];
    };
    delete manifest.run_id;
    manifest.osstack_version = "";
    manifest.agent_ids = [];
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "manifest.json", code: "manifest_missing_run_id" }),
      expect.objectContaining({ path: "manifest.json", code: "manifest_missing_osstack_version" }),
      expect.objectContaining({ path: "manifest.json", code: "manifest_missing_agent_ids" }),
    ]));
  });

  it("rejects proof manifest artifacts with invalid checksum metadata", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      artifacts: Array<{ path: string; sha256: string; bytes: number }>;
    };
    const reportArtifact = manifest.artifacts.find((artifact) => artifact.path === "report.md");
    expect(reportArtifact).toBeDefined();
    reportArtifact!.sha256 = "not-a-sha256";
    reportArtifact!.bytes = -1;
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "report.md", code: "artifact_invalid_sha256" }),
      expect.objectContaining({ path: "report.md", code: "artifact_invalid_bytes" }),
    ]));
  });

  it("rejects proof manifests and artifacts with schema-unknown fields", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      attestation?: string;
      artifacts: Array<{ path: string; sha256: string; bytes: number; claim?: string }>;
    };
    manifest.attestation = "externally certified";
    const reportArtifact = manifest.artifacts.find((artifact) => artifact.path === "report.md");
    expect(reportArtifact).toBeDefined();
    reportArtifact!.claim = "human-reviewed";
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string; actual?: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "manifest.json", code: "manifest_unexpected_field", actual: "attestation" }),
      expect.objectContaining({ path: "report.md", code: "artifact_unexpected_field", actual: "claim" }),
    ]));
  });

  it("rejects malformed compliance report references in proof manifests", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main([
      "proof",
      "--workspace",
      tmp,
      "--compliance-pack",
      "engineering-readiness",
    ]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      compliance_reports: Array<{
        pack_id: string;
        path: string;
        certification_claim: string;
        reviewer?: string;
      }>;
    };
    manifest.compliance_reports[0] = {
      ...manifest.compliance_reports[0]!,
      path: "missing-compliance.md",
      certification_claim: "soc2",
      reviewer: "external-auditor",
    };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string; actual?: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "missing-compliance.md", code: "compliance_report_missing_artifact" }),
      expect.objectContaining({ path: "missing-compliance.md", code: "compliance_report_invalid_certification_claim", actual: "soc2" }),
      expect.objectContaining({ path: "missing-compliance.md", code: "compliance_report_unexpected_field", actual: "reviewer" }),
    ]));
  });

  it("rejects proof manifests with duplicate artifact paths", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      artifacts: Array<{ path: string; sha256: string; bytes: number }>;
    };
    const reportArtifact = manifest.artifacts.find((artifact) => artifact.path === "report.md");
    expect(reportArtifact).toBeDefined();
    manifest.artifacts.push({ ...reportArtifact! });
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "report.md", code: "duplicate_artifact_path" }),
    ]));
  });

  it("rejects proof zips that no longer contain manifest artifacts", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofZip = join(tmp, "release", "osstack-proof-cli-proof-loop.zip");
    execFileSync("zip", ["-d", proofZip, "report.md"], { stdio: "ignore" });

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      archive_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.archive_integrity).toMatchObject({ ok: false });
    expect(summary.archive_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "report.md", code: "proof_zip_missing_entry" }),
    ]));
  });

  it("validates proof zip inventories without relying on an external unzip binary", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const eventsPath = join(tmp, "events.jsonl");
    await writeProofEvents(eventsPath);
    const proofExitCode = await main(["proof", "--workspace", tmp, "--events", eventsPath]);
    expect(proofExitCode).toBe(0);
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "";

    try {
      logs = [];
      const validExitCode = await main([
        "proof",
        "validate",
        "cli-proof-loop",
        "--workspace",
        tmp,
        "--json",
      ]);

      expect(validExitCode).toBe(0);
      const summary = JSON.parse(logs.join("\n")) as {
        ok: boolean;
        archive_integrity: { ok: boolean; checked: boolean; issues: Array<unknown> };
      };
      expect(summary.ok).toBe(true);
      expect(summary.archive_integrity).toMatchObject({ ok: true, checked: true, issues: [] });
    } finally {
      process.env["PATH"] = originalPath;
    }
  });

  it("rejects proof packs when manifest artifacts are missing from disk", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    await unlink(join(proofDir, "report.md"));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "report.md", code: "missing_artifact" }),
    ]));
  });

  it("rejects proof manifests that point artifacts outside the proof directory", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      artifacts: Array<{ path: string; sha256: string; bytes: number }>;
    };
    manifest.artifacts[0] = { path: "../outside.txt", sha256: "a".repeat(64), bytes: 1 };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "../outside.txt", code: "path_outside_proof_dir" }),
    ]));
  });

  it("rejects proof manifest artifact paths that contain traversal segments", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifestPath = join(proofDir, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
      artifacts: Array<{ path: string; sha256: string; bytes: number }>;
    };
    const reportArtifact = manifest.artifacts.find((artifact) => artifact.path === "report.md");
    expect(reportArtifact).toBeDefined();
    manifest.artifacts[0] = { ...reportArtifact!, path: "nested/../report.md" };
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      file_integrity: { ok: boolean; issues: Array<{ path: string; code: string }> };
    };
    expect(summary.ok).toBe(false);
    expect(summary.file_integrity.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "nested/../report.md", code: "path_outside_proof_dir" }),
    ]));
  });

  it("rejects malformed JSON and wrong-shaped proof directory artifacts", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const proofExitCode = await main(["proof", "--workspace", tmp]);
    expect(proofExitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    await writeFile(join(proofDir, "manifest.json"), "{");
    await writeFile(join(proofDir, "verify-results.json"), "[]");
    await writeFile(join(proofDir, "policy-decision.json"), "null");

    logs = [];
    const invalidExitCode = await main([
      "proof",
      "validate",
      "cli-proof-loop",
      "--workspace",
      tmp,
      "--json",
    ]);

    expect(invalidExitCode).toBe(1);
    const summary = JSON.parse(logs.join("\n")) as {
      ok: boolean;
      missing: Array<{ control_id: string; evidence_path: string; reason: string }>;
    };
    expect(summary.ok).toBe(false);
    expect(summary.missing).toEqual(expect.arrayContaining([
      expect.objectContaining({
        control_id: "evidence-integrity",
        evidence_path: "manifest.json",
        reason: "missing or malformed proof evidence",
      }),
      expect.objectContaining({
        control_id: "change-validation",
        evidence_path: "verify-results.json",
        reason: "missing or malformed proof evidence",
      }),
      expect.objectContaining({
        control_id: "automated-decision-trace",
        evidence_path: "policy-decision.json",
        reason: "missing or malformed proof evidence",
      }),
    ]));
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
    const summary = JSON.parse(logs.join("\n")) as { loop_id: string; proof_dir: string; proof_zip: string };
    expect(summary).toMatchObject({
      loop_id: "cli-proof-loop",
      proof_dir: join(tmp, "release", "osstack-proof-cli-proof-loop"),
      proof_zip: join(tmp, "release", "osstack-proof-cli-proof-loop.zip"),
    });
    const signature = await readFile(summary.proof_zip);
    expect(signature.subarray(0, 4).toString("hex")).toBe("504b0304");
    await expect(stat(summary.proof_zip)).resolves.toMatchObject({ size: expect.any(Number) });
    const listing = execFileSync("unzip", ["-Z1", summary.proof_zip], { encoding: "utf-8" });
    expect(listing).toContain("manifest.json");
    expect(listing).toContain("report.md");
  });

  it("uses --loop as the state-file proof artifact id", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["proof", "--loop", "cli-proof-loop", "--workspace", tmp, "--json"]);

    expect(exitCode).toBe(0);
    const summary = JSON.parse(logs.join("\n")) as { loop_id: string; proof_dir: string; proof_zip: string };
    expect(summary).toMatchObject({
      loop_id: "cli-proof-loop",
      proof_dir: join(tmp, "release", "osstack-proof-cli-proof-loop"),
      proof_zip: join(tmp, "release", "osstack-proof-cli-proof-loop.zip"),
    });
    await expect(readFile(join(summary.proof_dir, "manifest.json"), "utf-8")).resolves.toContain("\"run_id\": \"cli-proof-loop\"");
  });

  it("rejects a --loop id that does not match state", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));

    const exitCode = await main(["proof", "--loop", "other-loop", "--workspace", tmp]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("--loop other-loop does not match state loop_id=cli-proof-loop");
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
          worktree_path: join(tmp, ".osstack-worktrees", "proof-task"),
        },
      }),
    ].join("\n") + "\n");

    const exitCode = await main(["proof", "--workspace", tmp, "--events", eventsPath]);

    expect(exitCode).toBe(0);
    const proofDir = join(tmp, "release", "osstack-proof-cli-proof-loop");
    const manifest = JSON.parse(await readFile(join(proofDir, "manifest.json"), "utf-8")) as {
      artifacts: Array<{ path: string; sha256: string }>;
    };
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "checker-output/proof-task-local-verifier.txt", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
      expect.objectContaining({ path: "logs/events.log", sha256: expect.stringMatching(/^[a-f0-9]{64}$/) }),
    ]));
    await expect(readFile(join(proofDir, "events.jsonl"), "utf-8")).resolves.toContain("loop.verify.done");
    await expect(readFile(join(proofDir, "checker-output", "proof-task-local-verifier.txt"), "utf-8")).resolves.toContain("Verifier passed.");
    await expect(readFile(join(proofDir, "logs", "events.log"), "utf-8")).resolves.toContain("2 loop.verify.done proof-task verify passed: Verifier passed.");
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
        path: join(tmp, ".osstack-worktrees", "proof-task"),
      }],
    });
  });

  it("rejects malformed external proof event evidence", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const eventsPath = join(tmp, "bad-events.jsonl");
    await writeFile(eventsPath, [
      JSON.stringify({
        event_id: "evt-bad-verify",
        loop_id: "cli-proof-loop",
        type: "loop.verify.done",
        seq: 1,
        created_at: 1782090000000,
        payload: {
          task_id: "proof-task",
          pass: true,
          score: 1,
          summary: "Verifier passed but reviewer id is missing.",
        },
      }),
      JSON.stringify({
        event_id: "evt-bad-worktree",
        loop_id: "cli-proof-loop",
        type: "loop.worktree.merged",
        seq: 2,
        created_at: 1782090001000,
        payload: {
          task_id: "proof-task",
          branch: "osstack/loop/proof",
          commit: "abc123",
        },
      }),
    ].join("\n") + "\n");

    const exitCode = await main(["proof", "--workspace", tmp, "--events", eventsPath]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("proof evidence validation failed");
    expect(errors.join("\n")).toContain("verify-results.results[0].reviewer_agent_id is required");
    expect(errors.join("\n")).toContain("worktree-status.entries[0].path is required");
  });

  it("rejects external events that do not conform to the event schema shape", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const eventsPath = join(tmp, "bad-event-shape.jsonl");
    await writeFile(eventsPath, `${JSON.stringify({
      event_id: "evt-bad-shape",
      loop_id: "cli-proof-loop",
      type: "loop.verify.done",
      seq: 1,
      created_at: "2026-06-22T00:00:00.000Z",
      payload: "not an object",
      extra: true,
    })}\n`);

    const exitCode = await main(["proof", "--workspace", tmp, "--events", eventsPath]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("invalid events JSONL");
    expect(errors.join("\n")).toContain("events[0].created_at must be a finite number");
    expect(errors.join("\n")).toContain("events[0].payload must be an object when present");
    expect(errors.join("\n")).toContain("events[0].extra is not allowed");
  });

  it("rejects external events with non-monotonic or duplicate sequencing evidence", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const eventsPath = join(tmp, "bad-event-order.jsonl");
    await writeFile(eventsPath, [
      JSON.stringify({
        event_id: "evt-duplicate",
        loop_id: "cli-proof-loop",
        type: "loop.plan.done",
        seq: 2,
        created_at: 1782090000000,
        payload: {
          task_id: "proof-task",
          agent_id: "codex-cli",
          routing_reason: "matched code.test capability",
        },
      }),
      JSON.stringify({
        event_id: "evt-duplicate",
        loop_id: "cli-proof-loop",
        type: "loop.verify.done",
        seq: 1,
        created_at: 1782090001000,
        payload: {
          task_id: "proof-task",
          pass: true,
          score: 1,
          reviewer_agent_id: "local-verifier",
          summary: "Verifier passed.",
        },
      }),
    ].join("\n") + "\n");

    const exitCode = await main(["proof", "--workspace", tmp, "--events", eventsPath]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("events[1].event_id must be unique");
    expect(errors.join("\n")).toContain("events[1].seq must be greater than previous event seq 2");
  });

  it("rejects malformed policy decision evidence before writing a proof pack", async () => {
    await writeState(join(tmp, "LOOP-STATE.json"));
    const eventsPath = join(tmp, "bad-policy-events.jsonl");
    await writeFile(eventsPath, [
      JSON.stringify({
        event_id: "evt-bad-policy",
        loop_id: "cli-proof-loop",
        type: "loop.plan.done",
        seq: 1,
        created_at: 1782090000000,
        payload: {
          task_id: "proof-task",
          agent_id: "codex-cli",
        },
      }),
    ].join("\n") + "\n");

    const exitCode = await main(["proof", "--workspace", tmp, "--events", eventsPath]);

    expect(exitCode).toBe(1);
    expect(errors.join("\n")).toContain("proof evidence validation failed");
    expect(errors.join("\n")).toContain("policy-decision.decisions[0].reason is required");
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

async function writeProofEvents(path: string): Promise<void> {
  await writeFile(path, [
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
        worktree_path: join(tmp, ".osstack-worktrees", "proof-task"),
      },
    }),
  ].join("\n") + "\n");
}
