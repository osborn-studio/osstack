import { z } from "zod";

/** Closed Session-adoption pilot. Parsing supplies no authority. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: wire identities must reject NUL bytes.
const Id = z.string().min(1).max(512).regex(/^[^\u0000]+$/);
// biome-ignore lint/suspicious/noControlCharactersInRegex: idempotency identities must reject NUL bytes.
const ActionId = z.string().min(1).max(256).regex(/^[^\u0000]+$/);
const Revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const Digest = z.string().regex(/^[a-f0-9]{64}$/);
const Reason = z.string().min(1).max(1000).refine((value) => value.trim().length > 0, "must not be blank");
// biome-ignore lint/suspicious/noControlCharactersInRegex: bearer transport must reject NUL and line separators.
const Credential = z.string().min(32).max(4096).regex(/^[^\u0000\r\n]+$/);

export const EngineeringDecisionRef = z.object({
  kind: z.literal("session_decision"),
  scope_id: Id,
  item_id: Id,
  item_revision: Revision,
  session_id: Id,
  turn_id: Id,
  decision_id: Id,
  source_version: Revision,
  content_hash: Digest,
}).strict();
export type EngineeringDecisionRef = z.infer<typeof EngineeringDecisionRef>;

export const EngineeringAnswer = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("choice"), choice_id: ActionId }).strict(),
  z.object({ kind: z.literal("text"), text: z.string().min(1).max(16000)
    .refine((value) => value.trim().length > 0, "must not be blank")
    .refine((value) => !value.includes("\0"), "must not contain NUL") }).strict(),
]);
export type EngineeringAnswer = z.infer<typeof EngineeringAnswer>;

export const EngineeringAdoptRequest = z.object({
  scope_id: Id, task_id: Id, run_id: Id, session_id: Id,
  goal: z.string().min(1).max(4000).refine((value) => value.trim().length > 0, "must not be blank"),
  request_id: ActionId,
  completion_level: z.literal("observed_turn").default("observed_turn"),
}).strict();
export type EngineeringAdoptRequest = z.infer<typeof EngineeringAdoptRequest>;

export const EngineeringObserveRequest = z.object({
  mission_id: Id,
  cursor: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  limit: z.number().int().min(1).max(100).optional(),
}).strict();
export type EngineeringObserveRequest = z.infer<typeof EngineeringObserveRequest>;

export const EngineeringDecideRequest = z.object({
  mission_id: Id, wait_id: Id, if_revision: Revision,
  decision_ref: EngineeringDecisionRef,
  action_id: ActionId,
  answer: EngineeringAnswer,
  // biome-ignore lint/suspicious/noControlCharactersInRegex: opaque tokens must reject NUL and line separators.
  interaction_token: z.string().min(32).max(4096).regex(/^[^\u0000\r\n]+$/),
}).strict();
export type EngineeringDecideRequest = z.infer<typeof EngineeringDecideRequest>;

export const EngineeringDeferRequest = z.object({
  mission_id: Id, wait_id: Id, if_revision: Revision, wait_revision: Revision,
  request_id: ActionId, revisit_at: z.string().datetime({ offset: false }).max(40), reason: Reason,
}).strict();
export type EngineeringDeferRequest = z.infer<typeof EngineeringDeferRequest>;

export const EngineeringCancelRequest = z.object({
  mission_id: Id, if_revision: Revision, request_id: ActionId, reason: Reason.optional(),
}).strict();
export type EngineeringCancelRequest = z.infer<typeof EngineeringCancelRequest>;
export const EngineeringEndObservationRequest = EngineeringCancelRequest;
export type EngineeringEndObservationRequest = z.infer<typeof EngineeringEndObservationRequest>;

const QueryAction = z.object({ kind: z.literal("query_action"), mission_id: Id, action_id: ActionId }).strict();
const DisposeWait = z.object({
  kind: z.literal("dispose_wait"), mission_id: Id, wait_id: Id,
  if_revision: Revision, wait_revision: Revision, request_id: ActionId,
  observed_source_version: Revision, observed_turn_id: Id, observed_snapshot_digest: Digest,
  disposition: z.enum(["human_answered_out_of_band", "no_longer_relevant"]), reason: Reason,
}).strict();
export const EngineeringReconcileRequest = z.discriminatedUnion("kind", [QueryAction, DisposeWait]);
export type EngineeringReconcileRequest = z.infer<typeof EngineeringReconcileRequest>;

/** The host resolves this credential to its principal and scope grants. No request actor is trusted. */
export const EngineeringRpcRequests = {
  "engineering.adopt": EngineeringAdoptRequest.extend({ credential: Credential }),
  "engineering.observe": EngineeringObserveRequest.extend({ credential: Credential }),
  "engineering.decide": EngineeringDecideRequest.extend({ credential: Credential }),
  "engineering.defer": EngineeringDeferRequest.extend({ credential: Credential }),
  "engineering.cancel": EngineeringCancelRequest.extend({ credential: Credential }),
  "engineering.endObservation": EngineeringEndObservationRequest.extend({ credential: Credential }),
  "engineering.reconcile": z.discriminatedUnion("kind", [
    QueryAction.extend({ credential: Credential }), DisposeWait.extend({ credential: Credential }),
  ]),
} as const;
