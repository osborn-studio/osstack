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
  {
    key: "graph", title: "Osstack Graph v1 Contract Registry", schema: GraphProtocol, references: "root",
    comment: "Registry of strict versioned JSON graph contracts. Zod additionally enforces finite JSON values, 65536-byte/16-depth/4096-value envelope bounds, plain data properties and retryable error rules. Authentication, current scope/run/generation checks, canonical digests, idempotency and revision decisions require the protocol helpers. Trusted daemon integration must verify identity, authority, artifacts and leases and enforce durable atomic CAS/dedup. No checkpoint or graph data grants authority.",
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
