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

export interface ProofEvidenceValidationControl {
  control_id: string;
  title: string;
  evidence_path: string;
  status: "PRESENT" | "MISSING";
  reason?: string;
}

export interface ProofEvidenceValidation {
  ok: boolean;
  scope: string;
  present: ProofEvidenceValidationControl[];
  missing: ProofEvidenceValidationControl[];
  controls: ProofEvidenceValidationControl[];
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
      title_zh: "变更验证",
      evidence_path: "verify-results.json",
      description: "Verify gates or scorecard evidence show whether the change was validated.",
      description_zh: "验证门禁或评分卡证据会显示本次变更是否已被验证。",
    },
    {
      id: "automated-decision-trace",
      title: "Automated decision trace",
      title_zh: "自动化决策追踪",
      evidence_path: "policy-decision.json",
      description: "Policy decisions record agent selection and routing rationale.",
      description_zh: "策略决策会记录 agent 选择和路由依据。",
    },
    {
      id: "secure-coding-control",
      title: "Secure coding control",
      title_zh: "安全编码控制",
      evidence_path: "governance-results.json",
      description: "Governance findings map deterministic checks to secure coding evidence.",
      description_zh: "治理发现会把确定性检查映射为安全编码证据。",
    },
    {
      id: "evidence-integrity",
      title: "Evidence integrity",
      title_zh: "证据完整性",
      evidence_path: "manifest.json",
      description: "Proof manifest artifacts carry SHA-256 checksums.",
      description_zh: "Proof manifest 中的产物会携带 SHA-256 checksum。",
    },
    {
      id: "worktree-isolation",
      title: "Worktree isolation evidence",
      title_zh: "Worktree 隔离证据",
      evidence_path: "worktree-status.json",
      description: "Worktree branch and commit evidence show isolated execution context.",
      description_zh: "Worktree 分支和提交证据会显示隔离执行上下文。",
    },
    {
      id: "knowledge-trace",
      title: "Knowledge trace",
      title_zh: "知识追踪",
      evidence_path: "knowledge-results.json",
      description: "Knowledge pack and chunk traces show which retrieved context was used.",
      description_zh: "知识包和 chunk 追踪会显示使用了哪些检索上下文。",
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
      title_zh: "变更验证",
      evidence_path: "verify-results.json",
      description: "Maps verification results to an internal change-management evidence view.",
      description_zh: "将验证结果映射到内部变更管理证据视图。",
    },
    {
      id: "soc2-automated-decision-trace",
      title: "Automated decision trace",
      title_zh: "自动化决策追踪",
      evidence_path: "policy-decision.json",
      description: "Records the agent selection and routing rationale for audit review.",
      description_zh: "记录 agent 选择和路由依据，供审计复核。",
    },
    {
      id: "soc2-secure-development",
      title: "Secure development checks",
      title_zh: "安全开发检查",
      evidence_path: "governance-results.json",
      description: "Maps deterministic governance findings to secure-development evidence.",
      description_zh: "将确定性治理发现映射为安全开发证据。",
    },
    {
      id: "soc2-evidence-integrity",
      title: "Evidence integrity",
      title_zh: "证据完整性",
      evidence_path: "manifest.json",
      description: "Uses proof manifest checksums as tamper-evident artifact inventory.",
      description_zh: "使用 proof manifest checksum 作为防篡改产物清单。",
    },
    {
      id: "soc2-agent-runtime",
      title: "Agent runtime trace",
      title_zh: "Agent 运行时追踪",
      evidence_path: "agent-runtime.json",
      description: "Shows which agent runtime modes participated in the run.",
      description_zh: "显示参与本次运行的 agent 运行时模式。",
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
      title_zh: "变更控制证据",
      evidence_path: "verify-results.json",
      description: "Verification gates provide internal evidence for change control.",
      description_zh: "验证门禁为变更控制提供内部证据。",
    },
    {
      id: "iso-secure-engineering",
      title: "Secure engineering evidence",
      title_zh: "安全工程证据",
      evidence_path: "governance-results.json",
      description: "Governance checks provide deterministic secure-engineering signals.",
      description_zh: "治理检查提供确定性的安全工程信号。",
    },
    {
      id: "iso-change-isolation",
      title: "Change isolation",
      title_zh: "变更隔离",
      evidence_path: "worktree-status.json",
      description: "Worktree evidence records isolated execution branches and commits.",
      description_zh: "Worktree 证据记录隔离执行分支和提交。",
    },
    {
      id: "iso-evidence-inventory",
      title: "Evidence inventory",
      title_zh: "证据清单",
      evidence_path: "manifest.json",
      description: "Proof manifest lists artifacts with SHA-256 checksums.",
      description_zh: "Proof manifest 会列出带 SHA-256 checksum 的产物。",
    },
    {
      id: "iso-knowledge-source-trace",
      title: "Knowledge source trace",
      title_zh: "知识来源追踪",
      evidence_path: "knowledge-results.json",
      description: "Knowledge traces record retrieved Osstack-native pack and chunk ids.",
      description_zh: "知识追踪会记录检索到的 Osstack-native pack 和 chunk id。",
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
      title_zh: "自动化决策记录",
      evidence_path: "policy-decision.json",
      description: "Policy decision evidence records automated agent selection rationale.",
      description_zh: "策略决策证据会记录自动化 agent 选择依据。",
    },
    {
      id: "eu-agent-runtime-transparency",
      title: "Agent runtime transparency",
      title_zh: "Agent 运行时透明度",
      evidence_path: "agent-runtime.json",
      description: "Agent runtime evidence records auth/invocation mode and role tags.",
      description_zh: "Agent 运行时证据会记录认证/调用模式和角色标签。",
    },
    {
      id: "eu-technical-robustness",
      title: "Technical robustness evidence",
      title_zh: "技术稳健性证据",
      evidence_path: "verify-results.json",
      description: "Verification results show whether the run met its technical gates.",
      description_zh: "验证结果会显示本次运行是否满足技术门禁。",
    },
    {
      id: "eu-risk-and-safety",
      title: "Risk and safety checks",
      title_zh: "风险与安全检查",
      evidence_path: "governance-results.json",
      description: "Governance findings provide deterministic safety and secure-coding signals.",
      description_zh: "治理发现提供确定性的安全与安全编码信号。",
    },
    {
      id: "eu-knowledge-traceability",
      title: "Knowledge traceability",
      title_zh: "知识可追溯性",
      evidence_path: "knowledge-results.json",
      description: "Knowledge evidence records pack and chunk ids used as retrieved context.",
      description_zh: "知识证据会记录作为检索上下文使用的 pack 和 chunk id。",
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
      title_zh: "Proof 清单",
      evidence_path: "manifest.json",
      description: "Proof manifest gives the artifact inventory and integrity hashes.",
      description_zh: "Proof manifest 提供产物清单和完整性哈希。",
    },
    {
      id: "audit-validation",
      title: "Validation evidence",
      title_zh: "验证证据",
      evidence_path: "verify-results.json",
      description: "Verification evidence records pass/fail status for the run.",
      description_zh: "验证证据会记录本次运行的通过/失败状态。",
    },
    {
      id: "audit-agent-selection",
      title: "Agent selection evidence",
      title_zh: "Agent 选择证据",
      evidence_path: "policy-decision.json",
      description: "Policy decision evidence records selected agent and reason.",
      description_zh: "策略决策证据会记录被选择的 agent 及原因。",
    },
    {
      id: "audit-runtime",
      title: "Runtime evidence",
      title_zh: "运行时证据",
      evidence_path: "agent-runtime.json",
      description: "Runtime evidence records selected agent modes and roles.",
      description_zh: "运行时证据会记录被选择的 agent 模式和角色。",
    },
    {
      id: "audit-change-isolation",
      title: "Change isolation evidence",
      title_zh: "变更隔离证据",
      evidence_path: "worktree-status.json",
      description: "Worktree evidence records branch, commit, and cleanup status.",
      description_zh: "Worktree 证据会记录分支、提交和清理状态。",
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
  language?: ComplianceReportLanguage;
}): Promise<string> {
  const renderOptions: ComplianceReportOptions = {
    packId: options.packId,
    runId: options.runId,
    evidence: await loadProofEvidence(options.proofDir),
  };
  if (options.language !== undefined) {
    renderOptions.language = options.language;
  }
  return renderComplianceReport(renderOptions);
}

export function renderComplianceReport(options: ComplianceReportOptions): string {
  const pack = getCompliancePack(options.packId);
  const text = complianceReportText(options.language ?? "en");
  const rows = pack.controls.map((control) => {
    const status = controlStatus(control, options.evidence);
    const title = localizedControlTitle(control, options.language ?? "en");
    const description = localizedControlDescription(control, options.language ?? "en");
    return `| ${title} | ${status} | \`${control.evidence_path}\` | ${description} |`;
  });
  return [
    `# ${text.title} - ${pack.id}`,
    "",
    `${text.runLabel}${text.labelSeparator}\`${options.runId}\``,
    `${text.packLabel}${text.labelSeparator}\`${pack.id}@${pack.version}\``,
    `${text.certificationClaimLabel}${text.labelSeparator}\`none\``,
    "",
    text.noExternalCertification,
    text.internalMapping(pack.name),
    "",
    `| ${text.controlHeader} | ${text.statusHeader} | ${text.evidenceHeader} | ${text.mappingHeader} |`,
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function localizedControlTitle(control: ComplianceControl, language: ComplianceReportLanguage): string {
  if (language === "zh-CN" && control.title_zh !== undefined) return control.title_zh;
  return control.title;
}

function localizedControlDescription(control: ComplianceControl, language: ComplianceReportLanguage): string {
  if (language === "zh-CN" && control.description_zh !== undefined) return control.description_zh;
  return control.description;
}

function complianceReportText(language: ComplianceReportLanguage): {
  title: string;
  runLabel: string;
  packLabel: string;
  certificationClaimLabel: string;
  labelSeparator: string;
  noExternalCertification: string;
  internalMapping: (packName: string) => string;
  controlHeader: string;
  statusHeader: string;
  evidenceHeader: string;
  mappingHeader: string;
} {
  if (language === "zh-CN") {
    return {
      title: "Osstack 合规映射报告",
      runLabel: "运行",
      packLabel: "映射包",
      certificationClaimLabel: "外部认证声明",
      labelSeparator: "：",
      noExternalCertification: "此报告不是 SOC 2、ISO 27001、EU AI Act 或第三方认证。",
      internalMapping: (packName) => `它会把 osstack proof 证据映射到内部 ${packName} 视图。`,
      controlHeader: "控制项",
      statusHeader: "状态",
      evidenceHeader: "证据",
      mappingHeader: "映射",
    };
  }
  return {
    title: "Osstack Compliance Report",
    runLabel: "Run",
    packLabel: "Pack",
    certificationClaimLabel: "External certification claim",
    labelSeparator: ": ",
    noExternalCertification: "This report is not a SOC 2, ISO 27001, EU AI Act, or third-party certification.",
    internalMapping: (packName) => `It maps osstack proof evidence to the internal ${packName} view.`,
    controlHeader: "Control",
    statusHeader: "Status",
    evidenceHeader: "Evidence",
    mappingHeader: "Mapping",
  };
}

export async function renderProofViewFromProofDir(options: {
  audience: ProofAudience;
  runId: string;
  proofDir: string;
  language?: ProofViewLanguage;
}): Promise<string> {
  const renderOptions: ProofViewOptions = {
    audience: options.audience,
    runId: options.runId,
    evidence: await loadProofEvidence(options.proofDir),
  };
  if (options.language !== undefined) {
    renderOptions.language = options.language;
  }
  return renderProofView(renderOptions);
}

export function renderProofView(options: ProofViewOptions): string {
  const language = options.language ?? "en";
  const text = proofViewText(language);
  const controls = proofViewControls(options.audience, language);
  const rows = controls.map((control) => {
    const status = controlStatus(control, options.evidence);
    return `| ${control.title} | ${proofStatusCell(status)} | \`${control.evidence_path}\` | ${control.focus} |`;
  });
  const missing = controls
    .filter((control) => controlStatus(control, options.evidence) === "MISSING")
    .map((control) => text.missingItem(control.title, control.evidence_path, control.focus));
  return [
    `# ${text.title} - ${options.audience}`,
    "",
    `${text.runLabel}${text.labelSeparator}\`${options.runId}\``,
    `${text.audienceLabel}${text.labelSeparator}\`${options.audience}\``,
    "",
    text.description,
    text.missingDescription,
    "",
    `## ${text.missingHeading}`,
    "",
    ...(missing.length > 0 ? missing : [text.noMissingEvidence]),
    "",
    `| ${text.evidenceHeader} | ${text.statusHeader} | ${text.sourceHeader} | ${text.focusHeader} |`,
    "|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

export function validateProofEvidence(options: {
  evidence: ProofEvidence;
  packId?: string;
  audience?: ProofAudience;
  language?: ProofViewLanguage;
}): ProofEvidenceValidation {
  const language = options.language ?? "en";
  const controls = validationControls(options, language);
  const evaluated = controls.map((control) => {
    const status = controlStatus(control, options.evidence);
    return {
      control_id: control.control_id,
      title: control.title,
      evidence_path: control.evidence_path,
      status,
      ...(status === "MISSING" ? { reason: "missing or malformed proof evidence" } : {}),
    };
  });
  const present = evaluated.filter((control) => control.status === "PRESENT");
  const missing = evaluated.filter((control) => control.status === "MISSING");
  return {
    ok: missing.length === 0,
    scope: validationScope(options),
    present,
    missing,
    controls: evaluated,
  };
}

function validationControls(
  options: { packId?: string; audience?: ProofAudience },
  language: ProofViewLanguage,
): Array<{ control_id: string; title: string; evidence_path: string }> {
  if (options.packId !== undefined) {
    return getCompliancePack(options.packId).controls.map((control) => ({
      control_id: control.id,
      title: localizedControlTitle(control, language),
      evidence_path: control.evidence_path,
    }));
  }
  if (options.audience !== undefined) {
    return proofViewControls(options.audience, language);
  }
  return [
    { control_id: "evidence-integrity", title: "Evidence integrity", evidence_path: "manifest.json" },
    { control_id: "change-validation", title: "Change validation", evidence_path: "verify-results.json" },
    { control_id: "automated-decision-trace", title: "Automated decision trace", evidence_path: "policy-decision.json" },
    { control_id: "agent-runtime-trace", title: "Agent runtime trace", evidence_path: "agent-runtime.json" },
    { control_id: "secure-coding-control", title: "Secure coding control", evidence_path: "governance-results.json" },
    { control_id: "worktree-isolation", title: "Worktree isolation evidence", evidence_path: "worktree-status.json" },
  ];
}

function validationScope(options: { packId?: string; audience?: ProofAudience }): string {
  if (options.packId !== undefined) return `compliance:${options.packId}`;
  if (options.audience !== undefined) return `audience:${options.audience}`;
  return "proof-core";
}

function proofViewText(language: ProofViewLanguage): {
  title: string;
  runLabel: string;
  audienceLabel: string;
  labelSeparator: string;
  description: string;
  missingDescription: string;
  missingHeading: string;
  noMissingEvidence: string;
  evidenceHeader: string;
  statusHeader: string;
  sourceHeader: string;
  focusHeader: string;
  missingItem: (title: string, evidencePath: string, focus: string) => string;
} {
  if (language === "zh-CN") {
    return {
      title: "Osstack 证据视图",
      runLabel: "运行",
      audienceLabel: "受众",
      labelSeparator: "：",
      description: "此视图会重排已有 proof 证据，不会创建新证据。",
      missingDescription: "缺失证据会标记为 `MISSING`；此视图不会合成或推断不存在的证据。",
      missingHeading: "缺失证据",
      noMissingEvidence: "此受众视图没有缺失必需证据。",
      evidenceHeader: "证据",
      statusHeader: "状态",
      sourceHeader: "来源",
      focusHeader: "关注点",
      missingItem: (title, evidencePath, focus) => `- 缺失必需证据：${title}（\`${evidencePath}\`）- ${focus}`,
    };
  }
  return {
    title: "Osstack Proof View",
    runLabel: "Run",
    audienceLabel: "Audience",
    labelSeparator: ": ",
    description: "This view rearranges existing proof evidence and does not create new evidence.",
    missingDescription: "Missing evidence is marked as `MISSING`; this view does not synthesize or infer absent proof.",
    missingHeading: "Missing Evidence",
    noMissingEvidence: "No required evidence is missing for this audience view.",
    evidenceHeader: "Evidence",
    statusHeader: "Status",
    sourceHeader: "Source",
    focusHeader: "Focus",
    missingItem: (title, evidencePath, focus) => `- REQUIRED EVIDENCE MISSING: ${title} (\`${evidencePath}\`) - ${focus}`,
  };
}

function proofViewControls(audience: ProofAudience, language: ProofViewLanguage): Array<{
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
      title: control !== undefined ? localizedControlTitle(control, language) : id,
      evidence_path: control?.evidence_path ?? "unknown",
      focus: audienceFocus(audience, id, language),
    };
  });
}

function audienceFocus(audience: ProofAudience, controlId: string, language: ProofViewLanguage): string {
  const focus: Record<ProofViewLanguage, Record<ProofAudience, Record<string, string>>> = {
    en: {
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
    },
    "zh-CN": {
      engineer: {
        "change-validation": "通过或失败的内容",
        "secure-coding-control": "需要修复的确定性发现",
        "worktree-isolation": "分支与提交上下文",
        "automated-decision-trace": "agent 路由依据",
        "knowledge-trace": "工作中使用的检索上下文",
        "evidence-integrity": "证据 checksum 链路",
      },
      manager: {
        "change-validation": "发布就绪度",
        "automated-decision-trace": "为什么选择这条 agent 路径",
        "secure-coding-control": "风险状态",
        "evidence-integrity": "可审查的证据包",
        "worktree-isolation": "交付隔离",
        "knowledge-trace": "上下文质量",
      },
      auditor: {
        "evidence-integrity": "带 checksum 的证据清单",
        "automated-decision-trace": "自动化决策记录",
        "secure-coding-control": "安全编码证据",
        "change-validation": "变更验证证据",
        "worktree-isolation": "变更隔离证据",
        "knowledge-trace": "知识来源追踪",
      },
      customer: {
        "change-validation": "交付验证摘要",
        "secure-coding-control": "安全检查摘要",
        "evidence-integrity": "防篡改证据包",
        "automated-decision-trace": "高层自动化追踪",
        "worktree-isolation": "隔离交付流程",
        "knowledge-trace": "已批准上下文追踪",
      },
    },
  };
  return focus[language][audience][controlId] ?? (language === "zh-CN" ? "证据状态" : "evidence status");
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
      ...(typeof control["title_zh"] === "string" && control["title_zh"].length > 0
        ? { title_zh: control["title_zh"] }
        : {}),
      ...(typeof control["description_zh"] === "string" && control["description_zh"].length > 0
        ? { description_zh: control["description_zh"] }
        : {}),
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
