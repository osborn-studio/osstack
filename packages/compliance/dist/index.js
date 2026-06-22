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
    }, {
        id: "soc2-lite",
        version: "2026.06.22",
        name: "SOC 2 Lite Internal Mapping",
        certification_claim: "none",
        controls: [
            {
                id: "soc2-change-validation",
                title: "Change validation",
                evidence_path: "verify-results.json",
                description: "Maps verification results to an internal change-management evidence view.",
            },
            {
                id: "soc2-automated-decision-trace",
                title: "Automated decision trace",
                evidence_path: "policy-decision.json",
                description: "Records the agent selection and routing rationale for audit review.",
            },
            {
                id: "soc2-secure-development",
                title: "Secure development checks",
                evidence_path: "governance-results.json",
                description: "Maps deterministic governance findings to secure-development evidence.",
            },
            {
                id: "soc2-evidence-integrity",
                title: "Evidence integrity",
                evidence_path: "manifest.json",
                description: "Uses proof manifest checksums as tamper-evident artifact inventory.",
            },
            {
                id: "soc2-agent-runtime",
                title: "Agent runtime trace",
                evidence_path: "agent-runtime.json",
                description: "Shows which agent runtime modes participated in the run.",
            },
        ],
    }, {
        id: "iso27001-lite",
        version: "2026.06.22",
        name: "ISO 27001 Lite Internal Mapping",
        certification_claim: "none",
        controls: [
            {
                id: "iso-change-control",
                title: "Change control evidence",
                evidence_path: "verify-results.json",
                description: "Verification gates provide internal evidence for change control.",
            },
            {
                id: "iso-secure-engineering",
                title: "Secure engineering evidence",
                evidence_path: "governance-results.json",
                description: "Governance checks provide deterministic secure-engineering signals.",
            },
            {
                id: "iso-change-isolation",
                title: "Change isolation",
                evidence_path: "worktree-status.json",
                description: "Worktree evidence records isolated execution branches and commits.",
            },
            {
                id: "iso-evidence-inventory",
                title: "Evidence inventory",
                evidence_path: "manifest.json",
                description: "Proof manifest lists artifacts with SHA-256 checksums.",
            },
            {
                id: "iso-knowledge-source-trace",
                title: "Knowledge source trace",
                evidence_path: "knowledge-results.json",
                description: "Knowledge traces record retrieved Osstack-native pack and chunk ids.",
            },
        ],
    }, {
        id: "eu-ai-act-lite",
        version: "2026.06.22",
        name: "EU AI Act Lite Internal Mapping",
        certification_claim: "none",
        controls: [
            {
                id: "eu-automated-decision-record",
                title: "Automated decision record",
                evidence_path: "policy-decision.json",
                description: "Policy decision evidence records automated agent selection rationale.",
            },
            {
                id: "eu-agent-runtime-transparency",
                title: "Agent runtime transparency",
                evidence_path: "agent-runtime.json",
                description: "Agent runtime evidence records auth/invocation mode and role tags.",
            },
            {
                id: "eu-technical-robustness",
                title: "Technical robustness evidence",
                evidence_path: "verify-results.json",
                description: "Verification results show whether the run met its technical gates.",
            },
            {
                id: "eu-risk-and-safety",
                title: "Risk and safety checks",
                evidence_path: "governance-results.json",
                description: "Governance findings provide deterministic safety and secure-coding signals.",
            },
            {
                id: "eu-knowledge-traceability",
                title: "Knowledge traceability",
                evidence_path: "knowledge-results.json",
                description: "Knowledge evidence records pack and chunk ids used as retrieved context.",
            },
        ],
    }, {
        id: "internal-audit",
        version: "2026.06.22",
        name: "Internal Audit",
        certification_claim: "none",
        controls: [
            {
                id: "audit-proof-inventory",
                title: "Proof inventory",
                evidence_path: "manifest.json",
                description: "Proof manifest gives the artifact inventory and integrity hashes.",
            },
            {
                id: "audit-validation",
                title: "Validation evidence",
                evidence_path: "verify-results.json",
                description: "Verification evidence records pass/fail status for the run.",
            },
            {
                id: "audit-agent-selection",
                title: "Agent selection evidence",
                evidence_path: "policy-decision.json",
                description: "Policy decision evidence records selected agent and reason.",
            },
            {
                id: "audit-runtime",
                title: "Runtime evidence",
                evidence_path: "agent-runtime.json",
                description: "Runtime evidence records selected agent modes and roles.",
            },
            {
                id: "audit-change-isolation",
                title: "Change isolation evidence",
                evidence_path: "worktree-status.json",
                description: "Worktree evidence records branch, commit, and cleanup status.",
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
    const [manifest, verify, policy, agentRuntime, governance, worktree, knowledge] = await Promise.all([
        readJsonIfExists(join(proofDir, "manifest.json")),
        readJsonIfExists(join(proofDir, "verify-results.json")),
        readJsonIfExists(join(proofDir, "policy-decision.json")),
        readJsonIfExists(join(proofDir, "agent-runtime.json")),
        readJsonIfExists(join(proofDir, "governance-results.json")),
        readJsonIfExists(join(proofDir, "worktree-status.json")),
        readJsonIfExists(join(proofDir, "knowledge-results.json")),
    ]);
    return { manifest, verify, policy, agent_runtime: agentRuntime, governance, worktree, knowledge };
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
        const status = controlStatus(control, options.evidence);
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
        `It maps osstack proof evidence to the internal ${pack.name} view.`,
        "",
        "| Control | Status | Evidence | Mapping |",
        "|---|---|---|---|",
        ...rows,
        "",
    ].join("\n");
}
export async function renderProofViewFromProofDir(options) {
    return renderProofView({
        audience: options.audience,
        runId: options.runId,
        evidence: await loadProofEvidence(options.proofDir),
    });
}
export function renderProofView(options) {
    const controls = proofViewControls(options.audience);
    const rows = controls.map((control) => {
        const status = controlStatus(control, options.evidence);
        return `| ${control.title} | ${status} | \`${control.evidence_path}\` | ${control.focus} |`;
    });
    return [
        `# Osstack Proof View - ${options.audience}`,
        "",
        `Run: \`${options.runId}\``,
        `Audience: \`${options.audience}\``,
        "",
        "This view rearranges existing proof evidence and does not create new evidence.",
        "Missing evidence is marked as `MISSING`; this view does not synthesize or infer absent proof.",
        "",
        "| Evidence | Status | Source | Focus |",
        "|---|---|---|---|",
        ...rows,
        "",
    ].join("\n");
}
function proofViewControls(audience) {
    const byId = new Map(BUILTIN_PACKS[0]?.controls.map((control) => [control.id, control]) ?? []);
    const order = {
        engineer: ["change-validation", "secure-coding-control", "worktree-isolation", "automated-decision-trace", "knowledge-trace", "evidence-integrity"],
        manager: ["change-validation", "automated-decision-trace", "secure-coding-control", "evidence-integrity", "worktree-isolation", "knowledge-trace"],
        auditor: ["evidence-integrity", "automated-decision-trace", "secure-coding-control", "change-validation", "worktree-isolation", "knowledge-trace"],
        customer: ["change-validation", "secure-coding-control", "evidence-integrity", "automated-decision-trace", "worktree-isolation", "knowledge-trace"],
    };
    return order[audience].map((id) => {
        const control = byId.get(id);
        return {
            control_id: id,
            title: control?.title ?? id,
            evidence_path: control?.evidence_path ?? "unknown",
            focus: audienceFocus(audience, id),
        };
    });
}
function audienceFocus(audience, controlId) {
    const focus = {
        engineer: {
            "change-validation": "what passed or failed",
            "secure-coding-control": "deterministic findings to fix",
            "worktree-isolation": "branch and commit context",
            "automated-decision-trace": "agent routing rationale",
            "knowledge-trace": "retrieved context used during work",
            "evidence-integrity": "artifact checksum trail",
        },
        manager: {
            "change-validation": "release readiness",
            "automated-decision-trace": "why this agent path was chosen",
            "secure-coding-control": "risk posture",
            "evidence-integrity": "reviewable proof bundle",
            "worktree-isolation": "delivery isolation",
            "knowledge-trace": "context quality",
        },
        auditor: {
            "evidence-integrity": "checksumed artifact inventory",
            "automated-decision-trace": "automated decision record",
            "secure-coding-control": "secure coding evidence",
            "change-validation": "change validation evidence",
            "worktree-isolation": "change isolation evidence",
            "knowledge-trace": "knowledge source trace",
        },
        customer: {
            "change-validation": "delivery validation summary",
            "secure-coding-control": "safety checks summary",
            "evidence-integrity": "tamper-evident bundle",
            "automated-decision-trace": "high-level automation trace",
            "worktree-isolation": "isolated delivery workflow",
            "knowledge-trace": "approved context trace",
        },
    };
    return focus[audience][controlId] ?? "evidence status";
}
function controlStatus(control, evidence) {
    switch (control.evidence_path) {
        case "verify-results.json":
            return hasObject(evidence.verify) ? "PRESENT" : "MISSING";
        case "policy-decision.json":
            return hasObject(evidence.policy) && hasNonEmptyArray(evidence.policy, "decisions") ? "PRESENT" : "MISSING";
        case "agent-runtime.json":
            return hasObject(evidence.agent_runtime) && hasNonEmptyArray(evidence.agent_runtime, "agents") ? "PRESENT" : "MISSING";
        case "governance-results.json":
            return hasObject(evidence.governance) ? "PRESENT" : "MISSING";
        case "manifest.json":
            return hasObject(evidence.manifest) && hasNonEmptyArray(evidence.manifest, "artifacts") ? "PRESENT" : "MISSING";
        case "worktree-status.json":
            return hasObject(evidence.worktree) ? "PRESENT" : "MISSING";
        case "knowledge-results.json":
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