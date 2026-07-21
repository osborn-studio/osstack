import { describe, expect, it, vi } from "vitest";
import {
  BUILT_IN_SEMANTIC_JUDGE_IDS,
  createBuiltInSemanticJudge,
} from "./built-in-judges.js";

describe("built-in semantic judge registry", () => {
  it("creates every fixed no-tools provider from explicit environment configuration", () => {
    const environment = {
      ANTHROPIC_API_KEY: "anthropic-key",
      OSSTACK_NEAT_ANTHROPIC_MODEL: "claude-test",
      DEEPSEEK_API_KEY: "deepseek-key",
      OSSTACK_NEAT_DEEPSEEK_MODEL: "deepseek-v4-pro",
      DASHSCOPE_API_KEY: "qwen-key",
      OSSTACK_NEAT_QWEN_MODEL: "qwen3.7-plus",
    };
    const fetchMock = vi.fn<typeof fetch>();

    expect(BUILT_IN_SEMANTIC_JUDGE_IDS).toEqual([
      "anthropic-no-tools",
      "deepseek-no-tools",
      "qwen-no-tools",
    ]);
    expect(createBuiltInSemanticJudge("anthropic-no-tools", { environment }))
      .toMatchObject({ id: "anthropic-no-tools", model_id: "claude-test" });
    expect(createBuiltInSemanticJudge("deepseek-no-tools", {
      environment,
      fetch: fetchMock,
    })).toMatchObject({ id: "deepseek-no-tools", model_id: "deepseek-v4-pro" });
    expect(createBuiltInSemanticJudge("qwen-no-tools", {
      environment,
      fetch: fetchMock,
    })).toMatchObject({ id: "qwen-no-tools", model_id: "qwen3.7-plus" });
  });

  it("rejects unknown judges and missing model configuration before invocation", () => {
    expect(() => createBuiltInSemanticJudge("agent-with-tools", {
      environment: {},
    })).toThrow(/unsupported semantic judge/);
    expect(() => createBuiltInSemanticJudge("deepseek-no-tools", {
      environment: { DEEPSEEK_API_KEY: "key" },
    })).toThrow(/OSSTACK_NEAT_DEEPSEEK_MODEL/);
    expect(() => createBuiltInSemanticJudge("qwen-no-tools", {
      environment: { DASHSCOPE_API_KEY: "key" },
    })).toThrow(/OSSTACK_NEAT_QWEN_MODEL/);
  });
});
