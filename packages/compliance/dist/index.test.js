import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadCompliancePack, loadProofEvidence, listCompliancePacks, renderComplianceReport, renderComplianceReportFromProofDir, renderProofView, renderProofViewFromProofDir, validateCompliancePackFiles, } from "./index.js";
let tmp;
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
    it("keeps repository compliance pack files aligned and self-contained", async () => {
        for (const pack of listCompliancePacks()) {
            const packDir = resolve(process.cwd(), `../../compliance-packs/${pack.id}`);
            const loaded = await loadCompliancePack(packDir);
            const validation = await validateCompliancePackFiles(packDir);
            expect(loaded).toMatchObject({
                id: pack.id,
                version: pack.version,
                certification_claim: "none",
            });
            expect(loaded.controls).toEqual(pack.controls);
            expect(validation.required_present.length).toBeGreaterThan(0);
            expect(validation.template).toContain("{{controls}}");
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
    it("renders Chinese evidence mappings without claiming external certification", () => {
        const markdown = renderComplianceReport({
            packId: "engineering-readiness",
            runId: "run_123",
            evidence: sampleEvidence(),
            language: "zh-CN",
        });
        expect(markdown).toContain("# Osstack 合规映射报告 - engineering-readiness");
        expect(markdown).toContain("运行：`run_123`");
        expect(markdown).toContain("映射包：`engineering-readiness@2026.06.22`");
        expect(markdown).toContain("外部认证声明：`none`");
        expect(markdown).toContain("此报告不是 SOC 2、ISO 27001、EU AI Act 或第三方认证。");
        expect(markdown).toContain("它会把 osstack proof 证据映射到内部 Engineering Readiness 视图。");
        expect(markdown).toContain("| 控制项 | 状态 | 证据 | 映射 |");
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
        expect(markdown).toContain("No required evidence is missing for this audience view.");
        expect(markdown).toContain("This view rearranges existing proof evidence and does not create new evidence.");
    });
    it("renders Chinese audience proof views", () => {
        const markdown = renderProofView({
            audience: "auditor",
            runId: "run_123",
            evidence: sampleEvidence(),
            language: "zh-CN",
        });
        expect(markdown).toContain("# Osstack 证据视图 - auditor");
        expect(markdown).toContain("运行：`run_123`");
        expect(markdown).toContain("受众：`auditor`");
        expect(markdown).toContain("此视图会重排已有 proof 证据，不会创建新证据。");
        expect(markdown).toContain("此受众视图没有缺失必需证据。");
        expect(markdown).toContain("| 证据 | 状态 | 来源 | 关注点 |");
        expect(markdown).toContain("带 checksum 的证据清单");
    });
    it("marks missing evidence in proof views", () => {
        const markdown = renderProofView({
            audience: "customer",
            runId: "run_missing",
            evidence: { manifest: { artifacts: [] } },
        });
        expect(markdown).toContain("## Missing Evidence");
        expect(markdown).toContain("- REQUIRED EVIDENCE MISSING: Change validation (`verify-results.json`) - delivery validation summary");
        expect(markdown).toContain("- REQUIRED EVIDENCE MISSING: Secure coding control (`governance-results.json`) - safety checks summary");
        expect(markdown).toContain("| Evidence integrity | <strong style=\"color:#b00020\">MISSING</strong> |");
        expect(markdown).toContain("| Change validation | <strong style=\"color:#b00020\">MISSING</strong> |");
        expect(markdown).toContain("| Secure coding control | <strong style=\"color:#b00020\">MISSING</strong> |");
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
    it("marks malformed external proof evidence as missing", async () => {
        const proofDir = join(tmp, "release", "osstack-proof-run_malformed");
        await mkdir(proofDir, { recursive: true });
        await writeFile(join(proofDir, "manifest.json"), JSON.stringify({
            artifacts: [
                { path: "verify-results.json", sha256: "not-a-sha" },
            ],
        }, null, 2));
        await writeFile(join(proofDir, "verify-results.json"), JSON.stringify({
            status: "pass",
            results: [{ task_id: "t1", pass: true, score: 1, summary: "missing reviewer and event" }],
        }, null, 2));
        await writeFile(join(proofDir, "policy-decision.json"), JSON.stringify({
            status: "recorded",
            decisions: [{ task_id: "t1", agent_id: "codex-cli", reason: "missing auth mode and roles" }],
        }, null, 2));
        await writeFile(join(proofDir, "agent-runtime.json"), JSON.stringify({
            status: "recorded",
            agents: [{ agent_id: "codex-cli", auth_mode: "subprocess/login-reuse" }],
        }, null, 2));
        await writeFile(join(proofDir, "governance-results.json"), JSON.stringify({ status: "unknown", reason: "not evaluated" }, null, 2));
        await writeFile(join(proofDir, "worktree-status.json"), JSON.stringify({
            status: "recorded",
            entries: [{ task_id: "t1", status: "merged", branch: "codex/t1", commit: "abc", event_seq: 3 }],
        }, null, 2));
        await writeFile(join(proofDir, "knowledge-results.json"), JSON.stringify({
            mode: "local",
            status: "recorded",
            results: [{ chunk_id: "chunk-1" }],
        }, null, 2));
        const markdown = await renderProofViewFromProofDir({
            audience: "auditor",
            runId: "run_malformed",
            proofDir,
        });
        expect(markdown).toContain("- REQUIRED EVIDENCE MISSING: Evidence integrity (`manifest.json`) - checksumed artifact inventory");
        expect(markdown).toContain("- REQUIRED EVIDENCE MISSING: Change validation (`verify-results.json`) - change validation evidence");
        expect(markdown).toContain("- REQUIRED EVIDENCE MISSING: Automated decision trace (`policy-decision.json`) - automated decision record");
        expect(markdown).toContain("- REQUIRED EVIDENCE MISSING: Secure coding control (`governance-results.json`) - secure coding evidence");
        expect(markdown).toContain("- REQUIRED EVIDENCE MISSING: Worktree isolation evidence (`worktree-status.json`) - change isolation evidence");
        expect(markdown).toContain("- REQUIRED EVIDENCE MISSING: Knowledge trace (`knowledge-results.json`) - knowledge source trace");
    });
});
function sampleEvidence() {
    return {
        manifest: {
            artifacts: [
                { path: "report.md", sha256: "a".repeat(64), bytes: 12 },
                { path: "verify-results.json", sha256: "b".repeat(64), bytes: 128 },
            ],
        },
        verify: {
            status: "pass",
            results: [{
                    task_id: "t1",
                    pass: true,
                    score: 1,
                    reviewer_agent_id: "local-verifier",
                    summary: "pnpm test passed",
                    event_seq: 2,
                }],
        },
        policy: {
            status: "recorded",
            decisions: [{
                    task_id: "t1",
                    agent_id: "codex-cli",
                    auth_mode: "subprocess/login-reuse",
                    roles: ["coding", "test-verify"],
                    reason: "best fit",
                    event_seq: 1,
                }],
        },
        agent_runtime: {
            status: "recorded",
            agents: [{
                    agent_id: "codex-cli",
                    auth_mode: "subprocess/login-reuse",
                    roles: ["coding", "test-verify"],
                    plan_event_seqs: [1],
                }],
        },
        governance: { status: "pass", findings: [] },
        worktree: {
            status: "recorded",
            entries: [{
                    task_id: "t1",
                    status: "merged",
                    branch: "codex/t1",
                    commit: "abc",
                    path: "/tmp/osstack-t1",
                    event_seq: 3,
                }],
        },
        knowledge: {
            mode: "local",
            status: "recorded",
            packs: [{ id: "osstack-core/proof-and-scorecard", version: "2026.06.22", source_kind: "osstack_native" }],
            results: [{ chunk_id: "chunk-1", pack_id: "osstack-core/proof-and-scorecard", source_refs: ["src-1"] }],
        },
    };
}
//# sourceMappingURL=index.test.js.map