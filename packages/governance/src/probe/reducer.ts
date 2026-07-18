import { sortProbeItems } from "./priority.js";
import {
  ProbeEventV1,
  ProbeItemV1,
  ProbeSessionV1,
  type ProbeActorV1,
  type ProbeCompilationV1,
  type ProbeDestinationV1,
  type ProbeReadinessV1,
  type ProbeSessionBaseV1,
} from "./types.js";
import { deriveProbeSeverity } from "./priority.js";

export interface ProbeDomainStateV1 {
  session: ProbeSessionV1;
  items: readonly ProbeItemV1[];
}

export interface ProbeMutationResultV1 extends ProbeDomainStateV1 {
  event: ProbeEventV1;
}

export interface ProbeInformationOutcomeV1 {
  low_information: boolean;
  followup_generated: boolean;
  destination_changed: boolean;
}

interface ProbeMutationMetadataV1 {
  if_revision: number;
  actor: ProbeActorV1;
  idempotency_key: string;
  event_id: string;
  occurred_at_ms: number;
}

export type ProbeMutationV1 = ProbeMutationMetadataV1 &
  (
    | {
        type: "resolve";
        item_id: string;
        answer: string;
        selected_option_id?: string;
        destination: ProbeDestinationV1;
        compilation: ProbeCompilationV1;
      }
    | {
        type: "defer";
        item_id: string;
        owner: string;
        revisit_trigger: string;
        review_after_ms?: number;
      }
    | {
        type: "waive";
        item_id: string;
        reason: string;
        expires_at_ms?: number;
      }
    | { type: "invalidate"; item_id: string; reason: string }
    | { type: "pause"; reason: string }
    | {
        type: "pause_diminishing_returns";
        recent_outcomes: readonly ProbeInformationOutcomeV1[];
      }
    | { type: "abandon"; reason: string }
    | {
        type: "resume";
        extend_budget?: number;
        revisit_item_ids: readonly string[];
        added_items?: readonly ProbeItemV1[];
        unselected_required_question_ids?: readonly string[];
      }
    | {
        type: "destination";
        item_id: string;
        destination_state: "applied" | "verified";
        content_sha256: string;
      }
  );

export type ProbeReducerErrorCodeV1 =
  | "conflict"
  | "invalid_transition"
  | "authority_required"
  | "invalid_item";

export class ProbeReducerError extends Error {
  readonly code: ProbeReducerErrorCodeV1;

  constructor(code: ProbeReducerErrorCodeV1, message: string) {
    super(message);
    this.name = "ProbeReducerError";
    this.code = code;
  }
}

function requireRevision(
  session: ProbeSessionV1,
  mutation: ProbeMutationV1,
): void {
  if (mutation.if_revision !== session.revision) {
    throw new ProbeReducerError(
      "conflict",
      `expected revision ${session.revision}, received ${mutation.if_revision}`,
    );
  }
}

type MutableProbeSessionV1 = Extract<
  ProbeSessionV1,
  { state: "active" | "paused" }
>;

function requireMutableSession(
  session: ProbeSessionV1,
): asserts session is MutableProbeSessionV1 {
  if (session.state === "completed" || session.state === "abandoned") {
    throw new ProbeReducerError(
      "invalid_transition",
      `session ${session.session_id} is ${session.state}`,
    );
  }
}

function mutableSessionBase(
  session: MutableProbeSessionV1,
): ProbeSessionBaseV1 {
  if (session.state === "active") {
    const {
      state: sessionState,
      current_question_id: currentQuestionId,
      ...base
    } = session;
    void sessionState;
    void currentQuestionId;
    return base;
  }
  const {
    state: sessionState,
    current_question_id: currentQuestionId,
    pause_reason: pauseReason,
    ...base
  } = session;
  void sessionState;
  void currentQuestionId;
  void pauseReason;
  return base;
}

function requireHuman(actor: ProbeActorV1, operation: string): void {
  if (actor.type !== "human") {
    throw new ProbeReducerError(
      "authority_required",
      `${operation} requires a human actor`,
    );
  }
}

const HUMAN_RESOLUTION_CATEGORIES = new Set<ProbeItemV1["category"]>([
  "user",
  "outcome",
  "scope",
  "data_model",
  "interface",
  "user_flow",
  "security",
  "migration",
  "rollback",
  "acceptance",
]);

function requireCurrentItem(
  state: ProbeDomainStateV1,
  itemId: string,
): { item: ProbeItemV1; index: number } {
  if (state.session.state !== "active") {
    throw new ProbeReducerError(
      "invalid_transition",
      "item disposition requires an active session",
    );
  }
  if (state.session.current_question_id !== itemId) {
    throw new ProbeReducerError(
      "conflict",
      `current question is ${state.session.current_question_id}`,
    );
  }
  const index = state.items.findIndex((item) => item.item_id === itemId);
  const item = state.items[index];
  if (item === undefined || item.state !== "open") {
    throw new ProbeReducerError("invalid_item", `item ${itemId} is not open`);
  }
  return { item, index };
}

function replaceItem(
  items: readonly ProbeItemV1[],
  index: number,
  item: ProbeItemV1,
): ProbeItemV1[] {
  const next = [...items];
  next[index] = ProbeItemV1.parse(item);
  return next;
}

function advanceAfterDisposition(
  session: ProbeSessionV1,
  items: readonly ProbeItemV1[],
  occurredAtMs: number,
): ProbeSessionV1 {
  if (session.state !== "active") {
    throw new ProbeReducerError(
      "invalid_transition",
      "only an active session can advance after a disposition",
    );
  }
  const nextRevision = session.revision + 1;
  const nextItem = sortProbeItems(
    items.filter((item) => item.state === "open"),
  )[0];
  if (nextItem !== undefined) {
    if (session.questions_presented >= session.question_budget) {
      return {
        ...session,
        state: "paused",
        current_question_id: nextItem.item_id,
        pause_reason: "budget",
        revision: nextRevision,
        updated_at_ms: occurredAtMs,
      };
    }
    return {
      ...session,
      state: "active",
      current_question_id: nextItem.item_id,
      questions_presented: session.questions_presented + 1,
      revision: nextRevision,
      updated_at_ms: occurredAtMs,
    };
  }

  const { current_question_id: currentQuestionId, ...sessionWithoutCurrent } =
    session;
  void currentQuestionId;

  const requiredOutstanding =
    session.unselected_required_question_ids.length > 0 ||
    items.some((item) => item.required && item.state === "deferred");
  if (requiredOutstanding) {
    return {
      ...sessionWithoutCurrent,
      state: "paused",
      pause_reason:
        session.unselected_required_question_ids.length > 0
          ? "budget"
          : "user",
      revision: nextRevision,
      updated_at_ms: occurredAtMs,
    };
  }
  return {
    ...sessionWithoutCurrent,
    state: "completed",
    completed_at_ms: occurredAtMs,
    revision: nextRevision,
    updated_at_ms: occurredAtMs,
  };
}

function quadrantAfterResolution(
  quadrant: ProbeItemV1["current_quadrant"],
): ProbeItemV1["current_quadrant"] {
  if (quadrant === "uu") return "ku";
  if (quadrant === "ku" || quadrant === "uk") return "kk";
  return quadrant;
}

function recordCalibrationAnswer(
  session: ProbeSessionV1,
  item: ProbeItemV1,
  mutation: Extract<ProbeMutationV1, { type: "resolve" }>,
): ProbeSessionV1 {
  if (item.origin !== "calibration") return session;
  if (mutation.destination.role !== "session_profile") {
    throw new ProbeReducerError(
      "invalid_item",
      "calibration answers must target the session profile",
    );
  }
  const value = mutation.selected_option_id ?? mutation.answer;
  if (!item.options.some((option) => option.option_id === value)) {
    throw new ProbeReducerError(
      "invalid_item",
      "calibration answer must select one of the declared options",
    );
  }
  const familiarity = {
    ...(session.familiarity ?? {}),
    [mutation.destination.profile_key]: value,
  };
  return ProbeSessionV1.parse({ ...session, familiarity });
}

function eventFor(
  sessionId: string,
  revision: number,
  mutation: ProbeMutationV1,
  type: ProbeEventV1["type"],
  payload: Record<string, unknown>,
  itemId?: string,
): ProbeEventV1 {
  return ProbeEventV1.parse({
    schema_version: "1",
    event_id: mutation.event_id,
    session_id: sessionId,
    revision,
    type,
    actor: mutation.actor,
    idempotency_key: mutation.idempotency_key,
    ...(itemId === undefined ? {} : { item_id: itemId }),
    occurred_at_ms: mutation.occurred_at_ms,
    payload,
  });
}

function resolveItem(
  state: ProbeDomainStateV1,
  mutation: Extract<ProbeMutationV1, { type: "resolve" }>,
): ProbeMutationResultV1 {
  const { item, index } = requireCurrentItem(state, mutation.item_id);
  if (HUMAN_RESOLUTION_CATEGORIES.has(item.category)) {
    requireHuman(mutation.actor, `${item.category} resolution`);
  }
  const resolved = ProbeItemV1.parse({
    ...item,
    state: "resolved",
    current_quadrant: quadrantAfterResolution(item.current_quadrant),
    resolution: {
      answer: mutation.answer,
      actor: mutation.actor,
      resolved_at_ms: mutation.occurred_at_ms,
      ...(mutation.selected_option_id === undefined
        ? {}
        : { selected_option_id: mutation.selected_option_id }),
    },
    destination: mutation.destination,
    compilation: mutation.compilation,
    updated_at_ms: mutation.occurred_at_ms,
  });
  const items = replaceItem(state.items, index, resolved);
  const calibratedSession = recordCalibrationAnswer(
    state.session,
    item,
    mutation,
  );
  const session = advanceAfterDisposition(
    calibratedSession,
    items,
    mutation.occurred_at_ms,
  );
  return {
    session,
    items,
    event: eventFor(
      session.session_id,
      session.revision,
      mutation,
      "answer_recorded",
      {
        destination_role: mutation.destination.role,
        resulting_session_state: session.state,
      },
      item.item_id,
    ),
  };
}

function deferItem(
  state: ProbeDomainStateV1,
  mutation: Extract<ProbeMutationV1, { type: "defer" }>,
): ProbeMutationResultV1 {
  const { item, index } = requireCurrentItem(state, mutation.item_id);
  const deferred = ProbeItemV1.parse({
    ...item,
    state: "deferred",
    deferral: {
      owner: mutation.owner,
      revisit_trigger: mutation.revisit_trigger,
      deferred_at_ms: mutation.occurred_at_ms,
      ...(mutation.review_after_ms === undefined
        ? {}
        : { review_after_ms: mutation.review_after_ms }),
    },
    updated_at_ms: mutation.occurred_at_ms,
  });
  const items = replaceItem(state.items, index, deferred);
  const session = advanceAfterDisposition(
    state.session,
    items,
    mutation.occurred_at_ms,
  );
  return {
    session,
    items,
    event: eventFor(
      session.session_id,
      session.revision,
      mutation,
      "item_deferred",
      { resulting_session_state: session.state },
      item.item_id,
    ),
  };
}

function waiveItem(
  state: ProbeDomainStateV1,
  mutation: Extract<ProbeMutationV1, { type: "waive" }>,
): ProbeMutationResultV1 {
  requireHuman(mutation.actor, "waiver");
  const { item, index } = requireCurrentItem(state, mutation.item_id);
  const waived = ProbeItemV1.parse({
    ...item,
    state: "waived",
    waiver: {
      reason: mutation.reason,
      approved_by: mutation.actor.id,
      approved_at_ms: mutation.occurred_at_ms,
      ...(mutation.expires_at_ms === undefined
        ? {}
        : { expires_at_ms: mutation.expires_at_ms }),
    },
    updated_at_ms: mutation.occurred_at_ms,
  });
  const items = replaceItem(state.items, index, waived);
  const session = advanceAfterDisposition(
    state.session,
    items,
    mutation.occurred_at_ms,
  );
  return {
    session,
    items,
    event: eventFor(
      session.session_id,
      session.revision,
      mutation,
      "item_waived",
      { resulting_session_state: session.state },
      item.item_id,
    ),
  };
}

function invalidateItem(
  state: ProbeDomainStateV1,
  mutation: Extract<ProbeMutationV1, { type: "invalidate" }>,
): ProbeMutationResultV1 {
  const { item, index } = requireCurrentItem(state, mutation.item_id);
  if (item.required) requireHuman(mutation.actor, "required invalidation");
  const invalidated = ProbeItemV1.parse({
    ...item,
    state: "invalidated",
    invalidation: {
      reason: mutation.reason,
      actor: mutation.actor,
      invalidated_at_ms: mutation.occurred_at_ms,
    },
    updated_at_ms: mutation.occurred_at_ms,
  });
  const items = replaceItem(state.items, index, invalidated);
  const session = advanceAfterDisposition(
    state.session,
    items,
    mutation.occurred_at_ms,
  );
  return {
    session,
    items,
    event: eventFor(
      session.session_id,
      session.revision,
      mutation,
      "item_invalidated",
      { resulting_session_state: session.state },
      item.item_id,
    ),
  };
}

function pauseSession(
  state: ProbeDomainStateV1,
  mutation: Extract<ProbeMutationV1, { type: "pause" }>,
): ProbeMutationResultV1 {
  if (state.session.state !== "active") {
    throw new ProbeReducerError(
      "invalid_transition",
      "only an active session can be paused",
    );
  }
  const session: ProbeSessionV1 = {
    ...state.session,
    state: "paused",
    current_question_id: state.session.current_question_id,
    pause_reason: "user",
    revision: state.session.revision + 1,
    updated_at_ms: mutation.occurred_at_ms,
  };
  return {
    session,
    items: [...state.items],
    event: eventFor(
      session.session_id,
      session.revision,
      mutation,
      "session_paused",
      { reason: mutation.reason },
    ),
  };
}

export function hasProbeDiminishingReturns(
  state: ProbeDomainStateV1,
  outcomes: readonly ProbeInformationOutcomeV1[],
): boolean {
  const window = outcomes.slice(-5);
  if (window.length !== 5) return false;
  if (
    state.items.some(
      (item) =>
        item.state === "open" &&
        item.required &&
        deriveProbeSeverity(item) === "high",
    )
  ) {
    return false;
  }
  return window.every(
    (outcome) =>
      outcome.low_information &&
      !outcome.followup_generated &&
      !outcome.destination_changed,
  );
}

function pauseForDiminishingReturns(
  state: ProbeDomainStateV1,
  mutation: Extract<
    ProbeMutationV1,
    { type: "pause_diminishing_returns" }
  >,
): ProbeMutationResultV1 {
  if (state.session.state !== "active") {
    throw new ProbeReducerError(
      "invalid_transition",
      "only an active session can be paused",
    );
  }
  if (!hasProbeDiminishingReturns(state, mutation.recent_outcomes)) {
    throw new ProbeReducerError(
      "invalid_transition",
      "the five-item diminishing-return window is not satisfied",
    );
  }
  const session: ProbeSessionV1 = {
    ...state.session,
    state: "paused",
    current_question_id: state.session.current_question_id,
    pause_reason: "diminishing_returns",
    revision: state.session.revision + 1,
    updated_at_ms: mutation.occurred_at_ms,
  };
  return {
    session,
    items: [...state.items],
    event: eventFor(
      session.session_id,
      session.revision,
      mutation,
      "session_paused",
      { reason: "diminishing_returns", window_size: 5 },
    ),
  };
}

function abandonSession(
  state: ProbeDomainStateV1,
  mutation: Extract<ProbeMutationV1, { type: "abandon" }>,
): ProbeMutationResultV1 {
  requireHuman(mutation.actor, "abandonment");
  requireMutableSession(state.session);
  const session: ProbeSessionV1 = {
    ...mutableSessionBase(state.session),
    state: "abandoned",
    abandoned_at_ms: mutation.occurred_at_ms,
    reason: mutation.reason,
    revision: state.session.revision + 1,
    updated_at_ms: mutation.occurred_at_ms,
  };
  return {
    session,
    items: [...state.items],
    event: eventFor(
      session.session_id,
      session.revision,
      mutation,
      "session_abandoned",
      { reason: mutation.reason },
    ),
  };
}

function resumeSession(
  state: ProbeDomainStateV1,
  mutation: Extract<ProbeMutationV1, { type: "resume" }>,
): ProbeMutationResultV1 {
  if (state.session.state !== "paused") {
    throw new ProbeReducerError(
      "invalid_transition",
      "only a paused session can be resumed",
    );
  }
  if (
    state.session.pause_reason === "budget" &&
    mutation.extend_budget === undefined
  ) {
    throw new ProbeReducerError(
      "invalid_transition",
      "a budget pause requires a finite budget extension",
    );
  }
  const extension = mutation.extend_budget ?? 0;
  if (
    !Number.isInteger(extension) ||
    extension < 0 ||
    state.session.question_budget + extension > 100
  ) {
    throw new ProbeReducerError(
      "invalid_transition",
      "budget extension must keep the finite budget within 100",
    );
  }

  const addedItems = [...(mutation.added_items ?? [])];
  const existingItemIds = new Set(state.items.map((item) => item.item_id));
  const existingQuestionIds = new Set(
    state.items.map((item) => item.question_id),
  );
  for (const item of addedItems) {
    if (
      item.session_id !== state.session.session_id ||
      item.state !== "open" ||
      existingItemIds.has(item.item_id) ||
      existingQuestionIds.has(item.question_id)
    ) {
      throw new ProbeReducerError(
        "invalid_item",
        "added resume items must be new, open, and belong to the session",
      );
    }
    existingItemIds.add(item.item_id);
    existingQuestionIds.add(item.question_id);
  }
  const revisitIds = new Set(mutation.revisit_item_ids);
  if (revisitIds.size !== mutation.revisit_item_ids.length) {
    throw new ProbeReducerError(
      "invalid_item",
      "revisited item ids must be unique",
    );
  }
  const items = [...state.items, ...addedItems].map((item) => {
    if (!revisitIds.has(item.item_id)) return item;
    if (item.state !== "deferred") {
      throw new ProbeReducerError(
        "invalid_item",
        `item ${item.item_id} is not deferred`,
      );
    }
    const { deferral, ...itemWithoutDeferral } = item;
    void deferral;
    return ProbeItemV1.parse({
      ...itemWithoutDeferral,
      state: "open",
      updated_at_ms: mutation.occurred_at_ms,
    });
  });
  for (const id of revisitIds) {
    if (!items.some((item) => item.item_id === id)) {
      throw new ProbeReducerError("invalid_item", `item ${id} does not exist`);
    }
  }

  const preferredRevisit = mutation.revisit_item_ids[0];
  const currentId =
    preferredRevisit ??
    state.session.current_question_id ??
    sortProbeItems(items.filter((item) => item.state === "open"))[0]?.item_id;
  if (currentId === undefined) {
    throw new ProbeReducerError(
      "invalid_transition",
      "session has no open item to resume",
    );
  }
  const wasAlreadyPresented =
    state.session.pause_reason === "user" &&
    state.session.current_question_id === currentId;
  const questionsPresented =
    state.session.questions_presented + (wasAlreadyPresented ? 0 : 1);
  const questionBudget = state.session.question_budget + extension;
  if (questionsPresented > questionBudget) {
    throw new ProbeReducerError(
      "invalid_transition",
      "resuming the next item would exceed the question budget",
    );
  }

  const session: ProbeSessionV1 = {
    ...mutableSessionBase(state.session),
    state: "active",
    current_question_id: currentId,
    question_budget: questionBudget,
    questions_presented: questionsPresented,
    selected_question_ids: [
      ...state.session.selected_question_ids,
      ...addedItems.map((item) => item.question_id),
    ],
    unselected_required_question_ids:
      mutation.unselected_required_question_ids === undefined
        ? state.session.unselected_required_question_ids
        : [...mutation.unselected_required_question_ids],
    revision: state.session.revision + 1,
    updated_at_ms: mutation.occurred_at_ms,
  };
  return {
    session,
    items,
    event: eventFor(
      session.session_id,
      session.revision,
      mutation,
      "session_resumed",
      {
        extended_budget: extension,
        revisited_item_ids: mutation.revisit_item_ids,
        current_question_id: currentId,
      },
    ),
  };
}

function attestDestination(
  state: ProbeDomainStateV1,
  mutation: Extract<ProbeMutationV1, { type: "destination" }>,
): ProbeMutationResultV1 {
  const index = state.items.findIndex(
    (item) => item.item_id === mutation.item_id,
  );
  const item = state.items[index];
  if (
    item === undefined ||
    item.state !== "resolved" ||
    item.destination.role === "session_profile"
  ) {
    throw new ProbeReducerError(
      "invalid_item",
      "destination attestation requires a resolved document item",
    );
  }
  if (
    mutation.destination_state === "verified" &&
    mutation.actor.type !== "human"
  ) {
    throw new ProbeReducerError(
      "authority_required",
      "destination verification requires a human actor",
    );
  }
  if (
    mutation.destination_state === "verified" &&
    item.destination.write_state !== "applied"
  ) {
    throw new ProbeReducerError(
      "invalid_transition",
      "destination must be applied before it can be verified",
    );
  }
  if (item.destination.write_state === "verified") {
    throw new ProbeReducerError(
      "invalid_transition",
      "a verified destination cannot move backward",
    );
  }
  const updated = ProbeItemV1.parse({
    ...item,
    destination: {
      ...item.destination,
      write_state: mutation.destination_state,
      content_sha256: mutation.content_sha256,
    },
    updated_at_ms: mutation.occurred_at_ms,
  });
  const items = replaceItem(state.items, index, updated);
  const session = ProbeSessionV1.parse({
    ...state.session,
    revision: state.session.revision + 1,
    updated_at_ms: mutation.occurred_at_ms,
  });
  return {
    session,
    items,
    event: eventFor(
      session.session_id,
      session.revision,
      mutation,
      "destination_updated",
      { destination_state: mutation.destination_state },
      item.item_id,
    ),
  };
}

export function applyProbeMutation(
  state: ProbeDomainStateV1,
  mutation: ProbeMutationV1,
): ProbeMutationResultV1 {
  requireRevision(state.session, mutation);
  if (mutation.type !== "destination") requireMutableSession(state.session);

  switch (mutation.type) {
    case "resolve":
      return resolveItem(state, mutation);
    case "defer":
      return deferItem(state, mutation);
    case "waive":
      return waiveItem(state, mutation);
    case "invalidate":
      return invalidateItem(state, mutation);
    case "pause":
      return pauseSession(state, mutation);
    case "pause_diminishing_returns":
      return pauseForDiminishingReturns(state, mutation);
    case "abandon":
      return abandonSession(state, mutation);
    case "resume":
      return resumeSession(state, mutation);
    case "destination":
      return attestDestination(state, mutation);
  }
}

export function getCurrentProbeItem(
  state: ProbeDomainStateV1,
): ProbeItemV1 | undefined {
  if (state.session.state !== "active" && state.session.state !== "paused") {
    return undefined;
  }
  const currentId = state.session.current_question_id;
  if (currentId === undefined) return undefined;
  return state.items.find((item) => item.item_id === currentId);
}

export function deriveProbeReadiness(
  state: ProbeDomainStateV1,
  nowMs: number,
): ProbeReadinessV1 {
  const violations: ProbeReadinessV1["violations"][number][] = [];
  const openBySeverity = { high: 0, medium: 0, low: 0 };
  let requiredDisposed = 0;
  let deferredDue = 0;
  let waivedActive = 0;
  let waivedExpired = 0;
  let destinationPending = 0;
  let destinationApplied = 0;
  let compilationManualRequired = 0;

  for (const item of sortProbeItems(state.items)) {
    const severity = deriveProbeSeverity(item);
    if (item.state === "open") {
      openBySeverity[severity] += 1;
      if (item.required) {
        violations.push({
          code: "open_required",
          severity,
          message: "A required question remains open.",
          item_id: item.item_id,
          question_id: item.question_id,
        });
      } else if (severity === "high") {
        violations.push({
          code: "open_high",
          severity,
          message: "A high-risk optional question remains open.",
          item_id: item.item_id,
          question_id: item.question_id,
        });
      } else {
        violations.push({
          code: "open_advisory",
          severity,
          message: "An optional question remains open.",
          item_id: item.item_id,
          question_id: item.question_id,
          advisory: true,
        });
      }
    } else if (item.state === "deferred") {
      const due =
        item.deferral.review_after_ms !== undefined &&
        item.deferral.review_after_ms <= nowMs;
      if (due) deferredDue += 1;
      if (severity === "high" || due) {
        violations.push({
          code: due ? "deferred_due" : "deferred_high",
          severity,
          message: due
            ? "A deferred question is due for review."
            : "A high-risk question is deferred.",
          item_id: item.item_id,
          question_id: item.question_id,
        });
      }
    } else if (item.state === "waived") {
      const expired =
        item.waiver.expires_at_ms !== undefined &&
        item.waiver.expires_at_ms <= nowMs;
      if (expired) {
        waivedExpired += 1;
        violations.push({
          code: "expired_waiver",
          severity,
          message: "A waiver has expired.",
          item_id: item.item_id,
          question_id: item.question_id,
        });
      } else {
        waivedActive += 1;
        if (item.required) requiredDisposed += 1;
      }
    } else if (item.state === "resolved") {
      if (item.required) requiredDisposed += 1;
      if (item.destination.role !== "session_profile") {
        if (item.destination.write_state === "pending") {
          destinationPending += 1;
          if (severity === "high") {
            violations.push({
              code: "destination_pending",
              severity,
              message: "A high-risk decision has not been applied.",
              item_id: item.item_id,
              question_id: item.question_id,
            });
          }
        } else {
          destinationApplied += 1;
        }
      }
      if (item.compilation.state === "manual_required") {
        compilationManualRequired += 1;
      }
    } else if (item.state === "invalidated") {
      if (item.required && item.invalidation.actor.type === "human") {
        requiredDisposed += 1;
      } else if (item.required) {
        violations.push({
          code: "invalidation_authority",
          severity,
          message: "A required invalidation lacks human authority.",
          item_id: item.item_id,
          question_id: item.question_id,
        });
      }
    }
  }

  for (const requiredQuestionId of state.session
    .unselected_required_question_ids) {
    violations.push({
      code: "missing_required",
      severity: "high",
      message: "A required pack question was not selected.",
      question_id: requiredQuestionId,
    });
  }

  const requiredTotal =
    state.items.filter((item) => item.required).length +
    state.session.unselected_required_question_ids.length;
  const completionPercent =
    requiredTotal === 0
      ? 100
      : Math.round((requiredDisposed / requiredTotal) * 10_000) / 100;
  return {
    required_total: requiredTotal,
    required_disposed: requiredDisposed,
    open_by_severity: openBySeverity,
    deferred_due: deferredDue,
    waived_active: waivedActive,
    waived_expired: waivedExpired,
    resolved_destination_pending: destinationPending,
    resolved_destination_applied: destinationApplied,
    compilation_manual_required: compilationManualRequired,
    completion_percent: completionPercent,
    eligible: !violations.some((violation) => violation.advisory !== true),
    violations,
  };
}
