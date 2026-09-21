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

export { GraphRunStore, GraphRunStorageError } from "./state/graph-runs.js";
export { GraphActionStore, GraphActionStorageError } from "./state/graph-actions.js";
export type {
  GraphActionAdmission, GraphActionOutcomeInput, GraphActionOutcome, GraphActionUncertainty,
  GraphAction, GraphActionBudget, GraphActionResult, GraphActionStorageErrorCode,
} from "./state/graph-actions.js";
export type {
  GraphProgramVersion, GraphProgramIdentity, GraphStoppedWorkerEvidence,
  GraphRunFence, GraphLeaseAcquisition, GraphLeaseRenewal, GraphRunProjection,
  GraphRun, GraphRunStorageErrorCode,
} from "./state/graph-runs.js";
export { readRepositoryGit } from "./graph/repository-git.js";
export { resolveRepositoryScope } from "./graph/repository-scope.js";
export type { RepositoryScope } from "./graph/repository-scope.js";
export { GraphCheckpointStore } from './state/graph-checkpoints.js';
