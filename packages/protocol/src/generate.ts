import { EngineeringDecisionRef, EngineeringAnswer, EngineeringAdoptRequest, EngineeringObserveRequest, EngineeringDecideRequest, EngineeringDeferRequest, EngineeringCancelRequest, EngineeringEndObservationRequest, EngineeringReconcileRequest } from "./engineering.js";
import { FollowUpCreateParams, FollowUpListParams, FollowUpDraftParams, FollowUpResolveParams, FollowUpObligation, FollowUpMutationResult, FollowUpListResult } from "./follow-up.js";
// JSON Schema generation — Zod is the source of truth; this module emits the
// committed schemas/*.schema.json artifacts. A single manifest is the shared
// source of truth for both scripts/generate-schemas.mjs (writes/checks the
// files) and schemas.test.ts (asserts zero drift), so regeneration is
// guaranteed identical from either entry point.
//
// NOTE (superRefine): the A-003 status<->code conditional rules on
// AgentCommandResult are enforced by a Zod superRefine, which zod-to-json-schema
// cannot represent. The generated agent-command-result schema therefore
// documents the object SHAPE only; the conditional rules live in the superRefine
// and the tests. This is a known, documented limitation, not a gap.

import { DeliveryContractV2, FrozenDeliveryContractV2, DeliveryVerificationReceiptV2 } from "./delivery-contract.js";
import { AttentionInbox, AttentionStatus } from "./attention.js";
import { GraphWorkerMessage } from "./graph-worker.js";
import { GraphCheckpointRequest, GraphCheckpointResponse } from "./graph-checkpoint.js";
import type { ZodTypeAny } from "zod";
import { GraphProtocol } from "./graph.js";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  AgentCommand,
  AgentCommandResultObject,
} from "./envelope.js";
import { ApprovalDecision, ApprovalRequest } from "./approval.js";
import {
  AutonomyRiskDecision,
  AutonomyRiskLevel,
  AutonomyRunState,
  ScopedApprovalDecision,
  ScopedApprovalRequest,
} from "./autonomy.js";
import { EvidenceRef } from "./evidence.js";
import { EventEnvelope } from "./event.js";
import { PolicyDecision } from "./policy.js";
import { RunSummary } from "./run.js";
import { Task } from "./task.js";
import { SessionContinuationRequest, SessionDecision } from "./session-continuation.js";
import { ContinuationGrantBody, OutputCheck, SignedContinuationGrant } from "./session-continuation-grant.js";

interface SchemaEntry {
  /** File basename (without the .schema.json suffix) and schema registry key. */
  key: string;
  /** Human-readable title embedded in the JSON Schema. */
  title: string;
  /** Optional top-level $comment embedded in the generated JSON Schema. */
  comment?: string;
  schema: ZodTypeAny;
  references?: "root";
}

/** Public protocol contracts emitted as JSON Schema. Order is stable. */
export const SCHEMA_MANIFEST: readonly SchemaEntry[] = [
  { key: "engineering-decision-ref", title: "OSStack EngineeringDecisionRef", schema: EngineeringDecisionRef, comment: "Session adoption pilot shape only. Host authentication, current scope grants, immutable owner, exact source binding, transactional CAS and dispatch fences are runtime checks. No field grants authority." },
  { key: "engineering-answer", title: "OSStack EngineeringAnswer", schema: EngineeringAnswer, comment: "Session adoption pilot shape only. Host authentication, current scope grants, immutable owner, exact source binding, transactional CAS and dispatch fences are runtime checks. No field grants authority." },
  { key: "engineering-adopt-request", title: "OSStack EngineeringAdoptRequest", schema: EngineeringAdoptRequest, comment: "Session adoption pilot shape only. Host authentication, current scope grants, immutable owner, exact source binding, transactional CAS and dispatch fences are runtime checks. No field grants authority." },
  { key: "engineering-observe-request", title: "OSStack EngineeringObserveRequest", schema: EngineeringObserveRequest, comment: "Session adoption pilot shape only. Host authentication, current scope grants, immutable owner, exact source binding, transactional CAS and dispatch fences are runtime checks. No field grants authority." },
  { key: "engineering-decide-request", title: "OSStack EngineeringDecideRequest", schema: EngineeringDecideRequest, comment: "Session adoption pilot shape only. Host authentication, current scope grants, immutable owner, exact source binding, transactional CAS and dispatch fences are runtime checks. No field grants authority." },
  { key: "engineering-defer-request", title: "OSStack EngineeringDeferRequest", schema: EngineeringDeferRequest, comment: "Session adoption pilot shape only. Host authentication, current scope grants, immutable owner, exact source binding, transactional CAS and dispatch fences are runtime checks. No field grants authority." },
  { key: "engineering-cancel-request", title: "OSStack EngineeringCancelRequest", schema: EngineeringCancelRequest, comment: "Session adoption pilot shape only. Host authentication, current scope grants, immutable owner, exact source binding, transactional CAS and dispatch fences are runtime checks. No field grants authority." },
  { key: "engineering-end-observation-request", title: "OSStack EngineeringEndObservationRequest", schema: EngineeringEndObservationRequest, comment: "Session adoption pilot shape only. Host authentication, current scope grants, immutable owner, exact source binding, transactional CAS and dispatch fences are runtime checks. No field grants authority." },
  { key: "engineering-reconcile-request", title: "OSStack EngineeringReconcileRequest", schema: EngineeringReconcileRequest, comment: "Session adoption pilot shape only. Host authentication, current scope grants, immutable owner, exact source binding, transactional CAS and dispatch fences are runtime checks. No field grants authority." },
  {key:"follow-up-create-params",title:"OSStack FollowUpCreateParams",schema:FollowUpCreateParams,comment:"Local ledger only; parsing does not authorize remote delivery. Runtime validates canonical repository, source binding, revisions and response byte budget."},
  {key:"follow-up-list-params",title:"OSStack FollowUpListParams",schema:FollowUpListParams,comment:"Local ledger only; parsing does not authorize remote delivery. Runtime validates canonical repository, source binding, revisions and response byte budget."},
  {key:"follow-up-draft-params",title:"OSStack FollowUpDraftParams",schema:FollowUpDraftParams,comment:"Local ledger only; parsing does not authorize remote delivery. Runtime validates canonical repository, source binding, revisions and response byte budget."},
  {key:"follow-up-resolve-params",title:"OSStack FollowUpResolveParams",schema:FollowUpResolveParams,comment:"Local ledger only; parsing does not authorize remote delivery. Runtime validates canonical repository, source binding, revisions and response byte budget."},
  {key:"follow-up-obligation",title:"OSStack FollowUpObligation",schema:FollowUpObligation,comment:"Local ledger only; parsing does not authorize remote delivery. Runtime validates canonical repository, source binding, revisions and response byte budget."},
  {key:"follow-up-mutation-result",title:"OSStack FollowUpMutationResult",schema:FollowUpMutationResult,comment:"Local ledger only; parsing does not authorize remote delivery. Runtime validates canonical repository, source binding, revisions and response byte budget."},
  {key:"follow-up-list-result",title:"OSStack FollowUpListResult",schema:FollowUpListResult,comment:"Local ledger only; parsing does not authorize remote delivery. Runtime validates canonical repository, source binding, revisions and response byte budget."},
  {key:"delivery-contract-v2",title:"OSStack Delivery Contract v2",schema:DeliveryContractV2,
    comment:"Shape only. Zod additionally enforces completion/action/publication constraints, unique checks, canonical references and scout restrictions. Contract fields constrain existing host authorization; they never grant it."},
  {key:"frozen-delivery-contract-v2",title:"OSStack Frozen Delivery Contract v2",schema:FrozenDeliveryContractV2,
    comment:"Shape only. The host must recompute the canonical contract digest and bind it to the actual repository and accepted policy."},
  {key:"delivery-verification-receipt-v2",title:"OSStack Host Delivery Verification Receipt v2",schema:DeliveryVerificationReceiptV2,
    comment:"Parsing does not authenticate provenance. Verify host-owned receipt, run/task/candidate/contract/policy binding, actual command results and independent review before deriving completion."},
  { key: "attention-inbox", title: "OSStack Attention Inbox", schema: AttentionInbox },
  { key: "attention-status", title: "OSStack Attention Snapshot", schema: AttentionStatus },
  { key: "graph-worker", title: "Graph Worker IPC", schema: GraphWorkerMessage, references: "root", comment: "Dedicated length-prefixed fd3 transport; cap raw bytes before allocation and JSON.parse. Host registration supplies authority. done is not process exit evidence." },
  { key: "graph-checkpoint-request", title: "Graph Checkpoint Request", schema: GraphCheckpointRequest, comment: "Opaque bounded codec data; transport caps raw frames at 8 MiB. Host binds authenticated run and fences transaction before reads, writes and replay. No JSON field confers authority." },
  { key: "graph-checkpoint-response", title: "Graph Checkpoint Response", schema: GraphCheckpointResponse },
  {
    key: "graph", title: "Osstack Graph v1 Contract Registry", schema: GraphProtocol, references: "root",
    comment: "Registry of strict versioned JSON graph contracts. Zod additionally enforces finite JSON values, 65536-byte/16-depth/4096-value envelope bounds, plain data properties, response outcome/error consistency and effect/error location. Transport must cap raw bytes before JSON.parse. Authentication, current scope/run/generation/spec/epoch checks, request/response pairing, canonical digests, idempotency and scoped revision decisions require the protocol helpers. Trusted daemon integration must verify identity, authority, artifacts and leases and enforce durable atomic CAS/dedup. No checkpoint or graph data grants authority.",
  },
  { key: "task", title: "Osstack Protocol Task", schema: Task },
  { key: "run-summary", title: "Osstack Protocol Run Summary", schema: RunSummary },
  { key: "event-envelope", title: "Osstack Protocol Event Envelope", schema: EventEnvelope },
  { key: "evidence-ref", title: "Osstack Protocol Evidence Ref", schema: EvidenceRef },
  { key: "approval-request", title: "Osstack Protocol Approval Request", schema: ApprovalRequest },
  { key: "approval-decision", title: "Osstack Protocol Approval Decision", schema: ApprovalDecision },
  {
    key: "session-continuation-request",
    title: "Osstack Session Continuation Request",
    comment: "Agent-reported request only. Evidence references must be independently verified and this object never authorizes an action.",
    schema: SessionContinuationRequest,
  },
  {
    key: "session-decision",
    title: "Osstack Session Decision Request",
    comment: "Choice ID uniqueness is additionally enforced by Zod. The optional continuation is an untrusted request, not an approval.",
    schema: SessionDecision,
  },
  {
    key: "continuation-output-check",
    title: "Osstack Continuation Persisted Output Check",
    comment: "Checks only a declared equality contract against persisted assistant_text. JSON paths use literal own-property keys; an empty path selects the root primitive. This is not proof of open-ended quality or permission to execute scripts.",
    schema: OutputCheck,
  },
  {
    key: "continuation-grant-body",
    title: "Osstack Session Continuation Grant Body",
    comment: "Frozen finite instructions bound to a session and runtime policy. Zod additionally rejects NUL in repo_path and whitespace-only instructions without trimming their contents. Each step checks persisted output before sending its instruction. Completion means the delegated instructions finished, not that the user's whole task succeeded. Runtime verification enforces issued_at <= now < expires_at and a positive validity interval of at most 24 hours; durable consumption belongs to the session control plane.",
    schema: ContinuationGrantBody,
  },
  {
    key: "signed-continuation-grant",
    title: "Osstack Signed Session Continuation Grant",
    comment: "Ed25519 signs UTF-8 canonical JSON of the strictly parsed body (defaults included, object keys sorted, array order preserved). Zod additionally rejects NUL in repo_path and whitespace-only instructions without rewriting their contents. Signature and trusted-key verification are required at runtime. This grant carries no R3 or GitHub approval authority.",
    schema: SignedContinuationGrant,
  },
  {
    key: "autonomy-risk-level",
    title: "Osstack Guarded Autonomy Risk Level",
    schema: AutonomyRiskLevel,
  },
  {
    key: "autonomy-risk-decision",
    title: "Osstack Guarded Autonomy Risk Decision",
    comment:
      "Canonical signal ordering and maximum-level consistency are additionally enforced by @osstack/protocol Zod refinements.",
    schema: AutonomyRiskDecision,
  },
  {
    key: "autonomy-run-state",
    title: "Osstack Guarded Autonomy Run State",
    schema: AutonomyRunState,
  },
  {
    key: "scoped-approval-request",
    title: "Osstack Guarded Autonomy Scoped Approval Request",
    comment:
      "Preflight empty-diff binding, build/verify-only scope, canonical action ordering, and validity windows are additionally enforced by @osstack/protocol Zod refinements.",
    schema: ScopedApprovalRequest,
  },
  {
    key: "scoped-approval-decision",
    title: "Osstack Guarded Autonomy Signed Scoped Approval Decision",
    comment:
      "Human-actor and validity-window constraints are additionally enforced by @osstack/protocol Zod refinements; signature verification and replay defense belong to the runtime autonomy verifier.",
    schema: ScopedApprovalDecision,
  },
  { key: "policy-decision", title: "Osstack Protocol Policy Decision", schema: PolicyDecision },
  { key: "agent-command", title: "Osstack Protocol Agent Command", schema: AgentCommand },
  {
    key: "agent-command-result",
    title: "Osstack Protocol Agent Command Result",
    comment:
      "Conditional rules (A-003 status<->code mapping, A-006 retryable constraint) are enforced by @osstack/protocol superRefine and are NOT expressible in this JSON Schema; see AGENT_COMMAND_PROTOCOL_V1.md.",
    schema: AgentCommandResultObject,
  },
];

/** Render one schema entry to a pretty-printed JSON Schema string (trailing NL). */
function renderSchema(entry: SchemaEntry): string {
  const json = zodToJsonSchema(entry.schema, {
    target: "jsonSchema7",
    $refStrategy: entry.references ?? "none",
  }) as Record<string, unknown>;
  // Stable, self-describing header fields, independent of Zod internals.
  const withMeta: Record<string, unknown> = {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: entry.title,
    ...(entry.comment !== undefined ? { $comment: entry.comment } : {}),
    ...json,
  };
  return `${JSON.stringify(withMeta, null, 2)}\n`;
}

/** filename -> file content for every committed schema. */
export function generateAll(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of SCHEMA_MANIFEST) {
    out[`${entry.key}.schema.json`] = renderSchema(entry);
  }
  return out;
}
