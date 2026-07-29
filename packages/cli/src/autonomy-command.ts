import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  getAutonomyRun,
  getContractApproval,
  getContractApprovalByContract,
  getContractDecision,
  insertContractApproval,
  listAutonomyRuns,
  listContractDecisions,
  recordContractDecision,
} from "@osstack/core";
import {
  AgentCommandResult,
  AutonomyRiskDecision,
  PROTOCOL_VERSION,
  ScopedApprovalDecision,
  ScopedApprovalRequest,
  type ErrorCode,
} from "@osstack/protocol";
import {
  verifyScopedApprovalDecision,
  type GuardedDeliveryResult,
} from "@osstack/autonomy";

type AutonomyDatabase = Parameters<typeof getAutonomyRun>[0];

export interface AutonomyCommandDeps {
  db: AutonomyDatabase;
  dbPath: string;
  trustedApprovalPublicKeys: ReadonlyMap<string, string>;
  resume?: (
    autonomyRunId: string,
    decision?: ScopedApprovalDecision,
  ) => Promise<GuardedDeliveryResult>;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

interface ApprovalEvidence {
  request: ScopedApprovalRequest;
}

interface StoredSignedDecision {
  signed_decision: ScopedApprovalDecision;
  note?: string;
}

function flag(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function jsonObject(value: string | null): Record<string, unknown> | undefined {
  if (value === null) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object"
      && parsed !== null
      && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function approvalEvidence(value: string | null): ApprovalEvidence | undefined {
  const raw = jsonObject(value);
  if (raw === undefined) return undefined;
  const request = ScopedApprovalRequest.safeParse(raw["request"] ?? raw);
  return request.success ? { request: request.data } : undefined;
}

function parsedRisk(value: string | null) {
  const raw = jsonObject(value);
  const parsed = AutonomyRiskDecision.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

function proofSummary(value: string | null): Record<string, unknown> | undefined {
  return jsonObject(value);
}

function gitSummary(value: string | null): Record<string, unknown> | undefined {
  return jsonObject(value);
}

function autonomyContractId(runId: string, phase: string): string {
  return `autonomy:${runId}:${phase}`;
}

function decisionId(nonce: string): string {
  return `cd_${createHash("sha256").update(nonce).digest("hex").slice(0, 24)}`;
}

function decodedStoredDecision(
  reason: string | null,
): StoredSignedDecision | undefined {
  if (reason === null) return undefined;
  try {
    const raw = JSON.parse(reason) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      return undefined;
    }
    const record = raw as Record<string, unknown>;
    const decision = ScopedApprovalDecision.safeParse(
      record["signed_decision"],
    );
    if (!decision.success) return undefined;
    return {
      signed_decision: decision.data,
      ...(typeof record["note"] === "string"
        ? { note: record["note"] }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function latestStoredDecision(
  deps: AutonomyCommandDeps,
  runId: string,
  request: ScopedApprovalRequest,
): {
  decision_id: string;
  value: StoredSignedDecision;
} | undefined {
  const rows = listContractDecisions(
    deps.db,
    autonomyContractId(runId, request.phase),
  );
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]!;
    const value = decodedStoredDecision(row.reason);
    if (value !== undefined) {
      return { decision_id: row.decision_id, value };
    }
  }
  return undefined;
}

function genericApprovalRequest(request: ScopedApprovalRequest) {
  return {
    approval_id: request.approval_id,
    run_id: request.autonomy_run_id,
    action: request.action_scope.join(","),
    risk: "high" as const,
    requested_at: request.requested_at,
  };
}

function output(
  deps: AutonomyCommandDeps,
  args: readonly string[],
  envelope: unknown,
  human: string,
): number {
  if (args.includes("--json")) {
    deps.stdout?.(JSON.stringify(AgentCommandResult.parse(envelope), null, 2));
  } else {
    deps.stdout?.(human);
  }
  return 0;
}

function failure(
  deps: AutonomyCommandDeps,
  args: readonly string[],
  code: ErrorCode,
  message: string,
): number {
  if (args.includes("--json")) {
    const blocked = code === "policy_denied" || code === "budget_exceeded";
    deps.stdout?.(JSON.stringify(AgentCommandResult.parse({
      protocol_version: PROTOCOL_VERSION,
      status: blocked ? "blocked" : "error",
      error: {
        code,
        message,
        retryable: code === "conflict" || code === "internal",
      },
    }), null, 2));
  } else {
    deps.stderr?.(`osstack: ${message}`);
  }
  return code === "policy_denied" || code === "budget_exceeded" ? 2 : 1;
}

function runSummary(
  deps: AutonomyCommandDeps,
  row: ReturnType<typeof getAutonomyRun> extends infer T
    ? Exclude<T, undefined>
    : never,
) {
  const preflight = parsedRisk(row.preflight_risk_json);
  const postDiff = parsedRisk(row.post_diff_risk_json);
  const approval = approvalEvidence(row.approval_json);
  const stored = approval === undefined
    ? undefined
    : latestStoredDecision(deps, row.autonomy_run_id, approval.request);
  const candidate = proofSummary(row.candidate_proof_json);
  const delivery = gitSummary(row.git_delivery_json);
  return {
    autonomy_run_id: row.autonomy_run_id,
    task_id: row.task_id,
    repo_id: row.repo_id,
    state: row.state,
    revision: row.revision,
    risk: {
      preflight: preflight?.level ?? null,
      post_diff: postDiff?.level ?? null,
      signals: [
        ...(preflight?.signals ?? []),
        ...(postDiff?.signals ?? []),
      ],
    },
    contract_sha256: row.contract_sha256,
    diff_sha256: row.diff_sha256,
    requested_actions: approval?.request.action_scope ?? [],
    approval_status:
      approval === undefined
        ? "not_required"
        : stored === undefined
          ? "pending"
          : stored.value.signed_decision.payload.decision === "approve"
            ? "approved"
            : "rejected",
    approval_request: approval?.request,
    candidate_proof: candidate ?? null,
    pr_url:
      typeof delivery?.["pr_url"] === "string"
        ? delivery["pr_url"]
        : typeof delivery?.["pr"] === "object"
          && delivery["pr"] !== null
          && typeof (delivery["pr"] as Record<string, unknown>)["url"] === "string"
            ? (delivery["pr"] as Record<string, unknown>)["url"]
            : null,
    final_proof: proofSummary(row.final_proof_json) ?? null,
    last_transition: row.last_transition_id,
    updated_at: row.updated_at,
  };
}

function nextActionsForSummary(
  summary: ReturnType<typeof runSummary>,
): Array<{ command: string; reason: string }> {
  if (summary.state === "awaiting_approval") {
    if (summary.approval_status === "pending") {
      return [{
        command: "autonomy.approve",
        reason:
          `Import an external signed decision for ${summary.autonomy_run_id}`,
      }];
    }
    if (summary.approval_status === "approved") {
      return [{
        command: "autonomy.resume",
        reason: `Resume ${summary.autonomy_run_id} from its verified decision`,
      }];
    }
  }
  if (summary.state === "blocked_delivery") {
    return [{
      command: "autonomy.resume",
      reason: `Retry idempotent Git delivery for ${summary.autonomy_run_id}`,
    }];
  }
  return [];
}

export async function handleAutonomyCommand(
  args: string[],
  depsValue: AutonomyCommandDeps,
): Promise<number> {
  const deps: AutonomyCommandDeps = {
    ...depsValue,
    now: depsValue.now ?? (() => new Date()),
    stdout: depsValue.stdout ?? console.log,
    stderr: depsValue.stderr ?? console.error,
  };
  const subcommand = args[0] ?? "list";
  if (
    subcommand === "help"
    || args.includes("--help")
    || args.includes("-h")
  ) {
    deps.stdout?.(`osstack autonomy — guarded delivery control

  osstack autonomy list [--repo ID] [--json]
  osstack autonomy status RUN_ID [--json]
  osstack autonomy approve RUN_ID --decision FILE [--reason TEXT] [--json]
  osstack autonomy reject RUN_ID --decision FILE [--reason TEXT] [--json]
  osstack autonomy resume RUN_ID [--json]

approve/reject import an externally signed Ed25519 decision. --actor string
self-assertion is not accepted. Approval records authority only; resume executes.`);
    return 0;
  }

  if (subcommand === "list") {
    const rows = listAutonomyRuns(deps.db, {
      ...(flag(args, "--repo") === undefined
        ? {}
        : { repo_id: flag(args, "--repo")! }),
    });
    const runs = rows.map((row) => runSummary(deps, row));
    return output(
      deps,
      args,
      {
        protocol_version: PROTOCOL_VERSION,
        status: "ok",
        result: { runs },
      },
      runs.length === 0
        ? "No autonomy runs."
        : runs
            .map(
              (run) =>
                `${run.autonomy_run_id} ${run.state} risk=${run.risk.post_diff ?? run.risk.preflight ?? "unknown"} approval=${run.approval_status}`,
            )
            .join("\n"),
    );
  }

  const runId = args[1];
  if (runId === undefined || runId.startsWith("--")) {
    return failure(
      deps,
      args,
      "bad_request",
      `${subcommand} requires an autonomy run id`,
    );
  }
  const row = getAutonomyRun(deps.db, runId);
  if (row === undefined) {
    return failure(
      deps,
      args,
      "not_found",
      `autonomy run ${runId} was not found`,
    );
  }
  const summary = runSummary(deps, row);

  if (subcommand === "status") {
    const nextActions = nextActionsForSummary(summary);
    if (
      row.state === "blocked"
      || row.state === "delivery_evidence_failed"
      || row.state === "escalated"
      || row.state === "cancelled"
    ) {
      const message = `autonomy run ${runId} is blocked in ${row.state}`;
      if (args.includes("--json")) {
        deps.stdout?.(JSON.stringify(AgentCommandResult.parse({
          protocol_version: PROTOCOL_VERSION,
          status: "blocked",
          result: {
            ...summary,
            autonomy_status: "blocked",
          },
          error: {
            code: "policy_denied",
            message,
            retryable: false,
          },
        }), null, 2));
      } else {
        deps.stderr?.(`osstack: ${message}`);
      }
      return 2;
    }
    const waiting =
      row.state === "awaiting_approval"
      && summary.approval_status === "pending";
    return output(
      deps,
      args,
      {
        protocol_version: PROTOCOL_VERSION,
        status: waiting ? "needs_approval" : "ok",
        result: {
          ...summary,
          autonomy_status:
            row.state === "completed"
              ? "completed"
              : waiting
                ? "needs_approval"
                : "active",
        },
        ...(waiting && summary.approval_request !== undefined
          ? {
              required_approvals: [
                genericApprovalRequest(summary.approval_request),
              ],
            }
          : {}),
        ...(nextActions.length === 0 ? {} : { next_actions: nextActions }),
      },
      [
        `autonomy_run_id=${summary.autonomy_run_id}`,
        `state=${summary.state}`,
        `risk=${summary.risk.post_diff ?? summary.risk.preflight ?? "unknown"}`,
        `approval_status=${summary.approval_status}`,
        `candidate_proof=${JSON.stringify(summary.candidate_proof)}`,
        `pr_url=${summary.pr_url ?? "none"}`,
        `last_transition=${summary.last_transition}`,
      ].join("\n"),
    );
  }

  if (subcommand === "approve" || subcommand === "reject") {
    if (args.includes("--actor")) {
      return failure(
        deps,
        args,
        "policy_denied",
        "--actor identity strings cannot authorize guarded autonomy",
      );
    }
    if (row.state !== "awaiting_approval") {
      return failure(
        deps,
        args,
        "conflict",
        `${subcommand} requires state awaiting_approval, found ${row.state}`,
      );
    }
    const evidence = approvalEvidence(row.approval_json);
    if (evidence === undefined) {
      return failure(
        deps,
        args,
        "internal",
        "awaiting approval has no valid scoped request evidence",
      );
    }
    const decisionPath = flag(args, "--decision");
    if (decisionPath === undefined) {
      return failure(
        deps,
        args,
        "bad_request",
        `${subcommand} requires --decision FILE`,
      );
    }
    let decision: ScopedApprovalDecision;
    try {
      decision = ScopedApprovalDecision.parse(
        JSON.parse(await readFile(decisionPath, "utf-8")) as unknown,
      );
    } catch (error) {
      return failure(
        deps,
        args,
        "bad_request",
        `signed decision is invalid: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const expectedDecision = subcommand === "approve" ? "approve" : "reject";
    if (decision.payload.decision !== expectedDecision) {
      return failure(
        deps,
        args,
        "bad_request",
        `${subcommand} requires a signed ${expectedDecision} decision`,
      );
    }

    const contractId = autonomyContractId(runId, evidence.request.phase);
    const id = decisionId(decision.payload.nonce);
    const existing = getContractDecision(deps.db, id);
    if (existing !== undefined) {
      const decoded = decodedStoredDecision(existing.reason);
      if (
        decoded !== undefined
        && JSON.stringify(decoded.signed_decision) === JSON.stringify(decision)
      ) {
        return output(
          deps,
          args,
          {
            protocol_version: PROTOCOL_VERSION,
            status: "ok",
            result: {
              autonomy_run_id: runId,
              decision_id: id,
              decision: expectedDecision,
              reused: true,
            },
            next_actions:
              expectedDecision === "approve"
                ? [{
                    command: "autonomy.resume",
                    reason: `Resume ${runId} from its verified decision`,
                  }]
                : [],
          },
          `Signed ${expectedDecision} decision already recorded for ${runId}.`,
        );
      }
      return failure(
        deps,
        args,
        "conflict",
        "approval nonce was already used by a different decision",
      );
    }

    const diffSha256 =
      evidence.request.phase === "preflight"
        ? evidence.request.diff_sha256
        : row.diff_sha256;
    if (diffSha256 === null) {
      return failure(
        deps,
        args,
        "conflict",
        "post-diff approval has no current authoritative diff digest",
      );
    }
    try {
      verifyScopedApprovalDecision(evidence.request, decision, {
        expected: {
          autonomy_run_id: runId,
          phase: evidence.request.phase,
          contract_sha256: row.contract_sha256,
          diff_sha256: diffSha256,
          action_scope: evidence.request.action_scope,
        },
        trusted_public_keys: deps.trustedApprovalPublicKeys,
        now: () => deps.now!().toISOString(),
        consume_nonce: () => true,
      });
    } catch (error) {
      return failure(
        deps,
        args,
        "policy_denied",
        `signed decision verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const existingApproval =
      getContractApprovalByContract(deps.db, contractId)
      ?? getContractApproval(deps.db, evidence.request.approval_id);
    if (existingApproval === undefined) {
      insertContractApproval(deps.db, deps.dbPath, {
        approval_id: evidence.request.approval_id,
        contract_id: contractId,
        action: evidence.request.action_scope.join(","),
        risk: "high",
        requested_at: Date.parse(evidence.request.requested_at) / 1_000,
      });
    } else if (
      existingApproval.contract_id !== contractId
      || existingApproval.approval_id !== evidence.request.approval_id
    ) {
      return failure(
        deps,
        args,
        "conflict",
        "approval id is already bound to a different autonomy scope",
      );
    }
    const note = flag(args, "--reason");
    recordContractDecision(deps.db, deps.dbPath, {
      approval_id: evidence.request.approval_id,
      contract_id: contractId,
      action: expectedDecision === "approve" ? "approve" : "stop",
      actor_type: "human",
      actor_id: decision.payload.decided_by.id,
      decided_at: Date.parse(decision.payload.issued_at) / 1_000,
      reason: JSON.stringify({
        signed_decision: decision,
        ...(note === undefined ? {} : { note }),
      }),
      decision_id: id,
    });
    return output(
      deps,
      args,
      {
        protocol_version: PROTOCOL_VERSION,
        status: "ok",
        result: {
          autonomy_run_id: runId,
          decision_id: id,
          decision: expectedDecision,
          reused: false,
        },
        ...(expectedDecision === "approve"
          ? {
              next_actions: [{
                command: "autonomy.resume",
                reason: `Resume ${runId} from its verified decision`,
              }],
            }
          : {}),
      },
      `Recorded externally signed ${expectedDecision} decision for ${runId}.`,
    );
  }

  if (subcommand === "resume") {
    const evidence = approvalEvidence(row.approval_json);
    const stored = evidence === undefined
      ? undefined
      : latestStoredDecision(deps, runId, evidence.request);
    if (row.state === "awaiting_approval" && stored === undefined) {
      return failure(
        deps,
        args,
        "conflict",
        `autonomy run ${runId} has no verified decision to resume`,
      );
    }
    if (deps.resume === undefined) {
      return failure(
        deps,
        args,
        "internal",
        "guarded delivery resume port is not configured",
      );
    }
    if (
      row.state === "awaiting_approval"
      && stored?.value.signed_decision.payload.decision !== "approve"
    ) {
      return failure(
        deps,
        args,
        "policy_denied",
        `autonomy run ${runId} was rejected and cannot resume`,
      );
    }
    try {
      const result = await deps.resume(
        runId,
        stored?.value.signed_decision,
      );
      if (result.status === "needs_approval") {
        const request = result.approval_request;
        if (request === undefined) {
          throw new Error("needs_approval result omitted its request");
        }
        return output(
          deps,
          args,
          {
            protocol_version: PROTOCOL_VERSION,
            status: "needs_approval",
            result: {
              autonomy_run_id: runId,
              state: result.run.state,
              scoped_approval_request: request,
            },
            required_approvals: [genericApprovalRequest(request)],
          },
          `Autonomy run ${runId} now requires ${request.phase} approval.`,
        );
      }
      if (result.status === "completed") {
        return output(
          deps,
          args,
          {
            protocol_version: PROTOCOL_VERSION,
            status: "ok",
            result: {
              autonomy_run_id: runId,
              state: result.run.state,
              autonomy_status: "completed",
            },
          },
          `Autonomy run ${runId} completed.`,
        );
      }
      return failure(
        deps,
        args,
        "policy_denied",
        result.reason ?? `autonomy run stopped in ${result.run.state}`,
      );
    } catch (error) {
      return failure(
        deps,
        args,
        "internal",
        `autonomy resume failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return failure(
    deps,
    args,
    "bad_request",
    `unknown autonomy subcommand ${subcommand}`,
  );
}
