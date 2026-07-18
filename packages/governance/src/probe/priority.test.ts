import { describe, expect, it } from "vitest";
import type { ProbeItemV1 } from "./types.js";
import {
  compareProbeItems,
  computeProbePriority,
  deriveProbeSeverity,
  sortProbeItems,
} from "./priority.js";

function openItem(overrides: Partial<ProbeItemV1> = {}): ProbeItemV1 {
  return {
    schema_version: "1",
    item_id: "pi_12345678",
    question_id: "tech.data_model.v1",
    session_id: "probe_12345678",
    item_kind: "question",
    initial_quadrant: "ku",
    current_quadrant: "ku",
    doc_type: "tech",
    category: "data_model",
    origin: "static_pack",
    prompt: "Which data model must be settled before implementation?",
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

describe("probe priority", () => {
  it("implements the accepted risk formula exactly", () => {
    expect(computeProbePriority(openItem())).toBe(938);
    expect(
      computeProbePriority(
        openItem({
          impact: 1,
          irreversibility: 1,
          uncertainty: 1,
          required: false,
          origin: "manual",
          current_quadrant: "kk",
        }),
      ),
    ).toBe(110);
  });

  it.each([
    [1, 1, "low"],
    [2, 2, "medium"],
    [3, 2, "medium"],
    [3, 3, "high"],
  ] as const)(
    "derives %s x %s risk as %s",
    (impact, irreversibility, severity) => {
      expect(
        deriveProbeSeverity(openItem({ impact, irreversibility })),
      ).toBe(severity);
    },
  );

  it("uses pack priority, pack order, then item id as stable tie-breakers", () => {
    const first = openItem({ item_id: "pi_aaaaaaaa" });
    const second = openItem({ item_id: "pi_bbbbbbbb" });

    expect(
      compareProbeItems(first, second, {
        pack_priority_by_id: { "probe.tech": 20 },
        pack_order_by_question_id: {
          "tech.data_model.v1": 5,
        },
      }),
    ).toBeLessThan(0);

    const sorted = sortProbeItems([second, first]);
    expect(sorted.map((item) => item.item_id)).toEqual([
      "pi_aaaaaaaa",
      "pi_bbbbbbbb",
    ]);
    expect([second, first].map((item) => item.item_id)).toEqual([
      "pi_bbbbbbbb",
      "pi_aaaaaaaa",
    ]);
  });

  it("keeps missing calibration ahead of higher-risk document questions", () => {
    const calibration = openItem({
      item_id: "pi_calibrat",
      question_id: "cal.domain_familiarity.v1",
      origin: "calibration",
      impact: 1,
      irreversibility: 1,
    });
    const documentQuestion = openItem({ item_id: "pi_document" });
    expect(sortProbeItems([documentQuestion, calibration])[0]?.item_id).toBe(
      calibration.item_id,
    );
  });
});
