import { describe, expect, it } from "vitest";
import {
  DEFAULT_PROBE_GATE_POLICY_V1,
  ProbeGatePolicyV1,
  evaluateProbeGate,
} from "./gate.js";
import { ProbeSessionV1 } from "./types.js";
import type {
  ProbeEventV1,
  ProbeItemV1,
} from "./types.js";

function baseItem(
  id: string,
  questionId: string,
  overrides: Partial<ProbeItemV1> = {},
): ProbeItemV1 {
  return {
    schema_version: "1",
    item_id: id,
    question_id: questionId,
    session_id: "probe_gate0001",
    item_kind: "question",
    initial_quadrant: "ku",
    current_quadrant: "ku",
    doc_type: "tech",
    category: "data_model",
    origin: "static_pack",
    prompt: questionId,
    options: [],
    impact: 3,
    irreversibility: 3,
    uncertainty: 3,
    required: true,
    evidence_refs: [],
    destination_hint: "technical_design",
    created_at_ms: 1,
    updated_at_ms: 1,
    state: "open",
    ...overrides,
  } as ProbeItemV1;
}

function session(items: readonly ProbeItemV1[]): ProbeSessionV1 {
  return {
    schema_version: "1",
    session_id: "probe_gate0001",
    repo_id: "osstack",
    worktree_state: "clean",
    input_refs: [],
    doc_types: ["tech"],
    question_pack_refs: [{ pack_id: "probe.tech", version: "1" }],
    selected_question_ids: items.map((item) => item.question_id),
    unselected_required_question_ids: ["tech.migration_rollback.v1"],
    depth: "quick",
    question_budget: 8,
    questions_presented: 1,
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 1,
    state: "active",
    current_question_id: items[0]?.item_id ?? "pi_gate0001",
  };
}

describe("probe readiness gate", () => {
  it("parses a strict policy with the documented report defaults", () => {
    expect(ProbeGatePolicyV1.parse({ schema_version: 1 })).toEqual(
      DEFAULT_PROBE_GATE_POLICY_V1,
    );
    expect(DEFAULT_PROBE_GATE_POLICY_V1).toMatchObject({
      enforcement: "report",
      blocking_severities: ["high"],
      accepted_dispositions: ["resolved", "waived", "invalidated"],
      require_destination_state: "applied",
      budgets: { quick: 8, standard: 20, deep: 40 },
    });
    expect(
      ProbeGatePolicyV1.safeParse({
        schema_version: 1,
        enforcement: "silent",
      }).success,
    ).toBe(false);
  });

  it("covers required gaps, due deferrals, expired waivers, and pending destinations", () => {
    const open = baseItem("pi_gate0001", "tech.data_model.v1");
    const deferred = {
      ...baseItem("pi_gate0002", "tech.interface_contract.v1"),
      state: "deferred" as const,
      deferral: {
        owner: "owner",
        revisit_trigger: "review",
        deferred_at_ms: 1,
        review_after_ms: 50,
      },
    };
    const waived = {
      ...baseItem("pi_gate0003", "tech.security_boundary.v1"),
      state: "waived" as const,
      waiver: {
        reason: "Temporary",
        approved_by: "owner",
        approved_at_ms: 1,
        expires_at_ms: 50,
      },
    };
    const resolved = {
      ...baseItem("pi_gate0004", "tech.user_flow.v1"),
      current_quadrant: "kk" as const,
      state: "resolved" as const,
      resolution: {
        answer: "Use the existing flow.",
        actor: { type: "human" as const, id: "owner" },
        resolved_at_ms: 2,
      },
      destination: {
        role: "technical_design" as const,
        path: "docs/design.md",
        write_state: "pending" as const,
      },
      compilation: { state: "not_eligible" as const },
    };
    const items = [open, deferred, waived, resolved];
    const result = evaluateProbeGate({
      session: session(items),
      items,
      events: [],
      policy: DEFAULT_PROBE_GATE_POLICY_V1,
      now_ms: 100,
    });

    expect(result.readiness).toMatchObject({
      deferred_due: 1,
      waived_expired: 1,
      resolved_destination_pending: 1,
      eligible: false,
    });
    expect(result.readiness.violations.map((violation) => violation.code)).toEqual(
      expect.arrayContaining([
        "open_required",
        "deferred_due",
        "expired_waiver",
        "destination_pending",
        "missing_required",
      ]),
    );
  });

  it("returns the same vector for session and portable inputs and detects stale attestations", () => {
    const resolved: ProbeItemV1 = {
      ...baseItem("pi_gate0001", "tech.data_model.v1"),
      current_quadrant: "kk",
      state: "resolved",
      resolution: {
        answer: "Use an append-only log.",
        actor: { type: "human", id: "owner" },
        resolved_at_ms: 2,
      },
      destination: {
        role: "technical_design",
        path: "docs/design.md",
        write_state: "applied",
        content_sha256: "a".repeat(64),
      },
      compilation: { state: "not_eligible" },
    };
    const activeSession = session([resolved]);
    const completedSession = { ...activeSession } as Record<string, unknown>;
    delete completedSession["current_question_id"];
    const currentSession = ProbeSessionV1.parse({
      ...completedSession,
      unselected_required_question_ids: [],
      state: "completed",
      completed_at_ms: 2,
    });
    const events: ProbeEventV1[] = [
      {
        schema_version: "1",
        event_id: "pe_gate0001",
        session_id: currentSession.session_id,
        revision: 1,
        type: "answer_recorded",
        actor: { type: "human", id: "owner" },
        idempotency_key: "answer",
        item_id: resolved.item_id,
        occurred_at_ms: 2,
        payload: {},
      },
    ];
    const input = {
      session: currentSession,
      items: [resolved],
      events,
      policy: DEFAULT_PROBE_GATE_POLICY_V1,
      now_ms: 100,
      destination_content: {
        "docs/design.md": { exists: true as const, sha256: "b".repeat(64) },
      },
    };
    const local = evaluateProbeGate(input);
    const portable = evaluateProbeGate({ ...input });

    expect(local.readiness).toEqual(portable.readiness);
    expect(local.readiness.violations).toEqual([
      expect.objectContaining({ code: "destination_stale" }),
    ]);
    expect(local.blocked).toBe(false);
    expect(
      evaluateProbeGate({
        ...input,
        policy: ProbeGatePolicyV1.parse({
          schema_version: 1,
          enforcement: "block",
        }),
      }).blocked,
    ).toBe(true);
  });
});
