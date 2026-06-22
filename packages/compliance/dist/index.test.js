import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadProofEvidence, listCompliancePacks, renderComplianceReport, renderComplianceReportFromProofDir, } from "./index.js";
let tmp;
beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "osstack-compliance-"));
});
afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
});
describe("compliance packs", () => {
    it("lists the built-in engineering-readiness pack with version metadata", () => {
        expect(listCompliancePacks()).toEqual(expect.arrayContaining([
            expect.objectContaining({
                id: "engineering-readiness",
                version: "2026.06.22",
                certification_claim: "none",
            }),
        ]));
    });
    it("keeps the repository pack manifest aligned with the built-in pack", async () => {
        const manifestPath = resolve(process.cwd(), "../../compliance-packs/engineering-readiness/manifest.json");
        const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
        expect(manifest).toMatchObject({
            id: "engineering-readiness",
            version: "2026.06.22",
            certification_claim: "none",
        });
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
    it("loads proof evidence from a proof directory", async () => {
        const proofDir = join(tmp, "release", "osstack-proof-run_123");
        await mkdir(proofDir, { recursive: true });
        await writeFile(join(proofDir, "manifest.json"), JSON.stringify(sampleEvidence().manifest, null, 2));
        await writeFile(join(proofDir, "verify-results.json"), JSON.stringify(sampleEvidence().verify, null, 2));
        await writeFile(join(proofDir, "policy-decision.json"), JSON.stringify(sampleEvidence().policy, null, 2));
        await writeFile(join(proofDir, "governance-results.json"), JSON.stringify(sampleEvidence().governance, null, 2));
        await writeFile(join(proofDir, "worktree-status.json"), JSON.stringify(sampleEvidence().worktree, null, 2));
        const evidence = await loadProofEvidence(proofDir);
        const markdown = await renderComplianceReportFromProofDir({
            packId: "engineering-readiness",
            runId: "run_123",
            proofDir,
        });
        expect(evidence.verify).toMatchObject({ status: "pass" });
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
        governance: { status: "pass", findings: [] },
        worktree: { status: "recorded", entries: [{ task_id: "t1", branch: "codex/t1", commit: "abc" }] },
    };
}
//# sourceMappingURL=index.test.js.map