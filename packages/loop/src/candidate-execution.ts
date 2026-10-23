import { isAbsolute } from "node:path";
import { executePlan, type AgentRun, type LocalExecutorOptions } from "./executor.js";
import { ExecutionPlan } from "./types.js";

/** Supplied by the workspace owner. Identity is checked by authorize, never by graph data. */
export interface RegisteredCandidateWorkspace {
  workspace_id: string;
  workspace_path: string;
}

type Immutable<T> = T extends object ? { readonly [K in keyof T]: Immutable<T[K]> } : T;

export interface CandidateAuthorizationScope {
  readonly plan: Immutable<ExecutionPlan>;
  readonly workspace: Immutable<RegisteredCandidateWorkspace>;
  readonly command?: string;
}

export type CandidateAuthorizationDecision = { allow: true } | { allow: false; reason: string };

export interface CandidateExecutionInput extends Omit<LocalExecutorOptions, "workspacePath"> {
  plan: ExecutionPlan;
  workspace: RegisteredCandidateWorkspace;
  /** Mandatory trusted callback: validate current authority AND workspace registration/scope. */
  authorize: (scope: CandidateAuthorizationScope) => CandidateAuthorizationDecision | Promise<CandidateAuthorizationDecision>;
}

export interface CandidateExecutionResult {
  /** Completion only describes the implementation invocation, never a frozen/verified candidate. */
  status: "implementation_complete" | "failed" | "cancelled" | "execution_unconfirmed" | "authorization_denied" | "invalid_input";
  workspace: Immutable<RegisteredCandidateWorkspace>;
  /** Exact executor evidence, absent when execution was not started. */
  execution?: AgentRun;
  reason?: string;
}

/**
 * Execute one preselected implementation. No selection, verification, state,
 * git lifecycle or retry belongs here. The caller owns workspace registration
 * and supplies live authorization; a plan or graph checkpoint grants nothing.
 */
export async function executeCandidateImplementation(input: CandidateExecutionInput): Promise<CandidateExecutionResult> {
  // Capture all execution options and the authority function before the first
  // await. In particular, caller replacement of signal cannot revoke cancellation.
  const { plan, workspace, authorize, ...options } = input;
  const workspaceSnapshot = Object.freeze({ ...workspace });
  const base = { workspace: workspaceSnapshot };
  if (options.signal?.aborted) return { ...base, status: "cancelled", reason: "Cancelled before authorization" };

  let snapshot: { plan: ExecutionPlan; workspace: RegisteredCandidateWorkspace; command?: string };
  try {
    const effectivePlan = ExecutionPlan.parse(structuredClone(plan));
    effectivePlan.task.context = { ...effectivePlan.task.context, repo_path: workspaceSnapshot.workspace_path };
    snapshot = freezeSnapshot({
      plan: effectivePlan,
      workspace: workspaceSnapshot,
      ...(options.command !== undefined ? { command: options.command } : {}),
    });
    if (!snapshot.workspace.workspace_id.trim() || !isAbsolute(snapshot.workspace.workspace_path)
      || snapshot.workspace.workspace_path.includes("\0")
      || (options.command !== undefined && (typeof options.command !== "string" || options.command.includes("\0")))
      || (snapshot.plan.worktree_path !== undefined && snapshot.plan.worktree_path !== snapshot.workspace.workspace_path)) {
      return { ...base, status: "invalid_input", reason: "Plan and registered workspace scope must agree on an absolute path and nonempty identity" };
    }
  } catch (error) {
    return { ...base, status: "invalid_input", reason: String(error) };
  }
  const executionOptions: LocalExecutorOptions = {
    ...options,
    workspacePath: snapshot.workspace.workspace_path,
    ...(options.adapters !== undefined ? { adapters: [...options.adapters] } : {}),
  };
  if (typeof authorize !== "function") return { ...base, status: "authorization_denied", reason: "Authorization callback is required" };
  const decision = await awaitAuthorization(authorize, snapshot, options.signal);
  if (decision === "cancelled" || options.signal?.aborted) {
    return { ...base, status: "cancelled", reason: "Cancelled before execution" };
  }
  if (decision.allow !== true) return { ...base, status: "authorization_denied", reason: decision.reason };

  let execution: AgentRun;
  try { execution = await executePlan(snapshot.plan, executionOptions); }
  catch (error) { return { ...base, status: "execution_unconfirmed", reason: `Unexpected execution failure: ${String(error)}` }; }
  const status = isImplementationUnconfirmed(execution) ? "execution_unconfirmed"
    : execution.outcome === "completed"
      // Legacy's local-noop is valid there, but is not evidence of implementation.
      ? ((execution.adapter_event_count ?? 0) > 0 || execution.command_results.length > 0 ? "implementation_complete" : "failed")
      : execution.outcome;
  return { ...base, status, execution,
    ...(status === "failed" && execution.outcome === "completed" ? { reason: "No implementation invocation or command was executed" } : {}) };
}

/** Explicit compatibility path: admission/selection and all lifecycle work remain in LoopEngine. */
export async function executeLegacyImplementation(plan: ExecutionPlan, options: LocalExecutorOptions): Promise<AgentRun> {

  return executePlan(plan, options);
}

/** Unknown external effects are not retry-safe, even when a protocol failure is also present. */
export function isImplementationUnconfirmed(run: AgentRun): boolean {
  return run.cancellation?.stop_confirmed === false
    || run.command_results.some((result) => result.termination?.stop_confirmed === false)
    || run.failure_code === "cancellation_unconfirmed" || run.failure_code === "process_exit_unconfirmed"
    || run.failure_code === "surviving_descendants";
}

function awaitAuthorization(
  authorize: CandidateExecutionInput["authorize"],
  scope: CandidateAuthorizationScope,
  signal: AbortSignal | undefined,
): Promise<CandidateAuthorizationDecision | "cancelled"> {
  return new Promise((resolve) => {
    const finish = (decision: CandidateAuthorizationDecision | "cancelled"): void => {
      signal?.removeEventListener("abort", onAbort);
      resolve(decision);
    };
    const onAbort = (): void => finish("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    const deny = (error: unknown): void => finish({ allow: false, reason: `Authorization failed: ${String(error)}` });
    try {
      // Observe late rejections even after cancellation wins; no continuation
      // from the authorizer itself may launch execution.
      Promise.resolve(authorize(scope)).then((decision) => {
        if (decision?.allow === true) finish({ allow: true });
        else finish({ allow: false, reason: decision?.reason ?? "Authorization denied" });
      }, deny);
    } catch (error) { deny(error); }
  });
}

/** Only plain data can be frozen reliably (Object.freeze does not freeze Map/Date internals). */
function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new Error("Candidate authorization scope must contain plain data");
    }
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
