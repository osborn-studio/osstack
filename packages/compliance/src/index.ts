import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
}

export type ProofAudience = "engineer" | "manager" | "auditor" | "customer";

export interface ProofViewOptions {
  audience: ProofAudience;
  runId: string;
  evidence: ProofEvidence;
}

const BUILTIN_PACKS: CompliancePack[] = [{
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

export function listCompliancePacks(): CompliancePack[] {
  return BUILTIN_PACKS.map((pack) => ({
    ...pack,
    controls: pack.controls.map((control) => ({ ...control })),
  }));
}

export function getCompliancePack(packId: string): CompliancePack {
  const pack = BUILTIN_PACKS.find((candidate) => candidate.id === packId);
  if (pack === undefined) throw new Error(`unknown compliance pack: ${packId}`);
  return {
    ...pack,
    controls: pack.controls.map((control) => ({ ...control })),
  };
}

export async function loadProofEvidence(proofDir: string): Promise<ProofEvidence> {
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

export async function renderComplianceReportFromProofDir(options: {
  packId: string;
  runId: string;
  proofDir: string;
}): Promise<string> {
  return renderComplianceReport({
    packId: options.packId,
    runId: options.runId,
    evidence: await loadProofEvidence(options.proofDir),
  });
}

export function renderComplianceReport(options: ComplianceReportOptions): string {
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

export async function renderProofViewFromProofDir(options: {
  audience: ProofAudience;
  runId: string;
  proofDir: string;
}): Promise<string> {
  return renderProofView({
    audience: options.audience,
    runId: options.runId,
    evidence: await loadProofEvidence(options.proofDir),
  });
}

export function renderProofView(options: ProofViewOptions): string {
  const controls = proofViewControls(options.audience);
  const rows = controls.map((control) => {
    const status = controlStatus(control.control_id, options.evidence);
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

function proofViewControls(audience: ProofAudience): Array<{
  control_id: string;
  title: string;
  evidence_path: string;
  focus: string;
}> {
  const byId = new Map(BUILTIN_PACKS[0]?.controls.map((control) => [control.id, control]) ?? []);
  const order = {
    engineer: ["change-validation", "secure-coding-control", "worktree-isolation", "automated-decision-trace", "knowledge-trace", "evidence-integrity"],
    manager: ["change-validation", "automated-decision-trace", "secure-coding-control", "evidence-integrity", "worktree-isolation", "knowledge-trace"],
    auditor: ["evidence-integrity", "automated-decision-trace", "secure-coding-control", "change-validation", "worktree-isolation", "knowledge-trace"],
    customer: ["change-validation", "secure-coding-control", "evidence-integrity", "automated-decision-trace", "worktree-isolation", "knowledge-trace"],
  } satisfies Record<ProofAudience, string[]>;
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

function audienceFocus(audience: ProofAudience, controlId: string): string {
  const focus: Record<ProofAudience, Record<string, string>> = {
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

function controlStatus(controlId: string, evidence: ProofEvidence): "PRESENT" | "MISSING" {
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

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

function hasObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasNonEmptyArray(value: unknown, key: string): boolean {
  return hasObject(value) && Array.isArray(value[key]) && value[key].length > 0;
}
