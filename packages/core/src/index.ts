// @osstack/core — orchestration engine.

// Namespaced adoption of the cross-process kernel contracts (R1.2). Namespaced
// (not `export *`) so protocol's Task/PolicyDecision cannot collide with core's
// own persistence-projection types.
export * as protocol from "@osstack/protocol";

export * from "./capability.js";
export * from "./state/index.js";
export * from "./state/protocol-mappers.js";
export * from "./privacy/index.js";
export * from "./orchestrator/index.js";
export * from "./policy/index.js";
export * from "./hermes/index.js";
export * from "./kanban/index.js";
export * from "./kg/index.js";
export * from "./observability/index.js";

export const CORE_VERSION = "0.0.0";
export { CURRENT_SCHEMA_VERSION } from "./state/migrations.js";
