import { describe, expect, it } from "vitest";
import {
  ProbeDynamicInputError,
  createRestatementQuestionBatch,
  materializeProbeQuestionBatch,
} from "./dynamic-input.js";
import type { ProbeItemV1 } from "./types.js";

const revision = "a".repeat(40);
const actor = { type: "agent" as const, id: "probe-skill" };
const evidence = {
  kind: "file" as const,
  ref: "docs/spec.md",
  sha256: "c".repeat(64),
};

function question(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1",
    question_id: `dynamic.${"b".repeat(64)}.v1`,
    item_kind: "risk",
    initial_quadrant: "uu",
    current_quadrant: "ku",
    doc_type: "tech",
    category: "migration",
    origin: "blindspot",
    prompt: "How will existing state be migrated?",
    options: [],
    impact: 3,
    irreversibility: 3,
    uncertainty: 3,
    required: true,
    evidence_refs: [evidence],
    destination_hint: "technical_design",
    ...overrides,
  };
}

function batch(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: "1",
    batch_id: "pqb_12345678",
    origin: "blindspot",
    generated_by: actor,
    source_revision: revision,
    questions: [question()],
    ...overrides,
  };
}

describe("probe dynamic inputs", () => {
  it("materializes verified questions and rejects duplicate questions", async () => {
    const verified = await materializeProbeQuestionBatch({
      batch: batch(),
      session_id: "probe_12345678",
      source_revision: revision,
      actor,
      existing_items: [],
      created_at_ms: 10,
      create_item_id: () => "pi_12345678",
      verify_evidence: async () => ({ verifiable: true }),
    });
    expect(verified.items[0]).toMatchObject({
      item_id: "pi_12345678",
      state: "open",
      origin: "blindspot",
      created_at_ms: 10,
    });

    await expect(
      materializeProbeQuestionBatch({
        batch: batch(),
        session_id: "probe_12345678",
        source_revision: revision,
        actor,
        existing_items: verified.items,
        created_at_ms: 11,
        create_item_id: () => "pi_87654321",
        verify_evidence: async () => ({ verifiable: true }),
      }),
    ).rejects.toThrow("duplicate dynamic question");
  });

  it("rejects stale authorship and evidence that cannot be verified", async () => {
    const base = {
      batch: batch(),
      session_id: "probe_12345678",
      source_revision: revision,
      actor,
      existing_items: [] as ProbeItemV1[],
      created_at_ms: 10,
      create_item_id: () => "pi_12345678",
    };
    await expect(
      materializeProbeQuestionBatch({
        ...base,
        source_revision: "d".repeat(40),
        verify_evidence: async () => ({ verifiable: true }),
      }),
    ).rejects.toBeInstanceOf(ProbeDynamicInputError);
    await expect(
      materializeProbeQuestionBatch({
        ...base,
        actor: { type: "agent", id: "different-agent" },
        verify_evidence: async () => ({ verifiable: true }),
      }),
    ).rejects.toBeInstanceOf(ProbeDynamicInputError);
    await expect(
      materializeProbeQuestionBatch({
        ...base,
        verify_evidence: async () => ({ verifiable: false }),
      }),
    ).rejects.toThrow("no verifiable evidence");
  });

  it("turns skill findings into questions without asserting semantic truth", () => {
    const finding = {
      schema_version: "1",
      finding_id: "prf_12345678",
      kind: "ambiguous",
      spec_evidence: {
        sha256: "d".repeat(64),
        path: "docs/spec.md",
        line: 3,
      },
      restatement_evidence: null,
      explanation: "The skill found language that needs owner confirmation.",
      proposed_question: "Which rollback guarantee should be preserved?",
      impact: 3,
      irreversibility: 3,
      uncertainty: 2,
      destination_hint: "technical_design",
    };
    const generated = createRestatementQuestionBatch({
      findings: [finding],
      generated_by: actor,
      source_revision: revision,
      evidence_refs: [[evidence]],
    });
    expect(generated).toMatchObject({
      origin: "restatement_diff",
      generated_by: actor,
      questions: [
        {
          origin: "restatement_diff",
          prompt: finding.proposed_question,
          required: true,
          evidence_refs: [evidence],
        },
      ],
    });
    expect(JSON.stringify(generated)).not.toContain("is wrong");
  });
});
