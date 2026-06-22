export interface CompliancePack {
    id: string;
    version: string;
    name: string;
    certification_claim: "none";
    controls: ComplianceControl[];
}
export interface ComplianceControl {
    id: string;
    title: string;
    evidence_path: string;
    description: string;
}
export interface ProofEvidence {
    manifest?: unknown;
    verify?: unknown;
    policy?: unknown;
    governance?: unknown;
    worktree?: unknown;
    pr?: unknown;
    knowledge?: unknown;
}
export interface ComplianceReportOptions {
    packId: string;
    runId: string;
    evidence: ProofEvidence;
}
export declare function listCompliancePacks(): CompliancePack[];
export declare function getCompliancePack(packId: string): CompliancePack;
export declare function loadProofEvidence(proofDir: string): Promise<ProofEvidence>;
export declare function renderComplianceReportFromProofDir(options: {
    packId: string;
    runId: string;
    proofDir: string;
}): Promise<string>;
export declare function renderComplianceReport(options: ComplianceReportOptions): string;
//# sourceMappingURL=index.d.ts.map