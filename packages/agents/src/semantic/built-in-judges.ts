import type { SemanticJudgePort } from "@osstack/governance";
import { AnthropicNoToolsSemanticJudge } from "./anthropic-no-tools.js";
import {
  DeepSeekNoToolsSemanticJudge,
  QwenNoToolsSemanticJudge,
} from "./openai-compatible-no-tools.js";

export const BUILT_IN_SEMANTIC_JUDGE_IDS = [
  "anthropic-no-tools",
  "deepseek-no-tools",
  "qwen-no-tools",
] as const;

export type BuiltInSemanticJudgeId =
  typeof BUILT_IN_SEMANTIC_JUDGE_IDS[number];

export interface BuiltInSemanticJudgeFactoryOptions {
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
}

function requiredModel(
  environment: NodeJS.ProcessEnv,
  judgeId: BuiltInSemanticJudgeId,
  variable: string,
): string {
  const value = environment[variable];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`${judgeId} requires ${variable}`);
  }
  return value;
}

export function createBuiltInSemanticJudge(
  judgeId: string,
  options: BuiltInSemanticJudgeFactoryOptions = {},
): SemanticJudgePort {
  const environment = options.environment ?? process.env;
  if (judgeId === "anthropic-no-tools") {
    return new AnthropicNoToolsSemanticJudge({
      model_id: requiredModel(
        environment,
        judgeId,
        "OSSTACK_NEAT_ANTHROPIC_MODEL",
      ),
      environment,
    });
  }
  const httpOptions = (model_id: string) => ({
    model_id,
    environment,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (judgeId === "deepseek-no-tools") {
    return new DeepSeekNoToolsSemanticJudge(httpOptions(requiredModel(
      environment,
      judgeId,
      "OSSTACK_NEAT_DEEPSEEK_MODEL",
    )));
  }
  if (judgeId === "qwen-no-tools") {
    return new QwenNoToolsSemanticJudge(httpOptions(requiredModel(
      environment,
      judgeId,
      "OSSTACK_NEAT_QWEN_MODEL",
    )));
  }
  throw new Error(`unsupported semantic judge: ${judgeId}`);
}
