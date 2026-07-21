import { describe, expect, it } from "vitest";
import { inspectProductionSemanticProviders } from "./provider-readiness.js";

describe("production semantic provider readiness", () => {
  it.each([
    [
      "anthropic-no-tools",
      { ANTHROPIC_API_KEY: "secret-a", OSSTACK_NEAT_ANTHROPIC_MODEL: "claude-a" },
    ],
    [
      "deepseek-no-tools",
      { DEEPSEEK_API_KEY: "secret-b", OSSTACK_NEAT_DEEPSEEK_MODEL: "deepseek-v4-pro" },
    ],
    [
      "qwen-no-tools",
      { DASHSCOPE_API_KEY: "secret-c", OSSTACK_NEAT_QWEN_MODEL: "qwen3.7-plus" },
    ],
  ])("accepts a complete %s environment without disclosing values", (
    judgeId,
    environment,
  ) => {
    const result = inspectProductionSemanticProviders(environment);

    expect(result.passed).toBe(true);
    expect(result.ready_judge_ids).toEqual([judgeId]);
    expect(JSON.stringify(result)).not.toContain("secret-");
  });

  it("fails closed for partial provider configuration and names missing variables", () => {
    const result = inspectProductionSemanticProviders({
      DEEPSEEK_API_KEY: "secret-b",
      DASHSCOPE_API_KEY: "secret-c",
    });

    expect(result.passed).toBe(false);
    expect(result.ready_judge_ids).toEqual([]);
    expect(result.partially_configured).toEqual([
      {
        judge_id: "deepseek-no-tools",
        missing: ["OSSTACK_NEAT_DEEPSEEK_MODEL"],
      },
      {
        judge_id: "qwen-no-tools",
        missing: ["OSSTACK_NEAT_QWEN_MODEL"],
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("secret-");
  });
});
