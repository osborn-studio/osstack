import { describe, expect, it } from "vitest";
import {
  createKnowledgeHygieneFingerprint,
  KnowledgeHygieneFindingV1,
  loadKnowledgeHygieneConfig,
  ProbeLedgerV1,
  scanFiles,
  scanText,
} from "./index.js";

describe("governance public API", () => {
  it("keeps scanner exports and publishes knowledge hygiene contracts", () => {
    expect(scanFiles).toBeTypeOf("function");
    expect(scanText).toBeTypeOf("function");
    expect(loadKnowledgeHygieneConfig).toBeTypeOf("function");
    expect(createKnowledgeHygieneFingerprint).toBeTypeOf("function");
    expect(KnowledgeHygieneFindingV1.safeParse({}).success).toBe(false);
    expect(ProbeLedgerV1.safeParse({}).success).toBe(false);
  });
});
