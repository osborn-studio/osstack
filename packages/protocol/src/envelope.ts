// Agent command envelope + result — the invoke/response contract every agent
// surface (Claude Code, Codex, Hermes, CI, PartnerOS) uses to call osstack
// application services. Implements AGENT_COMMAND_PROTOCOL_V1 exactly.
//
// ── A-007 producer-strict / consumer-lenient ──────────────────────────────
// `additionalProperties: false` is the PRODUCER/authoring contract: a producer
// MUST NOT emit fields outside its own protocol version. So the exported
// `AgentCommand` / `AgentCommandResult` are `.strict()` (use these to author &
// validate outbound values and fixtures). A CONSUMER MUST parse inbound
// envelopes leniently so a v1.0 consumer accepts a v1.1 message whose additions
// are optional — hence `parseInboundAgentCommand` / `parseInboundAgentCommandResult`
// use `.passthrough()`. Business rules (A-003 status<->code) are enforced in
// BOTH modes via superRefine; only unknown-field tolerance differs.

import { z } from "zod";
import { Actor, ApprovalRequest } from "./approval.js";
import { EvidenceRef } from "./evidence.js";
import { ProtocolVersion } from "./version.js";

/** Dot-separated `<service>.<action>` identifier, e.g. "portfolio.daily". */
export const CommandName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/, {
    message: "command must be <service>.<action> (lowercase, dot-separated)",
  });
export type CommandName = z.infer<typeof CommandName>;

/** Narrows a command to a portfolio and/or repo (A-001). */
export const CommandScope = z
  .object({
    portfolio_id: z.string().min(1).optional(),
    repo_id: z.string().min(1).optional(),
  })
  .strict();
export type CommandScope = z.infer<typeof CommandScope>;

// ── A-001 Command envelope ────────────────────────────────────────────────

const agentCommandShape = {
  protocol_version: ProtocolVersion,
  command: CommandName,
  actor: Actor,
  scope: CommandScope.optional(),
  input: z.record(z.unknown()),
  policy_profile: z.string().min(1).optional(),
  idempotency_key: z.string().min(1).optional(),
} as const;

/** Producer/authoring schema — strict (A-007). Use to emit & validate outbound. */
export const AgentCommand = z.object(agentCommandShape).strict();
export type AgentCommand = z.infer<typeof AgentCommand>;

const AgentCommandLenient = z.object(agentCommandShape).passthrough();

/** Consumer parser — lenient (A-007): tolerates unknown (future-minor) fields. */
export function parseInboundAgentCommand(value: unknown): z.infer<typeof AgentCommandLenient> {
  return AgentCommandLenient.parse(value);
}

// ── A-006 Error taxonomy ──────────────────────────────────────────────────

export const ErrorCode = z.enum([
  "bad_request",
  "unsupported_protocol_version",
  "unknown_command",
  "policy_denied",
  "not_found",
  "conflict",
  "budget_exceeded",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** The two codes that pair with `status: "blocked"` (A-003 / A-006). */
const BLOCKED_CODES = ["policy_denied", "budget_exceeded"] as const;

export const CommandError = z
  .object({
    code: ErrorCode,
    message: z.string().min(1),
    /** True only for transient failures (internal, conflict) — A-006. */
    retryable: z.boolean(),
  })
  .strict();
export type CommandError = z.infer<typeof CommandError>;

/** Advisory follow-up command suggestion (A-003; advisory only). */
export const NextAction = z
  .object({
    command: CommandName,
    reason: z.string().min(1),
  })
  .strict();
export type NextAction = z.infer<typeof NextAction>;

export const CommandStatus = z.enum(["ok", "needs_approval", "blocked", "error"]);
export type CommandStatus = z.infer<typeof CommandStatus>;

// ── A-003 Command result ──────────────────────────────────────────────────

const agentCommandResultShape = {
  protocol_version: ProtocolVersion,
  status: CommandStatus,
  result: z.record(z.unknown()).optional(),
  evidence_refs: z.array(EvidenceRef).optional(),
  required_approvals: z.array(ApprovalRequest).optional(),
  next_actions: z.array(NextAction).optional(),
  error: CommandError.nullable().optional(),
} as const;

/**
 * A-003 status<->code mapping (JSON Schema expresses this with if/then; here it
 * is a superRefine because JSON Schema conditionals do not round-trip through
 * zod-to-json-schema — see schemas/ note):
 *   error           => error object present (any code EXCEPT the blocked codes)
 *   blocked         => error object present with code policy_denied|budget_exceeded
 *   needs_approval  => required_approvals non-empty
 * (A-006: blocked codes pair only with blocked; all other codes pair with error.)
 */
function refineAgentCommandResult(
  value: {
    status: z.infer<typeof CommandStatus>;
    error?: z.infer<typeof CommandError> | null | undefined;
    required_approvals?: unknown[] | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const isBlockedCode = value.error
    ? (BLOCKED_CODES as readonly string[]).includes(value.error.code)
    : false;

  if (value.status === "error") {
    if (!value.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "status 'error' requires an error object (A-003)",
      });
    } else if (isBlockedCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error", "code"],
        message:
          "codes policy_denied/budget_exceeded MUST use status 'blocked', not 'error' (A-006)",
      });
    }
  }

  if (value.status === "blocked") {
    if (!value.error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error"],
        message: "status 'blocked' requires an error object (A-003)",
      });
    } else if (!isBlockedCode) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["error", "code"],
        message:
          "status 'blocked' requires error code policy_denied or budget_exceeded (A-003/A-006)",
      });
    }
  }

  if (value.status === "needs_approval") {
    if (!value.required_approvals || value.required_approvals.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["required_approvals"],
        message: "status 'needs_approval' requires a non-empty required_approvals (A-003)",
      });
    }
  }
}

/** Producer/authoring schema — strict (A-007) + A-003 status<->code enforcement. */
export const AgentCommandResult = z
  .object(agentCommandResultShape)
  .strict()
  .superRefine(refineAgentCommandResult);
export type AgentCommandResult = z.infer<typeof AgentCommandResult>;

const AgentCommandResultLenient = z
  .object(agentCommandResultShape)
  .passthrough()
  .superRefine(refineAgentCommandResult);

/** Consumer parser — lenient (A-007) but still enforces the A-003 status rules. */
export function parseInboundAgentCommandResult(
  value: unknown,
): z.infer<typeof AgentCommandResultLenient> {
  return AgentCommandResultLenient.parse(value);
}

/**
 * The strict object schema WITHOUT the superRefine, exported for JSON Schema
 * generation. (Conditional A-003 rules do not survive zod-to-json-schema; the
 * generated schema documents the object shape, the superRefine + tests document
 * the conditional rules — see schemas/ and the tests.)
 */
export const AgentCommandResultObject = z.object(agentCommandResultShape).strict();
