// Compat shim (R1.1, ADR-001 §D2). The run/task/event state repositories moved
// to @osstack/core (packages/core/src/state/run-store.ts). This module now only
// re-exports the four writers so existing CLI import paths keep working.
//
// @deprecated Import these from @osstack/core instead. This shim will be removed
// after R1 consumers migrate off "./store.js".
//
// Note: core's appendEvent accepts a locally-defined StoredEventInput structural
// interface (not HermesEvent) to avoid a core → hermes-adapter dependency cycle.
// HermesEvent is structurally assignable, so CLI call sites pass their
// HermesEvent values to appendEvent unchanged.

export { appendEvent, finalizeRun, insertRun, insertTask } from "@osstack/core";
