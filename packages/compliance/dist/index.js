import { readFile } from "node:fs/promises";
import { join } from "node:path";
const BUILTIN_PACKS = [{
        id: "engineering-readiness",
        version: "2026.06.22",
        name: "Engineering Readiness",
        certification_claim: "none",
        controls: [
            {
                id: "change-validation",
                title: "Change validation",
                evidence_path: "verify-results.json",
                description: "Verify gates or scorecard evidence show whether the change was validated.",
            },
            {
                id: "automated-decision-trace",
                title: "Automated decision trace",
                evidence_path: "policy-decision.json",
                description: "Policy decisions record agent selection and routing rationale.",
            },
            {
                id: "secure-coding-control",
                title: "Secure coding control",
                evidence_path: "governance-results.json",
                description: "Governance findings map deterministic checks to secure coding evidence.",
            },
            {
                id: "evidence-integrity",
                title: "Evidence integrity",
                evidence_path: "manifest.json",
                description: "Proof manifest artifacts carry SHA-256 checksums.",
            },
            {
                id: "worktree-isolation",
                title: "Worktree isolation evidence",
                evidence_path: "worktree-status.json",
                description: "Worktree branch and commit evidence show isolated execution context.",
            },
            {
                id: "knowledge-trace",
                title: "Knowledge trace",
                evidence_path: "knowledge-results.json",
                description: "Knowledge pack and chunk traces show which retrieved context was used.",
            },
        ],
    }];
export function listCompliancePacks() {
    return BUILTIN_PACKS.map((pack) => ({
        ...pack,
        controls: pack.controls.map((control) => ({ ...control })),
    }));
}
export function getCompliancePack(packId) {
    const pack = BUILTIN_PACKS.find((candidate) => candidate.id === packId);
    if (pack === undefined)
        throw new Error(`unknown compliance pack: ${packId}`);
    return {
        ...pack,
        controls: pack.controls.map((control) => ({ ...control })),
    };
}
export async function loadProofEvidence(proofDir) {
    const [manifest, verify, policy, governance, worktree, knowledge] = await Promise.all([
        readJsonIfExists(join(proofDir, "manifest.json")),
        readJsonIfExists(join(proofDir, "verify-results.json")),
        readJsonIfExists(join(proofDir, "policy-decision.json")),
        readJsonIfExists(join(proofDir, "governance-results.json")),
        readJsonIfExists(join(proofDir, "worktree-status.json")),
        readJsonIfExists(join(proofDir, "knowledge-results.json")),
    ]);
    return { manifest, verify, policy, governance, worktree, knowledge };
}
export async function renderComplianceReportFromProofDir(options) {
    return renderComplianceReport({
        packId: options.packId,
        runId: options.runId,
        evidence: await loadProofEvidence(options.proofDir),
    });
}
export function renderComplianceReport(options) {
    const pack = getCompliancePack(options.packId);
    const rows = pack.controls.map((control) => {
        const status = controlStatus(control.id, options.evidence);
        return `| ${control.title} | ${status} | \`${control.evidence_path}\` | ${control.description} |`;
    });
    return [
        `# Osstack Compliance Report - ${pack.id}`,
        "",
        `Run: \`${options.runId}\``,
        `Pack: \`${pack.id}@${pack.version}\``,
        "External certification claim: `none`",
        "",
        "This report is not a SOC 2, ISO 27001, EU AI Act, or third-party certification.",
        "It maps osstack proof evidence to an internal engineering-readiness view.",
        "",
        "| Control | Status | Evidence | Mapping |",
        "|---|---|---|---|",
        ...rows,
        "",
    ].join("\n");
}
function controlStatus(controlId, evidence) {
    switch (controlId) {
        case "change-validation":
            return hasObject(evidence.verify) ? "PRESENT" : "MISSING";
        case "automated-decision-trace":
            return hasObject(evidence.policy) && hasNonEmptyArray(evidence.policy, "decisions") ? "PRESENT" : "MISSING";
        case "secure-coding-control":
            return hasObject(evidence.governance) ? "PRESENT" : "MISSING";
        case "evidence-integrity":
            return hasObject(evidence.manifest) && hasNonEmptyArray(evidence.manifest, "artifacts") ? "PRESENT" : "MISSING";
        case "worktree-isolation":
            return hasObject(evidence.worktree) ? "PRESENT" : "MISSING";
        case "knowledge-trace":
            return hasObject(evidence.knowledge) ? "PRESENT" : "MISSING";
    }
    return "MISSING";
}
async function readJsonIfExists(path) {
    try {
        return JSON.parse(await readFile(path, "utf-8"));
    }
    catch {
        return undefined;
    }
}
function hasObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
}
function hasNonEmptyArray(value, key) {
    return hasObject(value) && Array.isArray(value[key]) && value[key].length > 0;
}
//# sourceMappingURL=index.js.map