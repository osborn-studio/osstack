import { createRequire } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { buildAgentChildEnv, CodexCliAdapter, KimiCodeAdapter, type AgentAdapter } from "@osstack/agents";

export interface ImprovementExecutionAdapterOptions {
  workspacePath: string;
  /** Dedicated OSStack home for this execution, not the serving control plane. */
  homePath: string;
  builderAgentId: string;
  evaluatorAgentId: string;
}

/**
 * No arguments creates a routing/probe registry that cannot execute tasks.
 * Bound adapters run an explicitly authorized local candidate in a trusted repo.
 * This factory does not grant signed-phase, GitHub or operating-system authority.
 */
export function createImprovementExecutionAdapters(options?: ImprovementExecutionAdapterOptions): AgentAdapter[] {
  if (options !== undefined) {
    if (options.builderAgentId !== "codex-cli" || options.evaluatorAgentId !== "kimi-code") {
      throw new Error("Candidate execution supports codex-cli Builder and kimi-code Evaluator only");
    }
    if (!isAbsolute(options.workspacePath) || !isAbsolute(options.homePath)
      || options.workspacePath.includes("\0") || options.homePath.includes("\0")) {
      throw new Error("Candidate workspace and execution home must be absolute paths");
    }
  }
  // Retain login discovery and normal transport settings, never ambient OSStack
  // approval/notification secrets. Each adapter snapshots this replacement env.
  const env = buildAgentChildEnv({
    OSSTACK_AUTOAPPROVE: "0",
    ...(options === undefined ? {} : { OSSTACK_HOME: options.homePath }),
  });
  const codexEnv = { ...env };
  for (const name of ["CODEX_HOME", "OPENAI_API_KEY"] as const) {
    if (process.env[name] !== undefined) codexEnv[name] = process.env[name];
  }
  const builder = new CodexCliAdapter({
    bin: process.env["OSSTACK_CODEX_BIN"] ?? "codex",
    sandbox: options === undefined ? "read-only" : "workspace-write",
    strictCompletion: true,
    env: codexEnv,
    ...(options === undefined ? {} : { cwd: options.workspacePath }),
  });
  const reviewer = new KimiCodeAdapter({
    bin: process.env["OSSTACK_KIMI_BIN"] ?? "kimi",
    // An ambient agent-file override could replace the tool-free profile.
    reviewAgentFile: join(dirname(createRequire(import.meta.url).resolve("@osstack/agents")), "adapters/kimi-review-agent.md"),
    model: process.env["OSSTACK_KIMI_MODEL"] ?? "kimi-code/k3",
    provider: process.env["OSSTACK_KIMI_PROVIDER"] ?? "kimi",
    env,
  });
  return [builder, reviewer].map((adapter) => boundAdapter(adapter, options?.workspacePath));
}

function boundAdapter(adapter: AgentAdapter, workspacePath?: string): AgentAdapter {
  return {
    id: adapter.id,
    display_name: adapter.display_name,
    cost_tier: adapter.cost_tier,
    capabilities: () => adapter.capabilities(),
    isAvailable: () => adapter.isAvailable(),
    ...(adapter.runtimeIdentity === undefined ? {} : { runtimeIdentity: () => adapter.runtimeIdentity!() }),
    async *invoke(task, signal) {
      if (workspacePath === undefined) throw new Error("Candidate preflight adapter must be bound to an execution workspace before invoking");
      const requestedPath = task.context?.["repo_path"];
      if (requestedPath !== undefined && (typeof requestedPath !== "string" || resolve(requestedPath) !== resolve(workspacePath))) {
        throw new Error("Candidate task attempted to use a different execution workspace");
      }
      yield* adapter.invoke({ ...task, context: { ...task.context, repo_path: workspacePath } }, signal);
    },
  };
}
