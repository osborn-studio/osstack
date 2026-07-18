import { describe, expect, it } from "vitest";
import {
  ALL_PROBE_QUESTION_PACKS_V1,
  CALIBRATION_QUESTION_PACK_V1,
  materializeProbeQuestions,
  PRODUCT_QUESTION_PACK_V1,
  ProbeQuestionPackV1,
  selectProbeQuestions,
  TECH_QUESTION_PACK_V1,
  TEST_QUESTION_PACK_V1,
} from "./question-pack.js";
import { ProbeItemV1 } from "./types.js";

describe("probe question packs", () => {
  it("freezes every accepted appendix A question id", () => {
    expect(
      CALIBRATION_QUESTION_PACK_V1.questions.map(
        (question) => question.question_id,
      ),
    ).toEqual([
      "cal.domain_familiarity.v1",
      "cal.repo_familiarity.v1",
      "cal.intent_maturity.v1",
    ]);
    expect(
      PRODUCT_QUESTION_PACK_V1.questions.map(
        (question) => question.question_id,
      ),
    ).toEqual([
      "product.primary_user.v1",
      "product.outcome_metric.v1",
      "product.non_goals.v1",
      "product.acceptance.v1",
      "product.rollout_rollback.v1",
      "product.compliance.v1",
    ]);
    expect(
      TECH_QUESTION_PACK_V1.questions.map(
        (question) => question.question_id,
      ),
    ).toEqual([
      "tech.data_model.v1",
      "tech.interface_contract.v1",
      "tech.user_flow.v1",
      "tech.failure_degradation.v1",
      "tech.scale_performance.v1",
      "tech.security_boundary.v1",
      "tech.dependencies.v1",
      "tech.migration_rollback.v1",
      "tech.observability.v1",
      "tech.alternatives.v1",
    ]);
    expect(
      TEST_QUESTION_PACK_V1.questions.map(
        (question) => question.question_id,
      ),
    ).toEqual([
      "test.acceptance_mapping.v1",
      "test.environment_differences.v1",
      "test.data_privacy.v1",
      "test.manual_only.v1",
      "test.failure_injection.v1",
      "test.performance_baseline.v1",
    ]);
    expect(ALL_PROBE_QUESTION_PACKS_V1).toHaveLength(4);
  });

  it("rejects duplicate ids, too many options, unknown categories, and missing hints", () => {
    const valid = TECH_QUESTION_PACK_V1;
    expect(ProbeQuestionPackV1.safeParse(valid).success).toBe(true);
    expect(
      ProbeQuestionPackV1.safeParse({
        ...valid,
        questions: [valid.questions[0], valid.questions[0]],
      }).success,
    ).toBe(false);
    expect(
      ProbeQuestionPackV1.safeParse({
        ...valid,
        questions: [
          {
            ...valid.questions[0],
            options: Array.from({ length: 5 }, (_, index) => ({
              option_id: `option-${index}`,
              label: `Option ${index}`,
              description: `Description ${index}`,
            })),
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      ProbeQuestionPackV1.safeParse({
        ...valid,
        questions: [{ ...valid.questions[0], category: "unknown" }],
      }).success,
    ).toBe(false);
    const { destination_hint: _hint, ...withoutHint } = valid.questions[0]!;
    expect(
      ProbeQuestionPackV1.safeParse({
        ...valid,
        questions: [withoutHint],
      }).success,
    ).toBe(false);
  });

  it("places missing familiarity calibration before static questions", () => {
    const selection = selectProbeQuestions({
      doc_types: ["tech"],
      depth: "quick",
      familiarity: { domain: "working" },
    });

    expect(selection.selected_questions.slice(0, 2).map((question) =>
      question.question_id)).toEqual([
      "cal.repo_familiarity.v1",
      "cal.intent_maturity.v1",
    ]);
    expect(selection.selected_questions).toHaveLength(8);
    expect(selection.question_budget).toBe(8);
    expect(selection.question_pack_refs).toEqual([
      { pack_id: "probe.calibration", version: "1" },
      { pack_id: "probe.tech", version: "1" },
    ]);
  });

  it("omits calibration when familiarity is complete", () => {
    const selection = selectProbeQuestions({
      doc_types: ["tech"],
      depth: "quick",
      familiarity: {
        domain: "expert",
        repository: "maintainer",
        intent: "review_ready",
      },
    });
    expect(
      selection.selected_questions.some((question) =>
        question.question_id.startsWith("cal.")),
    ).toBe(false);
  });

  it("never lets a low-risk optional question displace a high-risk required one", () => {
    const input = {
      doc_types: ["product", "tech", "test"] as const,
      depth: "quick" as const,
      familiarity: {
        domain: "expert" as const,
        repository: "maintainer" as const,
        intent: "review_ready" as const,
      },
    };
    const first = selectProbeQuestions(input);
    const second = selectProbeQuestions(input);

    expect(first).toEqual(second);
    expect(first.selected_questions).toHaveLength(8);
    const excludedHighRequired = first.unselected_required_question_ids.filter(
      (id) => {
        const question = ALL_PROBE_QUESTION_PACKS_V1.flatMap(
          (pack) => pack.questions,
        ).find((candidate) => candidate.question_id === id);
        return (
          question !== undefined &&
          question.impact * question.irreversibility >= 7
        );
      },
    );
    expect(excludedHighRequired).toEqual([]);
  });

  it("materializes strict session items without adding semantic randomness", () => {
    const selection = selectProbeQuestions({
      doc_types: ["tech"],
      depth: "quick",
      familiarity: {
        domain: "expert",
        repository: "maintainer",
        intent: "review_ready",
      },
    });
    let sequence = 0;
    const items = materializeProbeQuestions({
      session_id: "probe_12345678",
      questions: selection.selected_questions.slice(0, 2),
      created_at_ms: 10,
      create_item_id: () => `pi_1234567${++sequence}`,
    });

    expect(items).toHaveLength(2);
    expect(items.every((item) => ProbeItemV1.safeParse(item).success)).toBe(
      true,
    );
    expect(items.map((item) => item.item_id)).toEqual([
      "pi_12345671",
      "pi_12345672",
    ]);
    expect(items[0]).toMatchObject({
      session_id: "probe_12345678",
      source_pack: { pack_id: "probe.tech", version: "1" },
      state: "open",
      created_at_ms: 10,
      updated_at_ms: 10,
    });
  });
});
