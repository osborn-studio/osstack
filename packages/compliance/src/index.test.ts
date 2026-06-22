import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadProofEvidence,
  listCompliancePacks,
  renderComplianceReport,
  renderComplianceReportFromProofDir,
  renderProofView,
  renderProofViewFromProofDir,
} from "./index.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-compliance-"));
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("compliance packs", () => {
  it("lists built-in compliance mapping packs with version metadata", () => {
    const packs = listCompliancePacks();
    expect(packs.map((pack) => pack.id).sort()).toEqual([
      "engineering-readiness",
      "eu-ai-act-lite",
      "internal-audit",
      "iso27001-lite",
      "soc2-lite",
    ]);
    expect(packs).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "engineering-readiness", version: "2026.06.22", certification_claim: "none" }),
      expect.objectContaining({ id: "soc2-lite", version: "2026.06.22", certification_claim: "none" }),
      expect.objectContaining({ id: "iso27001-lite", version: "2026.06.22", certification_claim: "none" }),
      expect.objectContaining({ id: "eu-ai-act-lite", version: "2026.06.22", certification_claim: "none" }),
      expect.objectContaining({ id: "internal-audit", version: "2026.06.22", certification_claim: "none" }),
    ]));
  });

  it("keeps repository pack manifests aligned with built-in packs", async () => {
    for (const pack of listCompliancePacks()) {
      const manifestPath = resolve(process.cwd(), `../../compliance-packs/${pack.id}/manifest.json`);
      const manifest = JSON.parse(await readFile(manifestPath, "utf-8")) as {
        id: string;
        version: string;
        certification_claim: string;
      };

      expect(manifest).toMatchObject({
        id: pack.id,
        version: pack.version,
        certification_claim: "none",
      });
    }
  });

  it("renders evidence mappings without claiming external certification", () => {
    const markdown = renderComplianceReport({
      packId: "engineering-readiness",
      runId: "run_123",
      evidence: sampleEvidence(),
    });

    expect(markdown).toContain("# Osstack Compliance Report - engineering-readiness");
    expect(markdown).toContain("Pack: `engineering-readiness@2026.06.22`");
    expect(markdown).toContain("External certification claim: `none`");
    expect(markdown).toContain("This report is not a SOC 2, ISO 27001, EU AI Act, or third-party certification.");
    expect(markdown).toContain("| Change validation | PRESENT |");
    expect(markdown).toContain("| Evidence integrity | PRESENT |");
    expect(markdown).toContain("| Secure coding control | PRESENT |");
  });

  it("marks missing proof evidence explicitly", () => {
    const markdown = renderComplianceReport({
      packId: "engineering-readiness",
      runId: "run_missing",
      evidence: {
        manifest: { artifacts: [] },
      },
    });

    expect(markdown).toContain("| Change validation | MISSING |");
    expect(markdown).toContain("| Automated decision trace | MISSING |");
    expect(markdown).toContain("| Evidence integrity | MISSING |");
  });

  it("renders SOC 2 lite evidence mapping without claiming certification", () => {
    const markdown = renderComplianceReport({
      packId: "soc2-lite",
      runId: "run_123",
      evidence: sampleEvidence(),
    });

    expect(markdown).toContain("# Osstack Compliance Report - soc2-lite");
    expect(markdown).toContain("Pack: `soc2-lite@2026.06.22`");
    expect(markdown).toContain("External certification claim: `none`");
    expect(markdown).toContain("This report is not a SOC 2");
    expect(markdown).toContain("| Agent runtime trace | PRESENT | `agent-runtime.json` |");
  });

  it("loads proof evidence from a proof directory", async () => {
    const proofDir = join(tmp, "release", "osstack-proof-run_123");
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, "manifest.json"), JSON.stringify(sampleEvidence().manifest, null, 2));
    await writeFile(join(proofDir, "verify-results.json"), JSON.stringify(sampleEvidence().verify, null, 2));
    await writeFile(join(proofDir, "policy-decision.json"), JSON.stringify(sampleEvidence().policy, null, 2));
    await writeFile(join(proofDir, "agent-runtime.json"), JSON.stringify(sampleEvidence().agent_runtime, null, 2));
    await writeFile(join(proofDir, "governance-results.json"), JSON.stringify(sampleEvidence().governance, null, 2));
    await writeFile(join(proofDir, "worktree-status.json"), JSON.stringify(sampleEvidence().worktree, null, 2));

    const evidence = await loadProofEvidence(proofDir);
    const markdown = await renderComplianceReportFromProofDir({
      packId: "engineering-readiness",
      runId: "run_123",
      proofDir,
    });

    expect(evidence.verify).toMatchObject({ status: "pass" });
    expect(evidence.agent_runtime).toMatchObject({ status: "recorded" });
    expect(markdown).toContain("| Worktree isolation evidence | PRESENT |");
  });

  it("renders audience proof views by rearranging existing evidence", () => {
    const markdown = renderProofView({
      audience: "auditor",
      runId: "run_123",
      evidence: sampleEvidence(),
    });

    expect(markdown).toContain("# Osstack Proof View - auditor");
    expect(markdown).toContain("Run: `run_123`");
    expect(markdown).toContain("| Evidence integrity | PRESENT |");
    expect(markdown).toContain("| Automated decision trace | PRESENT |");
    expect(markdown).toContain("This view rearranges existing proof evidence and does not create new evidence.");
  });

  it("marks missing evidence in proof views", () => {
    const markdown = renderProofView({
      audience: "customer",
      runId: "run_missing",
      evidence: { manifest: { artifacts: [] } },
    });

    expect(markdown).toContain("| Evidence integrity | MISSING |");
    expect(markdown).toContain("| Change validation | MISSING |");
    expect(markdown).toContain("| Secure coding control | MISSING |");
  });

  it("renders proof views from an existing proof directory", async () => {
    const proofDir = join(tmp, "release", "osstack-proof-run_123");
    await mkdir(proofDir, { recursive: true });
    await writeFile(join(proofDir, "manifest.json"), JSON.stringify(sampleEvidence().manifest, null, 2));
    await writeFile(join(proofDir, "verify-results.json"), JSON.stringify(sampleEvidence().verify, null, 2));
    await writeFile(join(proofDir, "policy-decision.json"), JSON.stringify(sampleEvidence().policy, null, 2));
    await writeFile(join(proofDir, "agent-runtime.json"), JSON.stringify(sampleEvidence().agent_runtime, null, 2));
    await writeFile(join(proofDir, "governance-results.json"), JSON.stringify(sampleEvidence().governance, null, 2));
    await writeFile(join(proofDir, "worktree-status.json"), JSON.stringify(sampleEvidence().worktree, null, 2));

    const markdown = await renderProofViewFromProofDir({
      audience: "engineer",
      runId: "run_123",
      proofDir,
    });

    expect(markdown).toContain("# Osstack Proof View - engineer");
    expect(markdown).toContain("| Worktree isolation evidence | PRESENT |");
  });
});

function sampleEvidence() {
  return {
    manifest: {
      artifacts: [
        { path: "report.md", sha256: "a".repeat(64) },
        { path: "verify-results.json", sha256: "b".repeat(64) },
      ],
    },
    verify: { status: "pass", gates: [{ command: "pnpm test", exit_code: 0 }] },
    policy: { status: "recorded", decisions: [{ task_id: "t1", agent_id: "codex-cli", reason: "best fit" }] },
    agent_runtime: { status: "recorded", agents: [{ agent_id: "codex-cli", auth_mode: "subprocess/login-reuse" }] },
    governance: { status: "pass", findings: [] },
    worktree: { status: "recorded", entries: [{ task_id: "t1", branch: "codex/t1", commit: "abc" }] },
  };
}
