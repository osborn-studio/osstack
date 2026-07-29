import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { mkdtempSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAutonomyRun,
  freezeProduction,
  getProductionFreeze,
  listAutonomyTransitions,
  listContractDecisions,
  openDb,
  transitionAutonomyRun,
} from "@osstack/core";
import {
  AgentCommandResult,
  AUTONOMY_EMPTY_DIFF_SHA256,
  type AutonomyRiskDecision,
  type ScopedApprovalDecision,
  type ScopedApprovalDecisionPayload,
  type ScopedApprovalRequest,
} from "@osstack/protocol";
import {
  canonicalScopedApprovalDecisionPayload,
  createScopedApprovalRequest,
} from "@osstack/autonomy";
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { handleAutonomyCommand } from "./autonomy-command.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUBLIC_KEY = publicKey.export({
  type: "spki",
  format: "pem",
}).toString();
const NOW = "2026-07-28T18:00:00.000Z";
const CONTRACT_SHA = "a".repeat(64);
const POLICY_SHA = "b".repeat(64);

let tmp: string;
let dbPath: string;
let db: Database.Database;
let stdout: string[];
let stderr: string[];

beforeEach(async () => {
  tmp = mkdtempSync(join(tmpdir(), "osstack-autonomy-cli-"));
  dbPath = join(tmp, "state.db");
  db = openDb({ path: dbPath });
  stdout = [];
  stderr = [];
});

afterEach(async () => {
  db.close();
  await rm(tmp, { recursive: true, force: true });
});

function risk(
  level: "R0" | "R3" | "R4",
  phase: "preflight" | "post_diff" = "preflight",
): AutonomyRiskDecision {
  return {
    phase,
    level,
    signals:
      level === "R0"
        ? []
        : [{
            rule_id: level === "R3" ? "risk.auth" : "risk.r4.approval-bypass",
            level,
            message: level === "R3"
              ? "authentication surface changed"
              : "explicit approval bypass requested",
          }],
    policy_sha256: POLICY_SHA,
    input_sha256: (
      level === "R0" ? "0" : level === "R3" ? "3" : "4"
    ).repeat(64),
    decided_at: NOW,
  };
}

function approvalRequest(runId = "run-r3") {
  return createScopedApprovalRequest({
    approval_id: `approval:${runId}:preflight`,
    autonomy_run_id: runId,
    phase: "preflight",
    contract_sha256: CONTRACT_SHA,
    diff_sha256: AUTONOMY_EMPTY_DIFF_SHA256,
    action_scope: ["build", "verify"],
    risk: "R3",
    nonce: `nonce-${runId}`,
    requested_at: NOW,
    expires_at: "2026-07-28T20:00:00.000Z",
  });
}

function seedRun(options: {
  runId?: string;
  repoId?: string;
  state?: "awaiting_approval" | "blocked" | "completed";
} = {}) {
  const runId = options.runId ?? "run-r3";
  const repoId = options.repoId ?? "owner/repo";
  const state = options.state ?? "awaiting_approval";
  createAutonomyRun(db, dbPath, {
    autonomy_run_id: runId,
    transition_id: `${runId}:queued`,
    task_id: "task-1",
    repo_id: repoId,
    workspace_path: "/tmp/repo",
    contract_sha256: CONTRACT_SHA,
    routing: { builder: "claude", evaluator: "kimi" },
    budget: {
      max_builder_iterations: 3,
      max_review_rounds: 3,
      max_wall_time_ms: 5_400_000,
      max_no_progress_rounds: 2,
    },
    attempt: {},
    event: { kind: "queued" },
    occurred_at: 1,
  });
  transitionAutonomyRun(db, dbPath, {
    autonomy_run_id: runId,
    transition_id: `${runId}:classifying`,
    expected_revision: 1,
    to_state: "classifying",
    event: { kind: "classifying" },
    occurred_at: 2,
  });
  const level = state === "completed" ? "R0" : state === "blocked" ? "R4" : "R3";
  transitionAutonomyRun(db, dbPath, {
    autonomy_run_id: runId,
    transition_id: `${runId}:${state}`,
    expected_revision: 2,
    to_state: state,
    event: { kind: state },
    patch: {
      preflight_risk: JSON.parse(
        JSON.stringify(risk(level)),
      ) as Record<string, never>,
      ...(state === "awaiting_approval"
        ? {
            approval: JSON.parse(
              JSON.stringify({ request: approvalRequest(runId) }),
            ) as Record<string, never>,
          }
        : {}),
    },
    occurred_at: 3,
  });
}

function signedDecision(
  runId = "run-r3",
  overrides: Partial<ScopedApprovalDecisionPayload> = {},
): ScopedApprovalDecision {
  const request = approvalRequest(runId);
  const payload: ScopedApprovalDecisionPayload = {
    approval_id: request.approval_id,
    request_sha256: request.request_sha256,
    autonomy_run_id: runId,
    phase: "preflight",
    contract_sha256: CONTRACT_SHA,
    diff_sha256: AUTONOMY_EMPTY_DIFF_SHA256,
    action_scope: ["build", "verify"],
    decision: "approve",
    nonce: request.nonce,
    issued_at: NOW,
    expires_at: request.expires_at,
    decided_by: { type: "human", id: "owner" },
    ...overrides,
  };
  return {
    payload,
    signature: {
      algorithm: "Ed25519",
      key_id: "owner-key",
      value_base64url: sign(
        null,
        Buffer.from(canonicalScopedApprovalDecisionPayload(payload)),
        privateKey,
      ).toString("base64url"),
    },
  };
}

function signedDecisionForRequest(
  request: ScopedApprovalRequest,
  overrides: Partial<ScopedApprovalDecisionPayload> = {},
): ScopedApprovalDecision {
  const payload: ScopedApprovalDecisionPayload = {
    approval_id: request.approval_id,
    request_sha256: request.request_sha256,
    autonomy_run_id: request.autonomy_run_id,
    phase: request.phase,
    contract_sha256: request.contract_sha256,
    diff_sha256: request.diff_sha256,
    action_scope: request.action_scope,
    decision: "approve",
    nonce: request.nonce,
    issued_at: NOW,
    expires_at: request.expires_at,
    decided_by: { type: "human", id: "owner" },
    ...overrides,
  };
  return {
    payload,
    signature: {
      algorithm: "Ed25519",
      key_id: "owner-key",
      value_base64url: sign(
        null,
        Buffer.from(canonicalScopedApprovalDecisionPayload(payload)),
        privateKey,
      ).toString("base64url"),
    },
  };
}

async function writeDecision(
  decision: unknown,
  name = "decision.json",
): Promise<string> {
  const path = join(tmp, name);
  await writeFile(path, JSON.stringify(decision, null, 2));
  return path;
}

function deps(
  resume?: Parameters<typeof handleAutonomyCommand>[1]["resume"],
) {
  return {
    db,
    dbPath,
    trustedApprovalPublicKeys: new Map([["owner-key", PUBLIC_KEY]]),
    now: () => new Date(NOW),
    stdout: (line: string) => stdout.push(line),
    stderr: (line: string) => stderr.push(line),
    ...(resume === undefined ? {} : { resume }),
  };
}

describe("autonomy CLI", () => {
  it("returns structured degraded health while preserving local availability", async () => {
    const exitCode = await handleAutonomyCommand(
      ["health", "--json"],
      {
        ...deps(),
        health: async () => ({
          ok: false,
          can_run_local: true,
          can_merge: false,
          can_push_deploy: false,
          drain_required: false,
          disk_free_bytes: 20 * 1024 ** 3,
          checks: [{
            id: "github_network",
            status: "blocked",
            scope: "external",
            detail: "GitHub network probe failed",
          }],
          active_freezes: [],
          resumable_runs: [],
          proof_failures: [],
          notification_outbox: {
            pending_count: 0,
            dead_letter_count: 0,
            oldest_pending_at: null,
            oldest_dead_letter_at: null,
            oldest_attention_age_seconds: 0,
          },
          external_blockers: ["github_network"],
          write_blockers: [],
          next_actions: [
            "Wait for GitHub network recovery; local work may continue",
          ],
        }),
      },
    );

    expect(exitCode).toBe(2);
    const envelope = AgentCommandResult.parse(
      JSON.parse(stdout.join("\n")),
    );
    expect(envelope.status).toBe("ok");
    expect(envelope.result).toMatchObject({
      health_status: "degraded",
      can_run_local: true,
      can_push_deploy: false,
      external_blockers: ["github_network"],
    });
  });

  it("shows risk, digests, actions, proof, Git, and transition status", async () => {
    seedRun();

    const exitCode = await handleAutonomyCommand(
      ["status", "run-r3", "--json"],
      deps(),
    );

    expect(exitCode).toBe(0);
    const envelope = AgentCommandResult.parse(
      JSON.parse(stdout.join("\n")),
    );
    expect(envelope.status).toBe("needs_approval");
    expect(envelope.required_approvals).toHaveLength(1);
    expect(envelope.result).toMatchObject({
      autonomy_run_id: "run-r3",
      state: "awaiting_approval",
      contract_sha256: CONTRACT_SHA,
      diff_sha256: null,
      requested_actions: ["build", "verify"],
      approval_status: "pending",
      candidate_proof: null,
      pr_url: null,
      last_transition: "run-r3:awaiting_approval",
    });
  });

  it("rejects agent identity self-assertion and agent-signed actors", async () => {
    seedRun();
    const decisionPath = await writeDecision(signedDecision());
    const selfAssertExitCode = await handleAutonomyCommand([
      "approve",
      "run-r3",
      "--actor",
      "agent:builder",
      "--decision",
      decisionPath,
      "--json",
    ], deps());
    expect(selfAssertExitCode).toBe(2);

    const agentDecision = signedDecision() as unknown as {
      payload: Record<string, unknown>;
      signature: unknown;
    };
    agentDecision.payload["decided_by"] = {
      type: "agent",
      id: "builder",
    };
    const agentPath = await writeDecision(agentDecision, "agent.json");
    const agentExitCode = await handleAutonomyCommand([
      "approve",
      "run-r3",
      "--decision",
      agentPath,
      "--json",
    ], deps());
    expect(agentExitCode).not.toBe(0);
  });

  it("rejects approval outside an R3 awaiting state", async () => {
    seedRun({ state: "completed" });
    const decisionPath = await writeDecision(signedDecision());

    expect(await handleAutonomyCommand([
      "approve",
      "run-r3",
      "--decision",
      decisionPath,
      "--json",
    ], deps())).toBe(1);
  });

  it("rejects a stale signed request digest", async () => {
    seedRun();
    const decisionPath = await writeDecision(
      signedDecision("run-r3", { request_sha256: "e".repeat(64) }),
    );

    expect(await handleAutonomyCommand([
      "approve",
      "run-r3",
      "--decision",
      decisionPath,
      "--json",
    ], deps())).toBe(2);
    expect(stdout.join("\n")).toContain("request_sha256");
  });

  it("exposes no approval action for permanently blocked R4", async () => {
    seedRun({ state: "blocked" });

    expect(await handleAutonomyCommand(
      ["status", "run-r3", "--json"],
      deps(),
    )).toBe(2);
    const envelope = AgentCommandResult.parse(
      JSON.parse(stdout.join("\n")),
    );
    expect(envelope.status).toBe("blocked");
    expect(envelope.next_actions ?? []).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "autonomy.approve" }),
      ]),
    );
  });

  it("blocks resume before a verified decision is recorded", async () => {
    seedRun();

    expect(await handleAutonomyCommand(
      ["resume", "run-r3", "--json"],
      deps(),
    )).toBe(1);
    expect(stdout.join("\n")).toContain("no verified decision");
  });

  it("records signed decisions append-only and idempotently", async () => {
    seedRun();
    const decisionPath = await writeDecision(signedDecision());

    const approvalExitCode = await handleAutonomyCommand([
      "approve",
      "run-r3",
      "--decision",
      decisionPath,
      "--reason",
      "Reviewed exact scope",
      "--json",
    ], deps());
    expect(approvalExitCode, stdout.join("\n")).toBe(0);
    stdout = [];
    expect(await handleAutonomyCommand([
      "approve",
      "run-r3",
      "--decision",
      decisionPath,
      "--json",
    ], deps())).toBe(0);

    const rows = listContractDecisions(
      db,
      "autonomy:run-r3:preflight",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "approve",
      actor_type: "human",
      actor_id: "owner",
    });
    expect(stdout.join("\n")).toContain("\"reused\": true");
  });

  it("keeps approval recording separate from resume execution", async () => {
    seedRun();
    const decisionPath = await writeDecision(signedDecision());
    let resumeCalls = 0;
    const resume = async () => {
      resumeCalls += 1;
      return {
        status: "completed" as const,
        run: {
          autonomy_run_id: "run-r3",
          state: "completed" as const,
          revision: 4,
          context: {},
        },
      };
    };

    const approvalExitCode = await handleAutonomyCommand([
      "approve",
      "run-r3",
      "--decision",
      decisionPath,
      "--json",
    ], deps(resume));
    expect(approvalExitCode, stdout.join("\n")).toBe(0);
    expect(resumeCalls).toBe(0);
    stdout = [];
    expect(await handleAutonomyCommand([
      "resume",
      "run-r3",
      "--json",
    ], deps(resume))).toBe(0);
    expect(resumeCalls).toBe(1);
    expect(
      AgentCommandResult.parse(JSON.parse(stdout.join("\n"))).result,
    ).toMatchObject({ autonomy_status: "completed" });
  });

  it("lists runs by repository", async () => {
    await mkdir(join(tmp, "unused"), { recursive: true });
    seedRun({ repoId: "owner/one" });

    expect(await handleAutonomyCommand(
      ["list", "--repo", "owner/one", "--json"],
      deps(),
    )).toBe(0);
    const envelope = AgentCommandResult.parse(
      JSON.parse(stdout.join("\n")),
    );
    expect(envelope.result?.["runs"]).toEqual([
      expect.objectContaining({ repo_id: "owner/one" }),
    ]);
  });

  it("lists production freezes with source reason and transition history", async () => {
    seedRun({ state: "completed", repoId: "owner/one" });
    freezeProduction(db, dbPath, {
      repo_id: "owner/one",
      reason: "production health check failed",
      source_run_id: "run-r3",
      frozen_at: Date.parse("2026-07-28T17:30:00.000Z") / 1_000,
    });

    expect(await handleAutonomyCommand(
      ["freeze", "list", "--repo", "owner/one", "--json"],
      deps(),
    )).toBe(0);
    const envelope = AgentCommandResult.parse(
      JSON.parse(stdout.join("\n")),
    );
    expect(envelope.result?.["freezes"]).toEqual([
      expect.objectContaining({
        repo_id: "owner/one",
        frozen: true,
        reason: "production health check failed",
        source_run_id: "run-r3",
        transitions: [
          expect.objectContaining({
            transition_id: "run-r3:queued",
            to_state: "queued",
          }),
          expect.objectContaining({
            transition_id: "run-r3:classifying",
            to_state: "classifying",
          }),
          expect.objectContaining({
            transition_id: "run-r3:completed",
            to_state: "completed",
          }),
        ],
      }),
    ]);
  });

  it("requires an externally signed freeze-clear decision and never resumes deployment", async () => {
    seedRun({ state: "completed", repoId: "owner/one" });
    freezeProduction(db, dbPath, {
      repo_id: "owner/one",
      reason: "rollback completed after production failure",
      source_run_id: "run-r3",
      frozen_at: Date.parse("2026-07-28T17:30:00.000Z") / 1_000,
    });
    let resumeCalls = 0;
    const commandDeps = deps(async () => {
      resumeCalls += 1;
      throw new Error("freeze clear must not resume a run");
    });

    expect(await handleAutonomyCommand(
      ["freeze", "request", "owner/one", "--json"],
      commandDeps,
    )).toBe(0);
    const requestEnvelope = AgentCommandResult.parse(
      JSON.parse(stdout.join("\n")),
    );
    const request = requestEnvelope.result?.[
      "scoped_approval_request"
    ] as ScopedApprovalRequest;
    expect(request).toMatchObject({
      autonomy_run_id: "run-r3",
      phase: "post_diff",
      contract_sha256: CONTRACT_SHA,
      action_scope: ["freeze:clear:production"],
      risk: "R3",
    });
    expect(request.diff_sha256).toMatch(/^[a-f0-9]{64}$/);
    const requestPath = await writeDecision(request, "freeze-request.json");
    const decision = signedDecisionForRequest(request);
    const decisionPath = await writeDecision(
      decision,
      "freeze-decision.json",
    );
    stdout = [];

    expect(await handleAutonomyCommand([
      "freeze",
      "clear",
      "owner/one",
      "--request",
      requestPath,
      "--decision",
      decisionPath,
      "--reason",
      "Rollback verified and incident closed",
      "--json",
    ], commandDeps), stdout.join("\n")).toBe(0);
    expect(resumeCalls).toBe(0);
    expect(getProductionFreeze(db, "owner/one")).toMatchObject({
      frozen: 0,
      clear_reason: "Rollback verified and incident closed",
      cleared_by_type: "human",
      cleared_by_id: "owner",
      clear_key_id: "owner-key",
      clear_decision_sha256: createHash("sha256")
        .update(JSON.stringify(decision))
        .digest("hex"),
    });
    expect(listAutonomyTransitions(db, "run-r3")).toHaveLength(3);

    stdout = [];
    expect(await handleAutonomyCommand([
      "freeze",
      "clear",
      "owner/one",
      "--request",
      requestPath,
      "--decision",
      decisionPath,
      "--reason",
      "Rollback verified and incident closed",
      "--json",
    ], commandDeps)).toBe(0);
    expect(stdout.join("\n")).toContain("\"reused\": true");
    expect(resumeCalls).toBe(0);
  });

  it("rejects self-asserted, agent, stale, and incomplete freeze-clear authority", async () => {
    seedRun({ state: "completed", repoId: "owner/one" });
    freezeProduction(db, dbPath, {
      repo_id: "owner/one",
      reason: "production health check failed",
      source_run_id: "run-r3",
      frozen_at: Date.parse("2026-07-28T17:30:00.000Z") / 1_000,
    });
    expect(await handleAutonomyCommand(
      ["freeze", "request", "owner/one", "--json"],
      deps(),
    )).toBe(0);
    const request = AgentCommandResult.parse(
      JSON.parse(stdout.join("\n")),
    ).result?.["scoped_approval_request"] as ScopedApprovalRequest;
    const requestPath = await writeDecision(request, "freeze-request.json");
    const decisionPath = await writeDecision(
      signedDecisionForRequest(request),
      "freeze-decision.json",
    );

    stdout = [];
    expect(await handleAutonomyCommand([
      "freeze",
      "clear",
      "owner/one",
      "--actor",
      "human:owner",
      "--request",
      requestPath,
      "--decision",
      decisionPath,
      "--reason",
      "incident closed",
      "--json",
    ], deps())).toBe(2);
    expect(await handleAutonomyCommand([
      "freeze",
      "clear",
      "owner/one",
      "--request",
      requestPath,
      "--decision",
      decisionPath,
      "--reason",
      "",
      "--json",
    ], deps())).toBe(1);

    const agentDecision = signedDecisionForRequest(request) as unknown as {
      payload: Record<string, unknown>;
      signature: unknown;
    };
    agentDecision.payload["decided_by"] = {
      type: "agent",
      id: "builder",
    };
    const agentPath = await writeDecision(
      agentDecision,
      "freeze-agent-decision.json",
    );
    expect(await handleAutonomyCommand([
      "freeze",
      "clear",
      "owner/one",
      "--request",
      requestPath,
      "--decision",
      agentPath,
      "--reason",
      "incident closed",
      "--json",
    ], deps())).not.toBe(0);

    freezeProduction(db, dbPath, {
      repo_id: "owner/one",
      reason: "a later independent production failure",
      source_run_id: "run-r3",
      frozen_at: Date.parse("2026-07-28T17:45:00.000Z") / 1_000,
    });
    expect(await handleAutonomyCommand([
      "freeze",
      "clear",
      "owner/one",
      "--request",
      requestPath,
      "--decision",
      decisionPath,
      "--reason",
      "incident closed",
      "--json",
    ], deps())).toBe(2);
    expect(getProductionFreeze(db, "owner/one")?.frozen).toBe(1);
  });
});
