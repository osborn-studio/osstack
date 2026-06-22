export interface CompliancePack {
    id: string;
    version: string;
    name: string;
    certification_claim: "none";
    description?: string;
    controls: ComplianceControl[];
}
export interface ComplianceControl {
    id: string;
    title: string;
    title_zh?: string;
    evidence_path: string;
    description: string;
    description_zh?: string;
}
export interface CompliancePackFileValidation {
    pack: CompliancePack;
    required_present: string[];
    template: string;
}
export interface ProofEvidence {
    manifest?: unknown;
    verify?: unknown;
    policy?: unknown;
    agent_runtime?: unknown;
    governance?: unknown;
    worktree?: unknown;
    pr?: unknown;
    knowledge?: unknown;
}
export interface ComplianceReportOptions {
    packId: string;
    runId: string;
    evidence: ProofEvidence;
    language?: ComplianceReportLanguage;
}
export type ComplianceReportLanguage = "en" | "zh-CN";
export type ProofAudience = "engineer" | "manager" | "auditor" | "customer";
export type ProofViewLanguage = "en" | "zh-CN";
export interface ProofViewOptions {
    audience: ProofAudience;
    runId: string;
    evidence: ProofEvidence;
    language?: ProofViewLanguage;
}
export declare function listCompliancePacks(): CompliancePack[];
export declare function getCompliancePack(packId: string): CompliancePack;
export declare function loadCompliancePack(packDir: string): Promise<CompliancePack>;
export declare function validateCompliancePackFiles(packDir: string): Promise<CompliancePackFileValidation>;
export declare function loadProofEvidence(proofDir: string): Promise<ProofEvidence>;
export declare function renderComplianceReportFromProofDir(options: {
    packId: string;
    runId: string;
    proofDir: string;
    language?: ComplianceReportLanguage;
}): Promise<string>;
export declare function renderComplianceReport(options: ComplianceReportOptions): string;
export declare function renderProofViewFromProofDir(options: {
    audience: ProofAudience;
    runId: string;
    proofDir: string;
    language?: ProofViewLanguage;
}): Promise<string>;
export declare function renderProofView(options: ProofViewOptions): string;
//# sourceMappingURL=index.d.ts.map