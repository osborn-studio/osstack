import { FifoSemaphore } from "@osstack/autonomy";
import { GovernedExecution, type ExecutionLease } from "./governed-execution.js";
import { guardedOpenDb } from "./guarded-open-db.js";
import { makeRepositoryPolicyGate } from "./repository-policy.js";
import { runAutonomyHealth } from "./autonomy-health.js";

/** Foreground CLI is the trusted local caller. Same canonical repository lock
 * as daemon/graph admission; no caller-supplied owner or scope assertion. */
export async function acquireLocalExecution(options: {
  workspacePath: string; runId: string; dbPath: string; home: string; socketPath: string;
  requiresAgent: boolean; external?: boolean;
}): Promise<ExecutionLease> {
  const gate = makeRepositoryPolicyGate(options.workspacePath);
  const admission = new GovernedExecution({ reads: new FifoSemaphore(1), writes: new FifoSemaphore(1), repositories: new Map(),
    checkHealth: async () => {
      const db = guardedOpenDb({ path: options.dbPath });
      try {
        const health = await runAutonomyHealth({ db, db_path: options.dbPath, home: options.home, socket_path: options.socketPath,
          // Local admission does not assert unprobed external services healthy.
          ...(options.external ? {
            power_policy: process.env["OSSTACK_POWER_POLICY"] === "process_assertion" ? "process_assertion" as const : "none" as const,
            clock_monitor: process.env["OSSTACK_CLOCK_MONITOR"] === "monotonic-v1",
            require_launchd: process.platform === "darwin" && process.env["OSSTACK_AGENT_PROFILE"] === "mac-mini",
          } : {
            probe_github_auth: async () => false, probe_github_network: async () => false,
            probe_launchd: async () => ({ loaded: false, output: "" }),
          }),
          ...(options.requiresAgent ? {} : { probe_adapters: async () => [{ id: "loop-local-executor", available: true, capability_kinds: ["code.write"] }] }),
        });
        if (!health.can_run_local) throw new Error(`writes blocked by ${health.write_blockers.join(",")}`);
      } finally { db.close(); }
    },
  });
  return admission.acquire({ kind: "write", runId: options.runId, workspacePath: options.workspacePath,
    authorize: async () => { const decision = await gate({ workspacePath: options.workspacePath }); if (!decision.allow) throw new Error(decision.reason); },
  });
}
