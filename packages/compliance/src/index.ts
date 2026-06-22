import { readFile } from "node:fs/promises";
import { join } from "node:path";

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
  evidence_path: string;
  description: string;
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

export async function loadCompliancePack(packDir: string): Promise<CompliancePack> {
  const [manifestRaw, controlsRaw, evidenceMapRaw] = await Promise.all([
    readJson(join(packDir, "manifest.json")),
    readJson(join(packDir, "controls.json")),
    readJson(join(packDir, "evidence-map.json")),
  ]);
  const manifest = validateComplianceManifest(manifestRaw);
  const controls = validateComplianceControls(controlsRaw);
  const evidenceMap = validateEvidenceMap(evidenceMapRaw);
  return {
    ...manifest,
    controls: controls.map((control) => ({
      ...control,
      evidence_path: evidenceMap[control.id] ?? missingEvidencePath(control.id),
    })),
  };
}

export async function validateCompliancePackFiles(packDir: string): Promise<CompliancePackFileValidation> {
  const [pack, rubricRaw, template] = await Promise.all([
    loadCompliancePack(packDir),
    readJson(join(packDir, "score-rubric.json")),
    readFile(join(packDir, "report-template.md"), "utf-8"),
  ]);
  const rubric = validateScoreRubric(rubricRaw);
  const controlIds = new Set(pack.controls.map((control) => control.id));
  for (const required of rubric.required_present) {
    if (!controlIds.has(required)) throw new Error(`compliance rubric references unknown control: ${required}`);
  }
  if (!template.includes("External certification claim: `none`")) {
    throw new Error("compliance report template must not claim external certification");
  }
  if (!template.includes("{{controls}}")) {
    throw new Error("compliance report template must include {{controls}}");
  }
  return { pack, required_present: rubric.required_present, template };
}

export async function loadProofEvidence(proofDir: string): Promise<ProofEvidence> {
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
    const status = controlStatus(control, options.evidence);
    return `| ${control.title} | ${proofStatusCell(status)} | \`${control.evidence_path}\` | ${control.focus} |`;
  });
  const missing = controls
    .filter((control) => controlStatus(control, options.evidence) === "MISSING")
    .map((control) => `- REQUIRED EVIDENCE MISSING: ${control.title} (\`${control.evidence_path}\`) - ${control.focus}`);
  return [
    `# Osstack Proof View - ${options.audience}`,
    "",
    `Run: \`${options.runId}\``,
    `Audience: \`${options.audience}\``,
    "",
    "This view rearranges existing proof evidence and does not create new evidence.",
    "Missing evidence is marked as `MISSING`; this view does not synthesize or infer absent proof.",
    "",
    "## Missing Evidence",
    "",
    ...(missing.length > 0 ? missing : ["No required evidence is missing for this audience view."]),
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

function controlStatus(control: { control_id?: string; evidence_path: string }, evidence: ProofEvidence): "PRESENT" | "MISSING" {
  switch (control.evidence_path) {
    case "verify-results.json":
      return hasRecordedVerifyEvidence(evidence.verify) ? "PRESENT" : "MISSING";
    case "policy-decision.json":
      return hasRecordedPolicyEvidence(evidence.policy) ? "PRESENT" : "MISSING";
    case "agent-runtime.json":
      return hasRecordedAgentRuntimeEvidence(evidence.agent_runtime) ? "PRESENT" : "MISSING";
    case "governance-results.json":
      return hasGovernanceEvidence(evidence.governance) ? "PRESENT" : "MISSING";
    case "manifest.json":
      return hasProofManifestEvidence(evidence.manifest) ? "PRESENT" : "MISSING";
    case "worktree-status.json":
      return hasRecordedWorktreeEvidence(evidence.worktree) ? "PRESENT" : "MISSING";
    case "knowledge-results.json":
      return hasRecordedKnowledgeEvidence(evidence.knowledge) ? "PRESENT" : "MISSING";
  }
  return "MISSING";
}

const SHA256_HEX = /^[a-f0-9]{64}$/;

function hasRecordedVerifyEvidence(value: unknown): boolean {
  if (!hasObject(value) || (value["status"] !== "pass" && value["status"] !== "fail")) return false;
  return hasValidNonEmptyArray(value, "results", isVerifyResult);
}

function isVerifyResult(value: unknown): boolean {
  if (!hasObject(value)) return false;
  return isNonEmptyString(value["task_id"])
    && typeof value["pass"] === "boolean"
    && (typeof value["score"] === "number" || value["score"] === "unknown")
    && isNonEmptyString(value["reviewer_agent_id"])
    && isNonEmptyString(value["summary"])
    && isNonNegativeInteger(value["event_seq"]);
}

function hasRecordedPolicyEvidence(value: unknown): boolean {
  if (!hasObject(value) || value["status"] !== "recorded") return false;
  return hasValidNonEmptyArray(value, "decisions", isPolicyDecision);
}

function isPolicyDecision(value: unknown): boolean {
  if (!hasObject(value)) return false;
  return isNonEmptyString(value["task_id"])
    && isNonEmptyString(value["agent_id"])
    && isNonEmptyString(value["auth_mode"])
    && hasNonEmptyStringArray(value["roles"])
    && isNonEmptyString(value["reason"])
    && isNonNegativeInteger(value["event_seq"]);
}

function hasRecordedAgentRuntimeEvidence(value: unknown): boolean {
  if (!hasObject(value) || value["status"] !== "recorded") return false;
  return hasValidNonEmptyArray(value, "agents", isAgentRuntime);
}

function isAgentRuntime(value: unknown): boolean {
  if (!hasObject(value)) return false;
  return isNonEmptyString(value["agent_id"])
    && isNonEmptyString(value["auth_mode"])
    && hasNonEmptyStringArray(value["roles"])
    && hasNonNegativeIntegerArray(value["plan_event_seqs"]);
}

function hasGovernanceEvidence(value: unknown): boolean {
  return hasObject(value) && (value["status"] === "pass" || value["status"] === "fail");
}

function hasProofManifestEvidence(value: unknown): boolean {
  if (!hasObject(value)) return false;
  return hasValidNonEmptyArray(value, "artifacts", isProofManifestArtifact);
}

function isProofManifestArtifact(value: unknown): boolean {
  if (!hasObject(value)) return false;
  return isNonEmptyString(value["path"])
    && typeof value["sha256"] === "string"
    && SHA256_HEX.test(value["sha256"])
    && isPositiveInteger(value["bytes"]);
}

function hasRecordedWorktreeEvidence(value: unknown): boolean {
  if (!hasObject(value) || value["status"] !== "recorded") return false;
  return hasValidNonEmptyArray(value, "entries", isWorktreeEntry);
}

function isWorktreeEntry(value: unknown): boolean {
  if (!hasObject(value)) return false;
  if (!isNonEmptyString(value["task_id"])) return false;
  if (value["status"] !== "created" && value["status"] !== "merged" && value["status"] !== "cleaned") return false;
  if (!isNonEmptyString(value["branch"]) || !isNonEmptyString(value["path"])) return false;
  if (value["status"] === "merged" && !isNonEmptyString(value["commit"])) return false;
  return isNonNegativeInteger(value["event_seq"]);
}

function hasRecordedKnowledgeEvidence(value: unknown): boolean {
  if (!hasObject(value) || value["status"] !== "recorded") return false;
  return hasValidNonEmptyArray(value, "results", isKnowledgeResult);
}

function isKnowledgeResult(value: unknown): boolean {
  if (!hasObject(value)) return false;
  return isNonEmptyString(value["chunk_id"]) && hasNonEmptyStringArray(value["source_refs"]);
}

function hasValidNonEmptyArray(value: Record<string, unknown>, key: string, predicate: (item: unknown) => boolean): boolean {
  return Array.isArray(value[key]) && value[key].length > 0 && value[key].every(predicate);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value !== "unknown";
}

function hasNonEmptyStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

function hasNonNegativeIntegerArray(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0 && value.every(isNonNegativeInteger);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0;
}

function proofStatusCell(status: "PRESENT" | "MISSING"): string {
  if (status === "PRESENT") return "PRESENT";
  return "<strong style=\"color:#b00020\">MISSING</strong>";
}

async function readJsonIfExists(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf-8")) as unknown;
  } catch {
    return undefined;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf-8")) as unknown;
}

function validateComplianceManifest(value: unknown): Omit<CompliancePack, "controls"> {
  if (!hasObject(value)) throw new Error("compliance manifest must be an object");
  const certificationClaim = requiredString(value, "certification_claim");
  if (certificationClaim !== "none") throw new Error("compliance manifest certification_claim must be none");
  return {
    id: requiredString(value, "id"),
    version: requiredString(value, "version"),
    name: requiredString(value, "name"),
    certification_claim: "none",
    ...(typeof value["description"] === "string" && value["description"].length > 0
      ? { description: value["description"] }
      : {}),
  };
}

function validateComplianceControls(value: unknown): Array<Omit<ComplianceControl, "evidence_path">> {
  if (!Array.isArray(value)) throw new Error("compliance controls must be an array");
  return value.map((control) => {
    if (!hasObject(control)) throw new Error("compliance control must be an object");
    return {
      id: requiredString(control, "id"),
      title: requiredString(control, "title"),
      description: requiredString(control, "description"),
    };
  });
}

function validateEvidenceMap(value: unknown): Record<string, string> {
  if (!hasObject(value)) throw new Error("compliance evidence-map must be an object");
  const entries: Record<string, string> = {};
  for (const [key, evidencePath] of Object.entries(value)) {
    if (typeof evidencePath !== "string" || evidencePath.length === 0) {
      throw new Error(`compliance evidence-map entry ${key} must be a non-empty string`);
    }
    entries[key] = evidencePath;
  }
  return entries;
}

function validateScoreRubric(value: unknown): { required_present: string[] } {
  if (!hasObject(value)) throw new Error("compliance score-rubric must be an object");
  const minimum = value["minimum_release_ready"];
  if (!hasObject(minimum)) throw new Error("compliance score-rubric minimum_release_ready must be an object");
  const required = minimum["required_present"];
  if (!Array.isArray(required) || !required.every((item) => typeof item === "string" && item.length > 0)) {
    throw new Error("compliance score-rubric required_present must be an array of strings");
  }
  return { required_present: required };
}

function missingEvidencePath(controlId: string): string {
  throw new Error(`compliance evidence-map missing control: ${controlId}`);
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`compliance ${key} must be a non-empty string`);
  }
  return field;
}

function hasObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
