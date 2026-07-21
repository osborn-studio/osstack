interface ProviderRequirement {
  judge_id: string;
  variables: readonly string[];
}

const requirements: readonly ProviderRequirement[] = [
  {
    judge_id: "anthropic-no-tools",
    variables: ["ANTHROPIC_API_KEY", "OSSTACK_NEAT_ANTHROPIC_MODEL"],
  },
  {
    judge_id: "deepseek-no-tools",
    variables: ["DEEPSEEK_API_KEY", "OSSTACK_NEAT_DEEPSEEK_MODEL"],
  },
  {
    judge_id: "qwen-no-tools",
    variables: ["DASHSCOPE_API_KEY", "OSSTACK_NEAT_QWEN_MODEL"],
  },
] as const;

export interface ProductionSemanticProviderReadiness {
  passed: boolean;
  ready_judge_ids: string[];
  partially_configured: Array<{
    judge_id: string;
    missing: string[];
  }>;
}

function present(environment: NodeJS.ProcessEnv, variable: string): boolean {
  const value = environment[variable];
  return value !== undefined && value.trim().length > 0;
}

export function inspectProductionSemanticProviders(
  environment: NodeJS.ProcessEnv = process.env,
): ProductionSemanticProviderReadiness {
  const readyJudgeIds: string[] = [];
  const partiallyConfigured: ProductionSemanticProviderReadiness[
    "partially_configured"
  ] = [];
  for (const requirement of requirements) {
    const configured = requirement.variables.filter((variable) =>
      present(environment, variable)
    );
    const missing = requirement.variables.filter((variable) =>
      !present(environment, variable)
    );
    if (missing.length === 0) {
      readyJudgeIds.push(requirement.judge_id);
    } else if (configured.length > 0) {
      partiallyConfigured.push({
        judge_id: requirement.judge_id,
        missing: [...missing],
      });
    }
  }
  return {
    passed: readyJudgeIds.length > 0,
    ready_judge_ids: readyJudgeIds,
    partially_configured: partiallyConfigured,
  };
}
