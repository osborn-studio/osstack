import {
  agentAuthMode,
  type AgentAdapter,
  type AgentRuntimeIdentity,
} from "@osstack/agents";
import {
  AgentRuntimeIdentityOverride,
  type AgentRuntimeIdentityOverride as AgentRuntimeIdentityOverrideT,
} from "./types.js";

export async function resolveRuntimeIdentity(
  adapter: AgentAdapter,
  override?: AgentRuntimeIdentityOverrideT,
): Promise<AgentRuntimeIdentity> {
  const reported = await adapter.runtimeIdentity?.();
  if (
    reported !== undefined
    && reported.adapter_id !== adapter.id
  ) {
    throw new Error(
      `runtime identity adapter mismatch: expected ${adapter.id}, got ${reported.adapter_id}`,
    );
  }
  if (
    reported !== undefined
    && reported.evidence_source === "reported"
  ) {
    return reported;
  }

  if (override !== undefined) {
    const configured = AgentRuntimeIdentityOverride.parse(override);
    return {
      adapter_id: adapter.id,
      adapter_version: reported?.adapter_version ?? "unknown",
      auth_mode: agentAuthMode(adapter.id),
      provider_id: configured.provider_id,
      model_id: configured.model_id,
      ...(configured.model_context_window !== undefined
        ? { model_context_window: configured.model_context_window }
        : {}),
      ...(configured.reasoning_effort !== undefined
        ? { reasoning_effort: configured.reasoning_effort }
        : {}),
      ...(configured.agent_profile !== undefined
        ? { agent_profile: configured.agent_profile }
        : {}),
      ...(reported?.binary_path_sha256 !== undefined
        ? { binary_path_sha256: reported.binary_path_sha256 }
        : {}),
      evidence_source: "configured",
    };
  }

  return reported ?? {
    adapter_id: adapter.id,
    adapter_version: "unknown",
    auth_mode: agentAuthMode(adapter.id),
    provider_id: "unknown",
    model_id: "unknown",
    evidence_source: "inferred",
  };
}
