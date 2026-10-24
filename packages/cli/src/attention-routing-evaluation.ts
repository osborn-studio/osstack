import { selectProfile, type OsstackConfig } from "@osstack/config";
import type { ProfileRoutingGoldenRunner } from "@osstack/supervisor";
import { resolveLoopProfileRouting } from "./loop-profile-routing.js";

/** Use the production profile entrypoint with a complete fixture configuration.
 * Neither the user's config, machine profile, nor installed adapters are read. */
export const runProfileRoutingGolden: ProfileRoutingGoldenRunner = async (item, adapters) => {
  const config: OsstackConfig = {
    version: 1, active_profile: "golden", agent_runtime: {},
    defaults: { roles: item.roles },
    profiles: { golden: { roles: item.roles, match: { hostnames: [], model_hints: [] } } },
  };
  const args = ["--profile", "golden"];
  for (const [role, adapter] of Object.entries(item.role_overrides)) {
    if (adapter !== undefined) args.push("--role", `${role}=${adapter}`);
  }
  const result = await resolveLoopProfileRouting(args, item.explicit_builder, item.explicit_evaluators, {
    loadConfig: () => config,
    selectProfile: (value, options) => selectProfile(value, { ...options, hostname: "golden-fixture", model: "" }),
    adapters: () => adapters,
  });
  if (result instanceof Error) return { kind: "profile_rejected", message: result.message };
  if (!result) return undefined;
  return { kind: "profile_selected", builder: result.agentId, evaluator: result.verifierAgentIds[0],
    independent: result.summary.independent, overrides: result.summary.overrides };
};
