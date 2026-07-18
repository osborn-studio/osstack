import { describe, expect, it } from "vitest";
import type {
  ProbeActorV1,
  ProbeItemV1,
} from "./types.js";
import { ProbeSessionV1 } from "./types.js";
import {
  applyProbeMutation,
  deriveProbeReadiness,
  hasProbeDiminishingReturns,
  getCurrentProbeItem,
  ProbeReducerError,
  type ProbeDomainStateV1,
} from "./reducer.js";

const human: ProbeActorV1 = { type: "human", id: "owner" };
const agent: ProbeActorV1 = { type: "agent", id: "codex" };

function openItem(
  id: string,
  questionId: string,
  overrides: Partial<ProbeItemV1> = {},
): ProbeItemV1 {
  return {
    schema_version: "1",
    item_id: id,
    question_id: questionId,
    session_id: "probe_12345678",
    item_kind: "question",
    initial_quadrant: "ku",
    current_quadrant: "ku",
    doc_type: "tech",
    category: "data_model",
    origin: "static_pack",
    prompt: `Question ${questionId}`,
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

function activeSession(overrides: Partial<ProbeSessionV1> = {}): ProbeSessionV1 {
  return {
    schema_version: "1",
    session_id: "probe_12345678",
    repo_id: "osstack",
    worktree_state: "clean",
    input_refs: [],
    doc_types: ["tech"],
    question_pack_refs: [{ pack_id: "probe.tech", version: "1" }],
    selected_question_ids: ["tech.data_model.v1"],
    unselected_required_question_ids: [],
    depth: "quick",
    question_budget: 8,
    questions_presented: 1,
    revision: 1,
    created_at_ms: 1,
    updated_at_ms: 1,
    state: "active",
    current_question_id: "pi_12345678",
    ...overrides,
  } as ProbeSessionV1;
}

function state(
  session: ProbeSessionV1 = activeSession(),
  items: readonly ProbeItemV1[] = [
    openItem("pi_12345678", "tech.data_model.v1"),
  ],
): ProbeDomainStateV1 {
  return { session, items };
}

function metadata(ifRevision = 1, actor: ProbeActorV1 = human) {
  return {
    if_revision: ifRevision,
    actor,
    idempotency_key: `mutation-${ifRevision}`,
    event_id: `pe_1234567${ifRevision}`,
    occurred_at_ms: ifRevision + 1,
  } as const;
}

function expectReducerError(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected reducer error");
  } catch (error) {
    expect(error).toBeInstanceOf(ProbeReducerError);
    expect((error as ProbeReducerError).code).toBe(code);
  }
}

describe("probe reducer", () => {
  it("keeps reads stable and does not present a question twice", () => {
    const current = state();
    expect(getCurrentProbeItem(current)?.item_id).toBe("pi_12345678");
    expect(getCurrentProbeItem(current)?.item_id).toBe("pi_12345678");
    expect(current.session.questions_presented).toBe(1);
    expect(current.session.revision).toBe(1);
  });

  it("resolves the current item and completes when obligations are clear", () => {
    const result = applyProbeMutation(state(), {
      type: "resolve",
      item_id: "pi_12345678",
      answer: "Persist snapshots and events in the same transaction.",
      destination: {
        role: "technical_design",
        path: "docs/technical-design.md",
        write_state: "pending",
      },
      compilation: { state: "not_eligible" },
      ...metadata(),
    });

    expect(result.session.state).toBe("completed");
    expect(ProbeSessionV1.safeParse(result.session).success).toBe(true);
    expect(result.session.revision).toBe(2);
    expect(result.items[0]).toMatchObject({
      state: "resolved",
      current_quadrant: "kk",
    });
    expect(result.event).toMatchObject({
      type: "answer_recorded",
      revision: 2,
      item_id: "pi_12345678",
      payload: {
        metric_facts: {
          answer_effective: true,
          destination_state: "pending",
        },
      },
    });
  });

  it("writes calibration answers into a partial familiarity profile", () => {
    const calibration = openItem(
      "pi_12345678",
      "cal.domain_familiarity.v1",
      {
        origin: "calibration",
        category: "tacit_convention",
        destination_hint: "session_profile",
        options: [
          {
            option_id: "working",
            label: "Working",
            description: "Working familiarity",
          },
        ],
        impact: 1,
        irreversibility: 1,
      },
    );
    const result = applyProbeMutation(state(activeSession(), [calibration]), {
      type: "resolve",
      item_id: calibration.item_id,
      answer: "working",
      selected_option_id: "working",
      destination: {
        role: "session_profile",
        profile_key: "domain",
        write_state: "verified",
      },
      compilation: { state: "not_eligible" },
      ...metadata(),
    });

    expect(result.session.familiarity).toEqual({ domain: "working" });
  });

  it("pauses at budget instead of completing and resumes the same next item", () => {
    const first = openItem("pi_12345678", "tech.data_model.v1");
    const second = openItem("pi_87654321", "tech.interface_contract.v1", {
      category: "interface",
    });
    const initial = state(
      activeSession({
        selected_question_ids: [
          "tech.data_model.v1",
          "tech.interface_contract.v1",
        ],
        question_budget: 1,
      }),
      [first, second],
    );

    const paused = applyProbeMutation(initial, {
      type: "resolve",
      item_id: first.item_id,
      answer: "Use the existing state database.",
      destination: {
        role: "technical_design",
        path: "docs/technical-design.md",
        write_state: "pending",
      },
      compilation: { state: "not_eligible" },
      ...metadata(),
    });
    expect(paused.session).toMatchObject({
      state: "paused",
      pause_reason: "budget",
      current_question_id: second.item_id,
      revision: 2,
    });

    const resumed = applyProbeMutation(paused, {
      type: "resume",
      extend_budget: 1,
      revisit_item_ids: [],
      ...metadata(2),
    });
    expect(resumed.session).toMatchObject({
      state: "active",
      current_question_id: second.item_id,
      question_budget: 2,
      questions_presented: 2,
      revision: 3,
    });
    expect(ProbeSessionV1.safeParse(resumed.session).success).toBe(true);
  });

  it("materializes a finite extension before resuming an exhausted queue", () => {
    const initial = state(
      activeSession({
        question_budget: 1,
        unselected_required_question_ids: [
          "tech.interface_contract.v1",
        ],
      }),
    );
    const paused = applyProbeMutation(initial, {
      type: "resolve",
      item_id: "pi_12345678",
      answer: "Use the core state database.",
      destination: {
        role: "technical_design",
        path: "docs/technical-design.md",
        write_state: "pending",
      },
      compilation: { state: "not_eligible" },
      ...metadata(),
    });
    expect(paused.session).toMatchObject({
      state: "paused",
      pause_reason: "budget",
    });

    const added = openItem(
      "pi_87654321",
      "tech.interface_contract.v1",
      { category: "interface", created_at_ms: 3, updated_at_ms: 3 },
    );
    const resumed = applyProbeMutation(paused, {
      type: "resume",
      extend_budget: 1,
      revisit_item_ids: [],
      added_items: [added],
      unselected_required_question_ids: [],
      ...metadata(2),
    });
    expect(resumed.session).toMatchObject({
      state: "active",
      current_question_id: added.item_id,
      question_budget: 2,
      questions_presented: 2,
      selected_question_ids: [
        "tech.data_model.v1",
        "tech.interface_contract.v1",
      ],
      unselected_required_question_ids: [],
    });
    expect(resumed.items).toHaveLength(2);
  });

  it("atomically adds dynamic items without advancing the current question", () => {
    const dynamic = openItem(
      "pi_87654321",
      `dynamic.${"b".repeat(64)}.v1`,
      {
        origin: "blindspot",
        initial_quadrant: "uu",
        current_quadrant: "ku",
        evidence_refs: [
          {
            kind: "file",
            ref: "packages/core/src/state/migrations.ts",
            sha256: "c".repeat(64),
          },
        ],
      },
    );
    const result = applyProbeMutation(state(), {
      type: "add",
      items: [dynamic],
      batch_id: "pqb_12345678",
      origin: "blindspot",
      source_revision: "a".repeat(40),
      ...metadata(1, agent),
    });

    expect(result.session).toMatchObject({
      revision: 2,
      current_question_id: "pi_12345678",
      questions_presented: 1,
      selected_question_ids: [
        "tech.data_model.v1",
        dynamic.question_id,
      ],
    });
    expect(result.items).toHaveLength(2);
    expect(result.event).toMatchObject({
      type: "items_added",
      revision: 2,
      actor: agent,
      payload: {
        batch_id: "pqb_12345678",
        item_ids: [dynamic.item_id],
        origin: "blindspot",
        question_ids: [dynamic.question_id],
        source_revision: "a".repeat(40),
        metric_facts: {
          item_facts: [{
            item_id: dynamic.item_id,
            required: true,
            severity: "high",
            impact: 3,
            origin: "blindspot",
          }],
        },
      },
    });
  });

  it("rejects duplicate, foreign, and non-open dynamic items", () => {
    const valid = openItem(
      "pi_87654321",
      `dynamic.${"b".repeat(64)}.v1`,
      { origin: "blindspot" },
    );
    for (const item of [
      { ...valid, question_id: "tech.data_model.v1" },
      { ...valid, item_id: "pi_12345678" },
      { ...valid, session_id: "probe_87654321" },
      {
        ...valid,
        state: "deferred" as const,
        deferral: {
          owner: "owner",
          revisit_trigger: "later",
          deferred_at_ms: 1,
        },
      },
    ]) {
      expectReducerError(
        () =>
          applyProbeMutation(state(), {
            type: "add",
            items: [item as ProbeItemV1],
            batch_id: "pqb_12345678",
            origin: "blindspot",
            source_revision: "a".repeat(40),
            ...metadata(1, agent),
          }),
        "invalid_item",
      );
    }
  });

  it("only permits diminishing-return pauses after a qualifying five-item window", () => {
    const lowInformationWindow = Array.from({ length: 5 }, () => ({
      low_information: true,
      followup_generated: false,
      destination_changed: false,
    }));
    const lowRiskItem = openItem(
      "pi_12345678",
      "tech.scale_performance.v1",
      {
        required: false,
        impact: 1,
        irreversibility: 1,
      },
    );
    const current = state(activeSession(), [lowRiskItem]);

    expect(hasProbeDiminishingReturns(current, lowInformationWindow)).toBe(
      true,
    );
    expect(
      hasProbeDiminishingReturns(state(), lowInformationWindow),
    ).toBe(false);
    expect(
      hasProbeDiminishingReturns(current, [
        ...lowInformationWindow.slice(0, 4),
        {
          low_information: true,
          followup_generated: true,
          destination_changed: false,
        },
      ]),
    ).toBe(false);

    const paused = applyProbeMutation(current, {
      type: "pause_diminishing_returns",
      recent_outcomes: lowInformationWindow,
      ...metadata(),
    });
    expect(paused.session).toMatchObject({
      state: "paused",
      pause_reason: "diminishing_returns",
    });
  });

  it("reopens an explicitly revisited deferred item", () => {
    const deferred = applyProbeMutation(state(), {
      type: "defer",
      item_id: "pi_12345678",
      owner: "owner",
      revisit_trigger: "Migration design review",
      ...metadata(),
    });
    expect(deferred.session.state).toBe("paused");
    expect(deferred.items[0]?.state).toBe("deferred");

    const resumed = applyProbeMutation(deferred, {
      type: "resume",
      revisit_item_ids: ["pi_12345678"],
      ...metadata(2),
    });
    expect(resumed.session).toMatchObject({
      state: "active",
      current_question_id: "pi_12345678",
    });
    expect(resumed.items[0]?.state).toBe("open");
  });

  it("rejects stale revisions, wrong questions, and mutations after completion", () => {
    const resolve = {
      type: "resolve" as const,
      item_id: "pi_12345678",
      answer: "Answer",
      destination: {
        role: "technical_design" as const,
        path: "docs/technical-design.md",
        write_state: "pending" as const,
      },
      compilation: { state: "not_eligible" as const },
      ...metadata(),
    };
    expectReducerError(
      () => applyProbeMutation(state(), { ...resolve, if_revision: 0 }),
      "conflict",
    );
    expectReducerError(
      () =>
        applyProbeMutation(state(), { ...resolve, item_id: "pi_87654321" }),
      "conflict",
    );

    const completed = applyProbeMutation(state(), resolve);
    expectReducerError(
      () =>
        applyProbeMutation(completed, {
          type: "pause",
          reason: "Too late",
          ...metadata(2),
        }),
      "invalid_transition",
    );
  });

  it("requires human authority for waivers, abandonment, and required invalidation", () => {
    expectReducerError(
      () =>
        applyProbeMutation(state(), {
          type: "waive",
          item_id: "pi_12345678",
          reason: "Not applicable",
          ...metadata(1, agent),
        }),
      "authority_required",
    );
    expectReducerError(
      () =>
        applyProbeMutation(state(), {
          type: "invalidate",
          item_id: "pi_12345678",
          reason: "Bad question",
          ...metadata(1, agent),
        }),
      "authority_required",
    );
    expectReducerError(
      () =>
        applyProbeMutation(state(), {
          type: "abandon",
          reason: "Cancelled",
          ...metadata(1, agent),
        }),
      "authority_required",
    );
  });

  it("requires human authority for architecture-changing answer categories", () => {
    expectReducerError(
      () =>
        applyProbeMutation(state(), {
          type: "resolve",
          item_id: "pi_12345678",
          answer: "Persist the decision.",
          destination: {
            role: "technical_design",
            path: "docs/technical-design.md",
            write_state: "pending",
          },
          compilation: { state: "not_eligible" },
          ...metadata(1, agent),
        }),
      "authority_required",
    );
  });

  it("records agent compilation on resolved items, including completed sessions", () => {
    const completed = applyProbeMutation(state(), {
      type: "resolve",
      item_id: "pi_12345678",
      answer: "Run the registered package test.",
      destination: {
        role: "evaluation_spec",
        path: "docs/probe/evaluation-spec-delta.json",
        write_state: "pending",
      },
      compilation: { state: "not_eligible" },
      ...metadata(),
    });
    const compiled = applyProbeMutation(completed, {
      type: "compile",
      compilations: [
        {
          item_id: "pi_12345678",
          compilation: {
            state: "compiled",
            spec_ref: "docs/probe/evaluation-spec-delta.json",
            template_id: "package-script.v1",
          },
        },
      ],
      ...metadata(2, agent),
    });
    expect(compiled.session).toMatchObject({ state: "completed", revision: 3 });
    expect(compiled.items[0]).toMatchObject({
      state: "resolved",
      compilation: {
        state: "compiled",
        template_id: "package-script.v1",
      },
    });
    expect(compiled.event).toMatchObject({
      type: "items_compiled",
      revision: 3,
    });
  });

  it("abandons active and paused sessions without leaking state-only fields", () => {
    const activeAbandoned = applyProbeMutation(state(), {
      type: "abandon",
      reason: "Cancelled",
      ...metadata(),
    });
    expect(ProbeSessionV1.safeParse(activeAbandoned.session).success).toBe(
      true,
    );

    const paused = applyProbeMutation(state(), {
      type: "pause",
      reason: "Review later",
      ...metadata(),
    });
    const pausedAbandoned = applyProbeMutation(paused, {
      type: "abandon",
      reason: "Superseded",
      ...metadata(2),
    });
    expect(ProbeSessionV1.safeParse(pausedAbandoned.session).success).toBe(
      true,
    );
  });

  it("derives an explainable readiness vector without a composite score", () => {
    const now = 100;
    const items: ProbeItemV1[] = [
      openItem("pi_12345678", "tech.data_model.v1"),
      {
        ...openItem("pi_87654321", "tech.interface_contract.v1", {
          required: false,
          impact: 2,
          irreversibility: 2,
        }),
        state: "waived",
        waiver: {
          reason: "Superseded by an existing contract.",
          approved_by: "owner",
          approved_at_ms: 1,
          expires_at_ms: 50,
        },
      },
      {
        ...openItem("pi_abcdefgh", "tech.security_boundary.v1"),
        state: "resolved",
        current_quadrant: "kk",
        resolution: {
          answer: "Use repository containment checks.",
          actor: human,
          resolved_at_ms: 2,
        },
        destination: {
          role: "technical_design",
          path: "docs/technical-design.md",
          write_state: "pending",
        },
        compilation: { state: "manual_required", reason: "Human review" },
      },
    ];
    const session = activeSession({
      selected_question_ids: items.map((item) => item.question_id),
      unselected_required_question_ids: ["tech.migration_rollback.v1"],
    });

    expect(deriveProbeReadiness({ session, items }, now)).toEqual({
      required_total: 3,
      required_disposed: 1,
      open_by_severity: { high: 1, medium: 0, low: 0 },
      deferred_due: 0,
      waived_active: 0,
      waived_expired: 1,
      resolved_destination_pending: 1,
      resolved_destination_applied: 0,
      compilation_manual_required: 1,
      completion_percent: 33.33,
      eligible: false,
      violations: expect.arrayContaining([
        expect.objectContaining({ code: "open_required" }),
        expect.objectContaining({ code: "expired_waiver" }),
        expect.objectContaining({ code: "destination_pending" }),
        expect.objectContaining({ code: "missing_required" }),
      ]),
    });
  });
});
