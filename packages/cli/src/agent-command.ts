import {
  agentAuthMode,
  defaultAdapters,
  rolesForCapabilityKinds,
  type AgentRuntimeIdentity,
} from "@osstack/agents";
import { getAgentScorecard, listAgentScorecards } from "@osstack/core";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";

interface AgentCommandRpcResponse {
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

export interface LocalAgentProfile {
  id: string;
  display_name: string;
  cost_tier: string;
  auth_mode: string;
  roles: string[];
  capabilities: Array<{
    id: string;
    kind: string;
    description: string;
    cost_tier: string;
  }>;
  available: {
    available: boolean;
    reason?: string;
    last_checked_at: number;
  };
  runtime_identity?: AgentRuntimeIdentity;
}

export interface AgentCommandDeps {
  rpc: (method: string, params?: unknown) => Promise<unknown>;
  stateDbPath: () => Promise<string>;
  listProfiles?: () => Promise<LocalAgentProfile[]>;
  stdout?: (line: string) => void;
  stderr?: (line: string, detail?: string) => void;
}

export async function listLocalAgentProfiles(): Promise<LocalAgentProfile[]> {
  return await Promise.all(defaultAdapters().map(async (adapter) => {
    const capabilities = adapter.capabilities();
    const available = await adapter.isAvailable();
    let runtimeIdentity: AgentRuntimeIdentity | undefined;
    if (adapter.runtimeIdentity !== undefined) {
      try {
        runtimeIdentity = await adapter.runtimeIdentity();
      } catch {
        runtimeIdentity = undefined;
      }
    }
    return {
      id: adapter.id,
      display_name: adapter.display_name,
      cost_tier: adapter.cost_tier,
      auth_mode: agentAuthMode(adapter.id),
      roles: rolesForCapabilityKinds(capabilities.map((capability) => capability.kind)),
      capabilities: capabilities.map((capability) => ({
        id: capability.id,
        kind: capability.kind,
        description: capability.description,
        cost_tier: capability.cost_tier,
      })),
      available,
      ...(runtimeIdentity !== undefined
        ? { runtime_identity: runtimeIdentity }
        : {}),
    };
  }));
}

function printAgentScorecard(
  scorecard: ReturnType<typeof getAgentScorecard>,
  stdout: (line: string) => void,
): void {
  stdout(`${scorecard.agent_id}`);
  stdout(`  runs=${scorecard.total_runs} completed=${scorecard.completed_runs} failed=${scorecard.failed_runs} success=${Math.round(scorecard.success_rate * 100)}%`);
  stdout(`  avg_duration_ms=${scorecard.avg_duration_ms ?? "unknown"} cost_tier=${scorecard.cost_tier} fit=${scorecard.capability_fit}`);
  const adapter = defaultAdapters().find((candidate) => candidate.id === scorecard.agent_id);
  const scorecardKinds = scorecard.best_task_kinds.map((kind) => kind.kind);
  const roles = rolesForCapabilityKinds(adapter?.capabilities().map((capability) => capability.kind) ?? scorecardKinds);
  if (roles.length > 0) stdout(`  roles=${roles.join(",")}`);
  stdout(`  recent_failures=${scorecard.recent_failures}`);
  if (scorecard.best_task_kinds.length > 0) {
    stdout(`  best_task_kinds=${scorecard.best_task_kinds.map((kind) => `${kind.kind}:${Math.round(kind.success_rate * 100)}%`).join(", ")}`);
  }
  if (scorecard.warnings.length > 0) {
    stdout(`  warnings=${scorecard.warnings.join("; ")}`);
  }
}

export async function handleAgentCommand(
  args: string[],
  deps: AgentCommandDeps,
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const stderr = deps.stderr ?? console.error;
  const sub = args[0];
  if (sub === undefined || sub === "help" || args.includes("--help") || args.includes("-h")) {
    stdout(`osstack agent — agent registry and performance

  osstack agent list
  osstack agent scorecard [agent_id] [--json]
`);
    return 0;
  }

  if (sub === "list") {
    if (!args.includes("--daemon")) {
      const agents = await (deps.listProfiles ?? listLocalAgentProfiles)();
      if (args.includes("--json")) {
        stdout(JSON.stringify({ agents }, null, 2));
      } else {
        for (const agent of agents) {
          stdout(`${agent.id} — ${agent.display_name}`);
          stdout(`  roles=${agent.roles.join(",") || "(none)"}`);
          stdout(`  auth_mode=${agent.auth_mode} cost_tier=${agent.cost_tier} available=${agent.available.available}`);
          if (agent.runtime_identity !== undefined) {
            stdout(`  provider=${agent.runtime_identity.provider_id} model=${agent.runtime_identity.model_id}`);
          }
          if (!agent.available.available && agent.available.reason !== undefined) {
            stdout(`  unavailable_reason=${agent.available.reason}`);
          }
          stdout(`  capabilities=${agent.capabilities.map((capability) => capability.kind).join(",")}`);
        }
      }
      return 0;
    }
    const response = (await deps.rpc("agent.list")) as AgentCommandRpcResponse;
    if (!response.ok) {
      stderr("osstack:", response.error?.message ?? "agent.list failed");
      return 1;
    }
    stdout(JSON.stringify(response.result, null, 2));
    return 0;
  }

  if (sub === "scorecard") {
    const agentId = args.slice(1).find((value) => !value.startsWith("--") && value !== "scorecard");
    const dbPath = await deps.stateDbPath();
    const db = openDb({ path: dbPath });
    try {
      if (agentId !== undefined) {
        const scorecard = getAgentScorecard(db, agentId);
        if (args.includes("--json")) {
          stdout(JSON.stringify(scorecard, null, 2));
        } else {
          printAgentScorecard(scorecard, stdout);
        }
        return 0;
      }
      const scorecards = listAgentScorecards(db);
      if (args.includes("--json")) {
        stdout(JSON.stringify({ scorecards }, null, 2));
      } else if (scorecards.length === 0) {
        stdout("No agent run history yet.");
      } else {
        for (const scorecard of scorecards) printAgentScorecard(scorecard, stdout);
      }
      return 0;
    } finally {
      db.close();
    }
  }

  stderr(`osstack: unknown agent subcommand "${sub}"`);
  return 1;
}
