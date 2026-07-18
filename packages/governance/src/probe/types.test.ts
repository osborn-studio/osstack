import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ProbeEventV1,
  ProbeItemV1,
  ProbeLedgerV1,
  ProbeQuestionBatchV1,
  ProbeRestatementFindingV1,
  ProbeSessionV1,
} from "./types.js";

const fixturesDirectory = fileURLToPath(
  new URL("../../fixtures/probe", import.meta.url),
);

function fixture(path: string): unknown {
  return JSON.parse(readFileSync(`${fixturesDirectory}/${path}`, "utf8"));
}

describe("probe v1 domain contracts", () => {
  it("accepts the frozen portable ledger", () => {
    const ledger = fixture("valid/ledger-v1.valid.json");
    expect(ProbeLedgerV1.parse(ledger)).toEqual(ledger);
  });

  it("rejects the labelled invalid portable ledger", () => {
    expect(
      ProbeLedgerV1.safeParse(fixture("invalid/ledger-v1.invalid.json"))
        .success,
    ).toBe(false);
  });

  it("requires a destination for resolved items", () => {
    const ledger = ProbeLedgerV1.parse(
      fixture("valid/ledger-v1.valid.json"),
    );
    const openItem = ledger.items[0];
    expect(openItem).toBeDefined();

    const resolvedWithoutDestination = {
      ...openItem,
      state: "resolved",
      current_quadrant: "kk",
      resolution: {
        answer: "Use a repository-scoped SQLite projection.",
        actor: { type: "human", id: "owner" },
        resolved_at_ms: 2,
      },
      compilation: { state: "not_eligible" },
    };

    expect(ProbeItemV1.safeParse(resolvedWithoutDestination).success).toBe(
      false,
    );
  });

  it("rejects contradictory disposition fields", () => {
    const ledger = ProbeLedgerV1.parse(
      fixture("valid/ledger-v1.valid.json"),
    );
    const openItem = ledger.items[0];
    expect(openItem).toBeDefined();

    expect(
      ProbeItemV1.safeParse({
        ...openItem,
        state: "deferred",
        deferral: {
          owner: "owner",
          revisit_trigger: "Architecture review",
          deferred_at_ms: 2,
        },
        waiver: {
          reason: "Not applicable",
          approved_by: "owner",
          approved_at_ms: 2,
        },
      }).success,
    ).toBe(false);
  });

  it("requires finite positive session budgets", () => {
    const ledger = ProbeLedgerV1.parse(
      fixture("valid/ledger-v1.valid.json"),
    );
    expect(
      ProbeSessionV1.safeParse({ ...ledger.session, question_budget: 0 })
        .success,
    ).toBe(false);
    expect(
      ProbeSessionV1.safeParse({ ...ledger.session, question_budget: 101 })
        .success,
    ).toBe(false);
    expect(
      ProbeSessionV1.safeParse({
        ...ledger.session,
        question_budget: Number.POSITIVE_INFINITY,
      }).success,
    ).toBe(false);
  });

  it("keeps event, question-batch, and restatement objects strict", () => {
    const ledger = ProbeLedgerV1.parse(
      fixture("valid/ledger-v1.valid.json"),
    );
    const event = ledger.events[0];
    expect(event).toBeDefined();
    expect(ProbeEventV1.safeParse({ ...event, extra: true }).success).toBe(
      false,
    );

    expect(
      ProbeQuestionBatchV1.safeParse(
        fixture("valid/question-batch-v1.valid.json"),
      ).success,
    ).toBe(true);
    expect(
      ProbeRestatementFindingV1.safeParse(
        fixture("valid/restatement-finding-v1.valid.json"),
      ).success,
    ).toBe(true);
  });

  it("rejects external paths and evidence-free blind spots", () => {
    const batch = fixture("valid/question-batch-v1.valid.json") as {
      questions: Array<Record<string, unknown>>;
    };
    const question = batch.questions[0];
    expect(question).toBeDefined();

    expect(
      ProbeQuestionBatchV1.safeParse({
        ...batch,
        questions: [{ ...question, evidence_refs: [] }],
      }).success,
    ).toBe(false);
    expect(
      ProbeQuestionBatchV1.safeParse({
        ...batch,
        questions: [
          {
            ...question,
            evidence_refs: [{ kind: "file", ref: "/tmp/secret.txt" }],
          },
        ],
      }).success,
    ).toBe(false);
  });
});
