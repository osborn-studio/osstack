import { z } from "zod";

const Id = z.string().trim().min(1).max(256);
const Timestamp = z.string().datetime({ offset: true });
const Instruction = z.string().min(1).max(16_000).refine(
  (value) => value.trim().length > 0,
  "instruction must contain non-whitespace text",
);
const AbsolutePath = z.string().max(4_096).regex(
  /^(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+(?:[\\/]|$))/,
  "repo_path must be an absolute path",
).refine((value) => !value.includes("\0"), "repo_path must not contain NUL characters");

/**
 * Equality against persisted assistant_text only. These checks attest to the
 * declared output contract, never open-ended task quality or an R3 approval.
 * A JSON path is a sequence of literal keys; [] selects the root primitive.
 * Consumers must use own-property traversal, not eval or prototype lookup.
 */
export const OutputCheck = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("text_equals"),
    expected: z.string().max(4_000),
  }).strict(),
  z.object({
    kind: z.literal("json_value_equals"),
    path: z.array(z.string().max(256)).max(8),
    expected: z.union([z.null(), z.string().max(4_000), z.number().finite(), z.boolean()]),
  }).strict(),
]);
export type OutputCheck = z.infer<typeof OutputCheck>;

/** The checks must pass before the frozen instruction for this step is sent. */
export const ContinuationGrantStep = z.object({
  phase: Id,
  instruction: Instruction,
  checks: z.array(OutputCheck).min(1).max(16),
  retry_instruction: Instruction.optional(),
  max_retries: z.number().int().min(0).max(3).default(0),
}).strict();
export type ContinuationGrantStep = z.infer<typeof ContinuationGrantStep>;

/**
 * A finite delegation bound to one session, runtime policy, repository and
 * initial turn/version. "Completed" means all delegated instructions were sent
 * and completed; it does not mean the user's overall objective was achieved.
 * Signature verification, time validity and durable consumption are runtime
 * responsibilities. This schema does not grant GitHub or R3 approval powers.
 */
export const ContinuationGrantBody = z.object({
  version: z.literal(1),
  grant_id: Id,
  session_id: Id,
  runtime_id: Id,
  runtime_policy_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  repo_path: AbsolutePath,
  initial_turn_id: Id,
  initial_version: z.number().int().min(1),
  issued_at: Timestamp,
  expires_at: Timestamp,
  max_resumes: z.number().int().min(1).max(32),
  max_checks: z.number().int().min(1).max(64),
  turn_timeout_ms: z.number().int().min(100).max(300_000),
  steps: z.array(ContinuationGrantStep).min(1).max(16),
}).strict();
export type ContinuationGrantBody = z.infer<typeof ContinuationGrantBody>;

export const SignedContinuationGrant = z.object({
  body: ContinuationGrantBody,
  key_id: Id,
  signature: z.string().regex(
    /^[A-Za-z0-9+/]{85}[AQgw]==$/,
    "signature must be canonical base64 for a 64-byte Ed25519 signature",
  ),
}).strict();
export type SignedContinuationGrant = z.infer<typeof SignedContinuationGrant>;
