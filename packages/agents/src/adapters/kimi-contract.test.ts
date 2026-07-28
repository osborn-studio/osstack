import { describe, expect, it } from "vitest";
import {
  KimiReviewResult,
  fingerprintKimiFinding,
  parseKimiReviewResult,
} from "./kimi-contract.js";

function approvedReview() {
  return {
    schema_version: 1,
    review_id: "review_1",
    subject_run_id: "run_1_verify_1",
    reviewer: {
      adapter: "kimi-code",
      provider: "kimi",
      model: "k3-256k",
    },
    verdict: "approved",
    risk: "medium",
    markdown: "# Review\n\nNo blocking defects.",
    evaluation_judgments: [
      {
        id: "correctness",
        pass: true,
        severity: "error",
        summary: "Acceptance criteria pass.",
      },
    ],
    findings: [
      {
        rule_id: "correctness.authorization",
        severity: "warning",
        message: "Authorization behavior should remain covered.",
        file: "./src\\auth.ts",
        line: 12,
      },
    ],
    recommended_actions: ["Keep the authorization regression test."],
  };
}

describe("KimiReviewResult", () => {
  it("accepts a complete approved result and assigns finding fingerprints", () => {
    const parsed = parseKimiReviewResult(approvedReview());

    expect(parsed.verdict).toBe("approved");
    expect(parsed.findings[0]?.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["changes_requested", "blocked", "inconclusive"] as const)(
    "keeps %s distinct from approved",
    (verdict) => {
      const result = KimiReviewResult.safeParse({
        ...approvedReview(),
        verdict,
        findings: [],
      });

      expect(result.success).toBe(true);
      if (result.success) expect(result.data.verdict).toBe(verdict);
    },
  );

  it("rejects unknown result fields", () => {
    const result = KimiReviewResult.safeParse({
      ...approvedReview(),
      unexpected: "not allowed",
    });

    expect(result.success).toBe(false);
  });

  it("rejects a model-supplied fingerprint that does not match stable fields", () => {
    const review = approvedReview();

    expect(() => parseKimiReviewResult({
      ...review,
      findings: [{
        ...review.findings[0],
        fingerprint: "0".repeat(64),
      }],
    })).toThrow();
  });
});

describe("fingerprintKimiFinding", () => {
  it("normalizes path separators and leading dot segments", () => {
    expect(fingerprintKimiFinding({
      rule_id: "correctness.authorization",
      severity: "error",
      file: ".\\src\\auth.ts",
      line: 12,
    })).toBe(fingerprintKimiFinding({
      rule_id: "correctness.authorization",
      severity: "error",
      file: "src/auth.ts",
      line: 12,
    }));
  });

  it("does not include free-form model prose", () => {
    const finding = {
      rule_id: "correctness.authorization",
      severity: "error" as const,
      file: "src/auth.ts",
      line: 12,
    };

    expect(fingerprintKimiFinding({
      ...finding,
      message: "Authorization bypass.",
    })).toBe(fingerprintKimiFinding({
      ...finding,
      message: "The authorization behavior might be bypassed in another way.",
    }));
  });

  it("distinguishes different stable rule identifiers", () => {
    const finding = {
      severity: "error" as const,
      file: "src/auth.ts",
      line: 12,
    };

    expect(fingerprintKimiFinding({
      ...finding,
      rule_id: "correctness.authorization",
    })).not.toBe(fingerprintKimiFinding({
      ...finding,
      rule_id: "security.secret-exposure",
    }));
  });
});
