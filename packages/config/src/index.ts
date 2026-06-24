// @osstack/config — Osstack agent configuration: role-based agent selection
// with per-machine profiles, availability probing, and fallback resolution.

export {
  AgentRole,
  RoleBinding,
  RoleMap,
  Profile,
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
  resolveRole,
  resolveAll,
  type RoleResolution,
  type ResolveOpts,
} from "./resolver.js";

export const CONFIG_VERSION = "0.0.0";
