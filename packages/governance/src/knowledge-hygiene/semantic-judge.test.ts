import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  SemanticJudgeError,
  SemanticJudgeRequestV1,
  invokeSemanticJudge,
  type SemanticJudgePort,
} from "./semantic-judge.js";
import { SemanticProviderError } from "./semantic-provider-error.js";

const sha = "a".repeat(64);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function request() {
  const outputSchema = { type: "object" };
  const outputSchemaSha = digest(JSON.stringify(outputSchema));
  const packBase = {
    pack_id: `khep_${sha}`,
    dimension: "narrative",
    source_units_total: 1,
    candidate_generator: { id: "u0-signals", version: "1" },
    sources: [{
      source: { kind: "repository", repo_id: "repo-1", path: "AGENTS.md" },
      blob_sha256: sha,
      excerpts: [{ start_line: 1, end_line: 1, text: "Durable rule." }],
    }],
    candidates: [{ candidate_id: "candidate-1", source_indexes: [0] }],
    redaction_count: 0,
    prompt_version: "1",
    output_schema_sha256: outputSchemaSha,
    budget: { max_input_tokens: 100, max_output_tokens: 100, max_calls: 1 },
  } as const;
  return SemanticJudgeRequestV1.parse({
    run_id: "run-1",
    nonce: `khn_${sha}`,
    evidence_pack: {
      ...packBase,
      pack_sha256: digest(JSON.stringify(packBase)),
    },
    output_schema: outputSchema,
    output_schema_sha256: outputSchemaSha,
    budget: { max_input_tokens: 100, max_output_tokens: 100, max_calls: 1 },
  });
}

function decision() {
  return {
    dimension: "narrative",
    verdict: "issue",
    confidence: "high",
    citations: [{
      source: { kind: "repository", repo_id: "repo-1", path: "AGENTS.md" },
      blob_sha256: sha,
      start_line: 1,
      end_line: 1,
      text_sha256: digest("Durable rule."),
      excerpt: "Durable rule.",
    }],
    rationale: "This is narrative rather than instruction.",
    proposed_disposition: "review",
    closure_conditions: [],
  } as const;
}

function port(
  response: Partial<Awaited<ReturnType<SemanticJudgePort["judge"]>>> = {},
): SemanticJudgePort {
  return {
    id: "fake-no-tools",
    model_id: "fake-model",
    prompt_version: "1",
    supports_no_tools: true,
    async judge(input) {
      return {
        nonce: input.nonce,
        raw_output: decision(),
        usage: { input_tokens: 10, output_tokens: 10, calls: 1 },
        ...response,
      };
    },
  };
}

describe("SemanticJudgePort gate", () => {
  it("accepts one strict, nonce-bound, in-budget decision", async () => {
    await expect(invokeSemanticJudge(port(), request(), new AbortController().signal))
      .resolves.toMatchObject({ decision: decision() });
  });

  it.each([
    ["stale nonce", { nonce: `khn_${"b".repeat(64)}` }],
    ["over budget", { usage: { input_tokens: 101, output_tokens: 10, calls: 1 } }],
    ["malformed output", { raw_output: { verdict: "issue" } }],
  ])("fails closed for %s", async (_label, response) => {
    await expect(invokeSemanticJudge(
      port(response),
      request(),
      new AbortController().signal,
    )).rejects.toBeInstanceOf(SemanticJudgeError);
  });

  it("propagates cancellation and never retries the provider", async () => {
    let calls = 0;
    const controller = new AbortController();
    controller.abort();
    const fake = port();
    fake.judge = async () => {
      calls += 1;
      throw new Error("must not run");
    };
    await expect(invokeSemanticJudge(fake, request(), controller.signal))
      .rejects.toMatchObject({ code: "cancelled" });
    expect(calls).toBe(0);
  });

  it("preserves a typed provider code without preserving provider text", async () => {
    const fake = port();
    fake.judge = async () => {
      throw new SemanticProviderError("request_timeout");
    };

    await expect(invokeSemanticJudge(
      fake,
      request(),
      new AbortController().signal,
    )).rejects.toMatchObject({
      code: "provider_error",
      provider_failure_code: "request_timeout",
      message: "semantic judge provider failed: request_timeout",
    });
  });

  it("maps arbitrary provider exceptions to a non-disclosing fallback code", async () => {
    const fake = port();
    fake.judge = async () => {
      throw new Error("transport leaked secret-sentinel");
    };

    const error = await invokeSemanticJudge(
      fake,
      request(),
      new AbortController().signal,
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: "provider_error",
      provider_failure_code: "unknown_provider_error",
      message: "semantic judge provider failed: unknown_provider_error",
    });
    expect((error as Error).message).not.toContain("secret-sentinel");
  });
});
