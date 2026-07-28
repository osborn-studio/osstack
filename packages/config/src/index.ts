// @osstack/config — Osstack agent configuration: role-based agent selection
// with per-machine profiles, availability probing, and fallback resolution.

export {
  AgentRole,
  RoleBinding,
  RoleMap,
  Profile,
  AgentRuntimeIdentityOverride,
  OsstackConfig,
  ROLE_KINDS,
  ALL_ROLES,
} from "./types.js";

export {
  osstackHome,
  configPath,
  defaultConfig,
  configExists,
  loadConfig,
  saveConfig,
  selectProfile,
  currentHostname,
  currentMacModel,
  type ResolvedProfile,
  type SelectOpts,
} from "./config.js";

export {
  resolveRuntimeIdentity,
} from "./runtime-identity.js";

export {
  resolveRole,
  resolveAll,
  resolveDeliveryRoles,
  runtimeIdentitiesIndependent,
  type RoleResolution,
  type ResolveOpts,
  type ResolveDeliveryRolesOpts,
  type DeliveryRoleResolution,
  type RuntimeIndependenceLevel,
} from "./resolver.js";

export const CONFIG_VERSION = "0.0.0";
