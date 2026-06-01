// Status FSM — 11 states from the Hermes Run Adapter Contract.
// The runtime is the source of truth; this module validates that any
// emitted status transition is legal. Illegal transitions are bugs.

export const RUN_STATUSES = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_clarify",
  "paused",
  "cancelling",
  "cancelled",
  "failed",
  "completed",
  "expired",
] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_STATUSES = new Set<RunStatus>([
  "cancelled",
  "failed",
  "completed",
  "expired",
]);

// ──────────────────────────────────────────────────────────────────────
// Legal transitions
//
//   queued  ──▶  running  ──▶  awaiting_approval ──▶  running
//                 │   ▲                                    │
//                 │   └──── paused ──┐                     │
//                 │                  │                     │
//                 │                  ▼                     ▼
//                 └──────────▶  awaiting_clarify ──▶  running
//                 │                                        │
//                 │                                        ▼
//                 │                              ┌── completed
//                 │                              ├── failed
//                 ├──▶  cancelling ──────────────┴── cancelled
//                 │
//                 └──▶  expired   (timeout from any non-terminal)
// ──────────────────────────────────────────────────────────────────────

const TRANSITIONS: Record<RunStatus, ReadonlySet<RunStatus>> = {
  queued: new Set(["running", "cancelling", "expired"]),
  running: new Set([
    "awaiting_approval", "awaiting_clarify", "paused",
    "cancelling", "completed", "failed", "expired",
  ]),
  awaiting_approval: new Set(["running", "cancelling", "expired"]),
  awaiting_clarify: new Set(["running", "cancelling", "expired"]),
  paused: new Set(["running", "cancelling", "expired"]),
  cancelling: new Set(["cancelled", "failed"]),
  // Terminal states: no outgoing transitions
  cancelled: new Set(),
  failed: new Set(),
  completed: new Set(),
  expired: new Set(),
};

export function isLegalTransition(from: RunStatus, to: RunStatus): boolean {
  return TRANSITIONS[from].has(to);
}

export function isTerminal(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export class IllegalStatusTransition extends Error {
  readonly from: RunStatus;
  readonly to: RunStatus;
  constructor(from: RunStatus, to: RunStatus) {
    super(`Illegal status transition: ${from} -> ${to}`);
    this.name = "IllegalStatusTransition";
    this.from = from;
    this.to = to;
  }
}

export function assertTransition(from: RunStatus, to: RunStatus): void {
  if (!isLegalTransition(from, to)) throw new IllegalStatusTransition(from, to);
}
