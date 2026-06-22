import { describe, expect, it } from "vitest";
import { PIIRedactor, DEFAULT_PATTERNS } from "./redactor.js";

const r = new PIIRedactor();

describe("PIIRedactor.redact (default patterns)", () => {
  it("redacts an email", () => {
    const out = r.redact("contact me at jane.doe+test@example.co.uk please");
    expect(out.text).toBe("contact me at [REDACTED:email] please");
    expect(out.stats.counts.email).toBe(1);
    expect(out.stats.timed_out).toBe(false);
  });

  it("redacts an Anthropic key", () => {
    const out = r.redact("key sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa lives here");
    expect(out.text).toContain("[REDACTED:anthropic_key]");
    expect(out.stats.counts.anthropic_key).toBe(1);
  });

  it("redacts hyphenated sk-style tokens", () => {
    const out = r.redact("const api_key = \"sk-test-secret-token\";");
    expect(out.text).toBe("const api_key = \"[REDACTED:openai_key]\";");
    expect(out.stats.counts.openai_key).toBe(1);
  });

  it("redacts an AWS access key", () => {
    const out = r.redact("token AKIAABCDEFGHIJKLMNOP found");
    expect(out.text).toBe("token [REDACTED:aws_access_key] found");
    expect(out.stats.counts.aws_access_key).toBe(1);
  });

  it("redacts US SSN", () => {
    const out = r.redact("ssn 123-45-6789 reported");
    expect(out.text).toBe("ssn [REDACTED:ssn] reported");
    expect(out.stats.counts.ssn_us).toBe(1);
  });

  it("redacts IPv4 addresses", () => {
    const out = r.redact("client 192.168.1.5 connected");
    expect(out.text).toBe("client [REDACTED:ipv4] connected");
    expect(out.stats.counts.ipv4).toBe(1);
  });

  it("counts multiple hits of the same pattern", () => {
    const out = r.redact("a@x.io and b@y.org");
    expect(out.stats.counts.email).toBe(2);
  });

  it("leaves clean text untouched", () => {
    const input = "no secrets here, just business as usual";
    const out = r.redact(input);
    expect(out.text).toBe(input);
    expect(out.stats.counts).toEqual({});
    expect(out.stats.timed_out).toBe(false);
  });

  it("ships with at least the documented pattern set", () => {
    const ids = DEFAULT_PATTERNS.map((p) => p.id);
    for (const required of ["email", "phone_e164", "ssn_us", "ipv4", "anthropic_key", "openai_key", "aws_access_key"]) {
      expect(ids).toContain(required);
    }
  });
});

describe("PIIRedactor.redactDeep", () => {
  it("scrubs nested objects and arrays without touching non-strings", () => {
    const out = r.redactDeep({
      user: { email: "alice@example.com", id: 42 },
      ips: ["10.0.0.1", "10.0.0.2"],
      keep: true,
    });
    const v = out.value as { user: { email: string; id: number }; ips: string[]; keep: boolean };
    expect(v.user.email).toBe("[REDACTED:email]");
    expect(v.user.id).toBe(42);
    expect(v.ips).toEqual(["[REDACTED:ipv4]", "[REDACTED:ipv4]"]);
    expect(v.keep).toBe(true);
    expect(out.stats.counts.email).toBe(1);
    expect(out.stats.counts.ipv4).toBe(2);
  });
});

describe("PIIRedactor budget enforcement (CRITICAL GAP G2)", () => {
  it("reports timed_out when the budget is exceeded", () => {
    // Force a tiny budget; the loop checks between patterns, so any non-zero
    // input that triggers >1 pattern will trip the timeout on a 0ms budget.
    const tiny = new PIIRedactor({ budgetMs: 0 });
    const out = tiny.redact("alice@example.com and 10.0.0.1");
    expect(out.stats.timed_out).toBe(true);
    expect(typeof out.stats.timed_out_on === "string" || out.stats.timed_out_on === undefined).toBe(true);
  });
});
