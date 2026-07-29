import {
  agentAuthMode,
  defaultAdapters,
  rolesForCapabilityKinds,
} from "@osstack/agents";
import { PIIRedactor } from "@osstack/core";
import type { LoopEvent, ReviewArtifact } from "@osstack/loop";

export interface VerifyResultEvidence {
  task_id: string;
  pass: boolean;
  score: number | "unknown";
  reviewer_agent_id: string;
  summary: string;
  event_seq: number;
  review_artifacts?: ReviewArtifact[];
}

export interface VerifyResultsEvidence {
  status: "pass" | "fail" | "unknown";
  results?: VerifyResultEvidence[];
  reason?: string;
}

export interface ProofArtifact {
  path: string;
  content: string;
}

export interface ProofStageInput {
  stage: "candidate" | "final";
  supersedes?: {
    manifest_path: string;
    manifest_sha256: string;
  };
  risk_evidence?: unknown;
  approval_evidence?: unknown;
  git_delivery_evidence?: unknown;
  deploy_eligibility_evidence?: unknown;
  deploy_script_authority_evidence?: unknown;
  deploy_staging_evidence?: unknown;
  deploy_production_evidence?: unknown;
  rollback_evidence?: unknown;
  production_freeze_evidence?: unknown;
}

export interface ProofStageManifestMetadata {
  proof_stage: "candidate" | "final";
  supersedes?: {
    manifest_path: string;
    manifest_sha256: string;
  };
}

export function createProofStageMetadata(
  input: ProofStageInput,
): ProofStageManifestMetadata {
  if (input.stage === "candidate") {
    if (input.supersedes !== undefined) {
      throw new Error("candidate proof must not supersede another manifest");
    }
    if (input.git_delivery_evidence !== undefined) {
      throw new Error("candidate proof must not claim Git delivery evidence");
    }
    if (
      input.deploy_eligibility_evidence !== undefined
      || input.deploy_script_authority_evidence !== undefined
      || input.deploy_staging_evidence !== undefined
      || input.deploy_production_evidence !== undefined
      || input.rollback_evidence !== undefined
      || input.production_freeze_evidence !== undefined
    ) {
      throw new Error(
        "candidate proof must not claim post-merge deploy evidence",
      );
    }
    return { proof_stage: "candidate" };
  }

  const supersedes = input.supersedes;
  if (supersedes === undefined) {
    throw new Error("final proof requires supersedes candidate manifest metadata");
  }
  if (
    supersedes.manifest_path.trim().length === 0
    || supersedes.manifest_path.includes("\0")
    || /^[A-Za-z]:[\\/]/.test(supersedes.manifest_path)
    || supersedes.manifest_path.startsWith("/")
  ) {
    throw new Error("supersedes manifest_path must be a non-empty relative path");
  }
  if (!/^[a-f0-9]{64}$/.test(supersedes.manifest_sha256)) {
    throw new Error("supersedes manifest_sha256 must be 64 lowercase hex characters");
  }
  return {
    proof_stage: "final",
    supersedes: { ...supersedes },
  };
}

export function createProofStageArtifacts(
  input: ProofStageInput,
): ProofArtifact[] {
  createProofStageMetadata(input);
  const risk = optionalEvidenceContainer(
    input.risk_evidence,
    "risk_evidence",
    new Set(["preflight", "post_diff"]),
  );
  const approval = optionalEvidenceContainer(
    input.approval_evidence,
    "approval_evidence",
    new Set(["request", "decision"]),
  );
  const artifacts: ProofArtifact[] = [];
  pushJsonEvidenceArtifact(
    artifacts,
    "risk-preflight.json",
    risk?.["preflight"],
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "risk-post-diff.json",
    risk?.["post_diff"],
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "approval-request.json",
    approval?.["request"],
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "approval-decision.json",
    approval?.["decision"],
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "git-delivery.json",
    input.git_delivery_evidence,
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "deploy-eligibility.json",
    input.deploy_eligibility_evidence,
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "deploy-script-authority.json",
    input.deploy_script_authority_evidence,
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "deploy-staging.json",
    input.deploy_staging_evidence,
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "deploy-production.json",
    input.deploy_production_evidence,
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "rollback.json",
    input.rollback_evidence,
  );
  pushJsonEvidenceArtifact(
    artifacts,
    "production-freeze.json",
    input.production_freeze_evidence,
  );
  return artifacts;
}

export interface PolicyDecisionEvidence {
  status: "recorded" | "unknown";
  decisions?: Array<{
    task_id: string;
    agent_id: string;
    auth_mode: string;
    roles: string[];
    reason: string;
    event_seq: number;
    profile_name?: string;
    independent?: boolean;
    independence_reason?: string;
  }>;
  reason?: string;
}

function optionalEvidenceContainer(
  value: unknown,
  label: string,
  allowedKeys: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  const unexpectedKey = Object.keys(value).find(
    (key) => !allowedKeys.has(key),
  );
  if (unexpectedKey !== undefined) {
    throw new Error(`${label} contains unexpected field: ${unexpectedKey}`);
  }
  return value;
}

function pushJsonEvidenceArtifact(
  artifacts: ProofArtifact[],
  path: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (!isRecord(value) || Object.keys(value).length === 0) {
    throw new Error(`${path} evidence must be a non-empty JSON object`);
  }
  artifacts.push({
    path,
    content: `${JSON.stringify(value, null, 2)}\n`,
  });
}

export interface AgentRuntimeEvidence {
  status: "recorded" | "unknown";
  agents?: Array<{
    agent_id: string;
    auth_mode: string;
    roles: string[];
    plan_event_seqs: number[];
    verify_event_seqs?: number[];
    adapter_id?: string;
    provider_id?: string;
    model_id?: string;
    evidence_source?: string;
    runtime_identity?: Record<string, unknown>;
  }>;
  reason?: string;
}

export function createPolicyDecisionEvidence(
  events: LoopEvent[],
): PolicyDecisionEvidence {
  const decisions = events
    .filter((event) => event.type === "loop.plan.done")
    .map((event) => {
      const agentId = stringEventPayload(event, "agent_id");
      const builderIdentity = recordEventPayload(
        event,
        "builder_identity",
      );
      const profileName = optionalStringEventPayload(
        event,
        "profile_name",
      );
      const independent = optionalBooleanEventPayload(
        event,
        "independent",
      );
      const independenceReason = optionalStringEventPayload(
        event,
        "independence_reason",
      );
      return {
        task_id: stringEventPayload(event, "task_id"),
        agent_id: agentId,
        auth_mode: stringRecordValue(builderIdentity, "auth_mode")
          ?? agentAuthMode(agentId),
        roles: builderIdentity === undefined
          ? rolesForAgentId(agentId)
          : ["coding"],
        reason: stringEventPayload(event, "routing_reason"),
        event_seq: event.seq,
        ...(profileName !== undefined
          ? { profile_name: profileName }
          : {}),
        ...(independent !== undefined ? { independent } : {}),
        ...(independenceReason !== undefined
          ? { independence_reason: independenceReason }
          : {}),
      };
    });
  if (decisions.length === 0) {
    return {
      status: "unknown",
      reason: "No loop.plan.done policy decision evidence found.",
    };
  }
  return redactEvidence({ status: "recorded", decisions });
}

export function createAgentRuntimeEvidence(
  events: LoopEvent[],
): AgentRuntimeEvidence {
  interface RuntimeEntry {
    agent_id: string;
    auth_mode: string;
    roles: Set<string>;
    plan_event_seqs: number[];
    verify_event_seqs: number[];
    identity?: Record<string, unknown>;
  }

  const byAgent = new Map<string, RuntimeEntry>();
  const upsert = (
    agentId: string,
    role: string,
    eventSeq: number,
    eventKind: "plan" | "verify",
    identity?: Record<string, unknown>,
  ): void => {
    const existing = byAgent.get(agentId) ?? {
      agent_id: agentId,
      auth_mode: stringRecordValue(identity, "auth_mode")
        ?? agentAuthMode(agentId),
      roles: new Set<string>(),
      plan_event_seqs: [],
      verify_event_seqs: [],
      ...(identity !== undefined ? { identity } : {}),
    };
    existing.roles.add(role);
    if (eventKind === "plan") {
      existing.plan_event_seqs.push(eventSeq);
    } else {
      existing.verify_event_seqs.push(eventSeq);
    }
    if (existing.identity === undefined && identity !== undefined) {
      existing.identity = identity;
      existing.auth_mode = stringRecordValue(identity, "auth_mode")
        ?? existing.auth_mode;
    }
    byAgent.set(agentId, existing);
  };

  for (const event of events) {
    if (event.type === "loop.plan.done") {
      const identity = recordEventPayload(event, "builder_identity");
      const agentId = stringRecordValue(identity, "adapter_id")
        ?? stringEventPayload(event, "agent_id");
      if (identity === undefined) {
        for (const role of rolesForAgentId(agentId)) {
          upsert(agentId, role, event.seq, "plan");
        }
      } else {
        upsert(agentId, "coding", event.seq, "plan", identity);
      }
    }
    if (event.type === "loop.verify.done") {
      const identity = recordEventPayload(event, "evaluator_identity");
      if (identity === undefined) continue;
      const agentId = stringRecordValue(identity, "adapter_id")
        ?? stringEventPayload(event, "reviewer_agent_id");
      upsert(agentId, "test-verify", event.seq, "verify", identity);
    }
  }
  if (byAgent.size === 0) {
    return {
      status: "unknown",
      reason: "No loop.plan.done event evidence found.",
    };
  }
  const agents = [...byAgent.values()].map((entry) => {
    const identity = entry.identity;
    const adapterId = stringRecordValue(identity, "adapter_id");
    const providerId = stringRecordValue(identity, "provider_id");
    const modelId = stringRecordValue(identity, "model_id");
    const evidenceSource = stringRecordValue(
      identity,
      "evidence_source",
    );
    return {
      agent_id: entry.agent_id,
      auth_mode: entry.auth_mode,
      roles: [...entry.roles],
      plan_event_seqs: entry.plan_event_seqs,
      ...(entry.verify_event_seqs.length > 0
        ? { verify_event_seqs: entry.verify_event_seqs }
        : {}),
      ...(adapterId !== undefined ? { adapter_id: adapterId } : {}),
      ...(providerId !== undefined ? { provider_id: providerId } : {}),
      ...(modelId !== undefined ? { model_id: modelId } : {}),
      ...(evidenceSource !== undefined
        ? { evidence_source: evidenceSource }
        : {}),
      ...(identity !== undefined
        ? { runtime_identity: identity }
        : {}),
    };
  });
  return redactEvidence({ status: "recorded", agents });
}

export function createVerifierOutputArtifacts(
  verifyResults: VerifyResultsEvidence,
): ProofArtifact[] {
  if (verifyResults.results === undefined) return [];
  const artifacts = verifyResults.results.flatMap((result) => {
    if (
      result.review_artifacts !== undefined
      && result.review_artifacts.length > 0
    ) {
      return result.review_artifacts.flatMap((artifact) => {
        const redacted = redactReviewArtifact(artifact);
        const basePath = [
          "reviewer-output/",
          safeFileSegment(result.task_id),
          "-",
          safeFileSegment(redacted.reviewer_agent_id),
        ].join("");
        return [
          {
            path: `${basePath}.md`,
            content: ensureTrailingNewline(redacted.markdown),
          },
          {
            path: `${basePath}.json`,
            content: `${JSON.stringify(redacted, null, 2)}\n`,
          },
        ];
      });
    }

    const agentId = result.reviewer_agent_id === ""
      ? "unknown-verifier"
      : result.reviewer_agent_id;
    const dir = verifierOutputDir(agentId);
    const path = `${dir}/${safeFileSegment(result.task_id)}-${safeFileSegment(agentId)}.txt`;
    const content = [
      `task_id: ${result.task_id}`,
      `reviewer_agent_id: ${agentId}`,
      `pass: ${result.pass ? "true" : "false"}`,
      `score: ${String(result.score)}`,
      `event_seq: ${result.event_seq}`,
      "",
      result.summary,
      "",
    ].join("\n");
    return [{ path, content: redactText(content) }];
  });
  assertUniqueArtifactPaths(artifacts);
  return artifacts;
}

function redactReviewArtifact(artifact: ReviewArtifact): ReviewArtifact {
  const redacted = new PIIRedactor().redactDeep(artifact);
  if (redacted.stats.timed_out) {
    throw new Error(
      `review proof redaction timed out${redacted.stats.timed_out_on !== undefined
        ? ` on ${redacted.stats.timed_out_on}`
        : ""}`,
    );
  }
  return redacted.value;
}

function redactText(content: string): string {
  const redacted = new PIIRedactor().redact(content);
  if (redacted.stats.timed_out) {
    throw new Error(
      `proof redaction timed out${redacted.stats.timed_out_on !== undefined
        ? ` on ${redacted.stats.timed_out_on}`
        : ""}`,
    );
  }
  return redacted.text;
}

function verifierOutputDir(
  agentId: string,
): "checker-output" | "reviewer-output" {
  const normalized = agentId.toLowerCase();
  return normalized.includes("checker")
    || normalized.includes("verify")
    || normalized.includes("verifier")
    ? "checker-output"
    : "reviewer-output";
}

function safeFileSegment(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function assertUniqueArtifactPaths(artifacts: readonly ProofArtifact[]): void {
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (paths.has(artifact.path)) {
      throw new Error(`duplicate proof artifact path: ${artifact.path}`);
    }
    paths.add(artifact.path);
  }
}

function rolesForAgentId(agentId: string): string[] {
  if (agentId === "local-command") {
    return ["coding", "test-verify", "release/proof"];
  }
  const adapter = defaultAdapters().find(
    (candidate) => candidate.id === agentId,
  );
  return rolesForCapabilityKinds(
    adapter?.capabilities().map((capability) => capability.kind) ?? [],
  );
}

function stringEventPayload(
  event: LoopEvent,
  key: string,
): string {
  return optionalStringEventPayload(event, key) ?? "unknown";
}

function optionalStringEventPayload(
  event: LoopEvent,
  key: string,
): string | undefined {
  const value = event.payload?.[key];
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function optionalBooleanEventPayload(
  event: LoopEvent,
  key: string,
): boolean | undefined {
  const value = event.payload?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function recordEventPayload(
  event: LoopEvent,
  key: string,
): Record<string, unknown> | undefined {
  const value = event.payload?.[key];
  return isRecord(value) ? value : undefined;
}

function stringRecordValue(
  record: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value);
}

function redactEvidence<T>(value: T): T {
  const redacted = new PIIRedactor().redactDeep(value);
  if (redacted.stats.timed_out) {
    throw new Error("profile proof evidence redaction timed out");
  }
  return redacted.value;
}
