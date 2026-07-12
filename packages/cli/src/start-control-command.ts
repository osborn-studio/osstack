// `osstack start` / `osstack control` — the contract-gated delivery lifecycle
// (R1.5). Scope discipline: v1 owns the CONTRACT LIFECYCLE + APPROVAL RECORDS,
// never auto-execution chaining. The agent surface (Claude/Codex) stays the
// driver; `control approve` emits the ready-to-run `osstack deliver …` command
// but does NOT spawn it.
//
//   osstack start "<goal>" --repo-id <id> [--json]
//       Requires the repo registered + a valid .osstack/repo.yaml (verify
//       command source). `mode: observe` ⇒ blocked (policy_denied, exit 2);
//       an invalid policy file fails closed (exit 1). Writes an Execution
//       Contract markdown into the target repo (.osstack/contracts/<id>.md),
//       tracks it as a kanban card on the "contracts" board, and records a
//       pending approval. `--json` ⇒ a strict protocol AgentCommandResult with
//       status `needs_approval`, an ApprovalRequest, and the exact
//       `control approve` invocation as next_actions[0].
//
//   osstack control <contract-id> status|approve|revise|stop [--json]
//       approve: records a protocol ApprovalDecision (actor from --actor,
//       default human:owner; AGENT actors rejected per A-004), flips the
//       contract to approved, and emits the ready-to-run deliver command.
//       revise/stop: update the contract status with a --reason.
//       status: renders the contract + approval trail + linked evidence.
//
// Contract lifecycle ⇄ kanban card status (the card is the tracking row so the
// board and `control` can follow the contract — reusing KanbanRepository per
// the R1.5 plan, no new contracts table):
//   needs_approval ⇄ triage    approved ⇄ ready
//   revising       ⇄ blocked   stopped  ⇄ archived

import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  KanbanRepository,
  contractApprovalRowToDecision,
  contractApprovalRowToRequest,
  getContractApprovalByContract,
  insertContractApproval,
  loadPolicyProfile,
  loadRepoConfig,
  openDb,
  reopenContractApproval,
  resolveContractApproval,
  type CardRow,
  type ContractApprovalRow,
  type PolicyBudgets,
  type PolicyProfile,
  type RepoConfig,
} from "@osstack/core";
import { PROTOCOL_VERSION, type AgentCommandResult } from "@osstack/protocol";
import { readRepoRegistry } from "@osstack/supervisor";
import { osstackHome } from "./paths.js";
import { flag, hasFlag, resolveRegistryPath } from "./supervisor-cli-support.js";

const CONTRACTS_BOARD = "contracts";

export interface StartControlDeps {
  now?: () => Date;
  /** Contract/approval id generator (tests pin it for determinism). */
  genId?: (prefix: string) => string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

type ContractStatus = "needs_approval" | "approved" | "revising" | "stopped";
type CardStatus = CardRow["status"];

interface ContractMeta {
  kind: "contract";
  contract_id: string;
  repo_id: string;
  repo_path: string;
  contract_path: string;
  goal: string;
  verify_command: string;
  budgets: PolicyBudgets | null;
  allowed_categories: string[];
  forbidden_categories: string[];
}

// ── lifecycle mapping ────────────────────────────────────────────────────────

const CONTRACT_TO_CARD: Record<ContractStatus, CardStatus> = {
  needs_approval: "triage",
  approved: "ready",
  revising: "blocked",
  stopped: "archived",
};

function contractStatusFromCard(status: CardStatus): ContractStatus {
  switch (status) {
    case "ready":
      return "approved";
    case "blocked":
      return "revising";
    case "archived":
      return "stopped";
    default:
      return "needs_approval";
  }
}

// ── shared helpers ───────────────────────────────────────────────────────────

function defaultGenId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/** Read every non-flag positional token (flags-with-values consume the next). */
function positionals(args: string[], flagsWithValues: Set<string>): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith("--")) {
      if (flagsWithValues.has(token)) i++;
      continue;
    }
    out.push(token);
  }
  return out;
}

/** Blocked codes pair with status "blocked" (A-006); everything else is error. */
function commandFailure(
  code: AgentCommandResultError["code"],
  message: string,
): { status: "blocked" | "error"; exit: number; result: AgentCommandResult } {
  const blocked = code === "policy_denied" || code === "budget_exceeded";
  const status = blocked ? "blocked" : "error";
  return {
    status,
    exit: blocked ? 2 : 1,
    result: {
      protocol_version: PROTOCOL_VERSION,
      status,
      error: { code, message, retryable: false },
    },
  };
}

type AgentCommandResultError = NonNullable<AgentCommandResult["error"]>;

function emitFailure(
  deps: Required<Pick<StartControlDeps, "out" | "err">>,
  json: boolean,
  code: AgentCommandResultError["code"],
  message: string,
): number {
  const failure = commandFailure(code, message);
  if (json) deps.out(JSON.stringify(failure.result, null, 2));
  else deps.err(`osstack: ${code === "policy_denied" ? "policy_denied: " : ""}${message}`);
  return failure.exit;
}

/** `--actor human:owner` -> { type, id }; enforces the A-004 human-actor rule. */
function parseActor(raw: string): { type: "human" | "agent"; id: string } | { error: string } {
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) {
    return { error: `invalid --actor "${raw}"; expected "<type>:<id>" (e.g. human:owner)` };
  }
  const type = raw.slice(0, idx);
  const id = raw.slice(idx + 1);
  if (type !== "human" && type !== "agent") {
    return { error: `invalid actor type "${type}"; expected human or agent` };
  }
  return { type, id };
}

function budgetIterations(budgets: PolicyBudgets | null | undefined): number | undefined {
  return budgets?.max_iterations;
}

/** The exact `osstack deliver …` invocation the approved contract authorizes. */
function buildDeliverCommand(meta: ContractMeta): string {
  const parts = [
    "osstack deliver",
    JSON.stringify(meta.goal),
    "--workspace",
    JSON.stringify(meta.repo_path),
    "--verify",
    JSON.stringify(meta.verify_command),
  ];
  const iters = budgetIterations(meta.budgets);
  if (iters !== undefined) parts.push("--max-iter", String(iters));
  return parts.join(" ");
}

function parseMeta(card: CardRow): ContractMeta | undefined {
  if (card.meta === null) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(card.meta);
  } catch {
    return undefined;
  }
  if (parsed === null || typeof parsed !== "object") return undefined;
  const m = parsed as Record<string, unknown>;
  if (m["kind"] !== "contract") return undefined;
  return parsed as ContractMeta;
}

// ── osstack start ────────────────────────────────────────────────────────────

const START_FLAGS_WITH_VALUES = new Set([
  "--repo-id",
  "--registry",
  "--workspace",
  "--risk",
]);

export async function handleStartCommand(
  args: string[],
  deps: StartControlDeps = {},
): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const emit = { out, err };
  const now = deps.now?.() ?? new Date();
  const genId = deps.genId ?? defaultGenId;
  const json = hasFlag(args, "--json");

  if (args[0] === "help" || args.includes("--help") || args.includes("-h")) {
    printStartHelp(out);
    return 0;
  }

  const goal = positionals(args, START_FLAGS_WITH_VALUES)[0];
  if (goal === undefined || goal.trim() === "") {
    return emitFailure(emit, json, "bad_request", 'start requires a goal: osstack start "<goal>" --repo-id <id>');
  }
  const repoId = flag(args, "--repo-id");
  if (repoId === undefined) {
    return emitFailure(emit, json, "bad_request", "start requires --repo-id <id>");
  }
  const risk = flag(args, "--risk") ?? "medium";
  if (risk !== "low" && risk !== "medium" && risk !== "high") {
    return emitFailure(emit, json, "bad_request", `invalid --risk "${risk}"; expected low, medium, or high`);
  }

  // 1. Repo must be registered.
  const registryPath = resolveRegistryPath(args);
  const entries = await readRepoRegistry(registryPath);
  const entry = entries.find((e) => e.repo_id === repoId);
  if (entry === undefined) {
    return emitFailure(emit, json, "not_found", `repo "${repoId}" is not registered in ${registryPath}`);
  }

  // 2. repo.yaml required (contract's verify command source); fail closed on invalid.
  let repoConfig: RepoConfig | undefined;
  try {
    repoConfig = await loadRepoConfig(entry.path);
  } catch (e) {
    return emitFailure(emit, json, "bad_request", errMessage(e));
  }
  if (repoConfig === undefined) {
    return emitFailure(
      emit,
      json,
      "bad_request",
      `repo "${repoId}" has no .osstack/repo.yaml — a contract needs its verify command; run onboarding first`,
    );
  }

  // 3. Policy gate: observe ⇒ blocked; invalid ⇒ fail closed.
  let policy: PolicyProfile | undefined;
  try {
    policy = await loadPolicyProfile(entry.path);
  } catch (e) {
    return emitFailure(emit, json, "bad_request", errMessage(e));
  }
  if (policy?.mode === "observe") {
    return emitFailure(
      emit,
      json,
      "policy_denied",
      `policy mode is observe for "${repoId}" — start refused; see ${join(entry.path, ".osstack", "policy.yaml")}`,
    );
  }

  // 4. Generate the contract.
  const contractId = genId("ct");
  const approvalId = genId("ap");
  const budgets = policy?.budgets ?? null;
  const allowedCategories = [
    ...(policy?.allowed_auto_changes ?? []),
    ...(policy?.requires_approval ?? []),
  ];
  const forbiddenCategories = policy?.forbidden ?? [];
  const contractPath = join(entry.path, ".osstack", "contracts", `${contractId}.md`);

  const meta: ContractMeta = {
    kind: "contract",
    contract_id: contractId,
    repo_id: repoId,
    repo_path: entry.path,
    contract_path: contractPath,
    goal,
    verify_command: repoConfig.verify_command,
    budgets,
    allowed_categories: allowedCategories,
    forbidden_categories: forbiddenCategories,
  };

  const markdown = renderContractMarkdown(meta, repoConfig, policy, now, approvalId);
  await mkdir(join(entry.path, ".osstack", "contracts"), { recursive: true });
  await writeFile(contractPath, markdown, "utf8");

  // 5. Track it: kanban card (board "contracts", id = contract id) + pending approval.
  const home = osstackHome();
  await mkdir(home, { recursive: true });
  const dbPath = join(home, "state.db");
  const db = openDb({ path: dbPath });
  try {
    const kanban = new KanbanRepository(db, dbPath, () => now.getTime() / 1000);
    kanban.createCard({
      card_id: contractId,
      board: CONTRACTS_BOARD,
      title: goal,
      body: `Execution Contract — ${contractPath}`,
      status: CONTRACT_TO_CARD.needs_approval,
      meta: JSON.stringify(meta),
    });
    insertContractApproval(db, dbPath, {
      approval_id: approvalId,
      contract_id: contractId,
      action: `start: ${goal}`,
      risk,
      requested_at: now.getTime() / 1000,
    });
  } finally {
    db.close();
  }

  // 6. Output.
  const approveInvocation = `osstack control ${contractId} approve`;
  if (json) {
    const request = contractApprovalRowToRequest({
      approval_id: approvalId,
      action: `start: ${goal}`,
      risk,
      requested_at: now.getTime() / 1000,
    });
    const result: AgentCommandResult = {
      protocol_version: PROTOCOL_VERSION,
      status: "needs_approval",
      result: {
        contract_id: contractId,
        repo_id: repoId,
        contract_path: contractPath,
        status: "needs_approval",
        verify_command: repoConfig.verify_command,
        budgets,
      },
      evidence_refs: [{ kind: "report", ref: contractPath }],
      required_approvals: [request],
      next_actions: [{ command: "control.approve", reason: approveInvocation }],
    };
    out(JSON.stringify(result, null, 2));
  } else {
    out(`Execution Contract created: ${contractId}`);
    out(`  repo:     ${repoId} (${entry.path})`);
    out(`  file:     ${contractPath}`);
    out(`  verify:   ${repoConfig.verify_command}`);
    out(`  status:   needs_approval`);
    out("");
    out("Edit the TBD non-goals / acceptance criteria, then approve:");
    out(`  ${approveInvocation}`);
  }
  return 0;
}

// ── osstack control ──────────────────────────────────────────────────────────

const CONTROL_FLAGS_WITH_VALUES = new Set(["--actor", "--reason"]);

export async function handleControlCommand(
  args: string[],
  deps: StartControlDeps = {},
): Promise<number> {
  const out = deps.out ?? console.log;
  const err = deps.err ?? console.error;
  const emit = { out, err };
  const now = deps.now?.() ?? new Date();
  const json = hasFlag(args, "--json");

  if (args[0] === "help" || args.includes("--help") || args.includes("-h") || args.length === 0) {
    printControlHelp(out);
    return args.length === 0 ? 1 : 0;
  }

  const pos = positionals(args, CONTROL_FLAGS_WITH_VALUES);
  const contractId = pos[0];
  const action = pos[1];
  if (contractId === undefined) {
    return emitFailure(emit, json, "bad_request", "control requires a contract id: osstack control <contract-id> <status|approve|revise|stop>");
  }
  if (action === undefined) {
    return emitFailure(emit, json, "bad_request", `control requires an action for ${contractId}: status|approve|revise|stop`);
  }
  if (action !== "status" && action !== "approve" && action !== "revise" && action !== "stop") {
    return emitFailure(emit, json, "bad_request", `unknown control action "${action}"; expected status|approve|revise|stop`);
  }

  const home = osstackHome();
  await mkdir(home, { recursive: true });
  const dbPath = join(home, "state.db");
  const db = openDb({ path: dbPath });
  try {
    const kanban = new KanbanRepository(db, dbPath, () => now.getTime() / 1000);
    const card = kanban.getCard(contractId);
    const meta = card ? parseMeta(card) : undefined;
    if (card === undefined || meta === undefined) {
      return emitFailure(emit, json, "not_found", `unknown contract id "${contractId}"`);
    }
    const approval = getContractApprovalByContract(db, contractId);
    if (approval === undefined) {
      return emitFailure(emit, json, "not_found", `contract "${contractId}" has no approval record`);
    }

    switch (action) {
      case "status":
        return renderStatus(emit, json, card, meta, approval);
      case "approve":
        return doApprove(emit, json, kanban, db, dbPath, now, card, meta, approval, args);
      case "revise":
        return doRevise(emit, json, kanban, db, dbPath, meta, approval, args);
      case "stop":
        return doStop(emit, json, kanban, db, dbPath, now, meta, approval, args);
    }
  } finally {
    db.close();
  }
  return 0;
}

function doApprove(
  emit: Required<Pick<StartControlDeps, "out" | "err">>,
  json: boolean,
  kanban: KanbanRepository,
  db: import("better-sqlite3").Database,
  dbPath: string,
  now: Date,
  card: CardRow,
  meta: ContractMeta,
  approval: ContractApprovalRow,
  args: string[],
): number {
  const actorRaw = flag(args, "--actor") ?? "human:owner";
  const actor = parseActor(actorRaw);
  if ("error" in actor) {
    return emitFailure(emit, json, "bad_request", actor.error);
  }
  // A-004: only human actors may approve a contract in v1 (agent delegation via
  // allowed_auto_changes is a later increment).
  if (actor.type === "agent") {
    return emitFailure(
      emit,
      json,
      "bad_request",
      `agent actor "${actorRaw}" cannot approve a contract (A-004): approval requires a human actor`,
    );
  }
  if (approval.status !== "pending") {
    return emitFailure(
      emit,
      json,
      "conflict",
      `contract "${meta.contract_id}" is not awaiting approval (status: ${contractStatusFromCard(card.status)})`,
    );
  }

  const reason = flag(args, "--reason");
  const resolved = resolveContractApproval(db, dbPath, approval.approval_id, {
    status: "approved",
    decided_by_type: actor.type,
    decided_by_id: actor.id,
    decided_at: now.getTime() / 1000,
    reason: reason ?? null,
  });
  kanban.moveCard(meta.contract_id, CONTRACT_TO_CARD.approved, { actor: `${actor.type}:${actor.id}` });
  kanban.addComment(meta.contract_id, `${actor.type}:${actor.id}`, `approved${reason ? `: ${reason}` : ""}`);

  const deliverCommand = buildDeliverCommand(meta);
  const decision = contractApprovalRowToDecision(resolved);
  if (json) {
    const result: AgentCommandResult = {
      protocol_version: PROTOCOL_VERSION,
      status: "ok",
      result: {
        contract_id: meta.contract_id,
        status: "approved",
        ...(decision !== undefined ? { approval_decision: decision } : {}),
        deliver_command: deliverCommand,
      },
      evidence_refs: [{ kind: "report", ref: meta.contract_path }],
      next_actions: [{ command: "deliver.run", reason: deliverCommand }],
    };
    emit.out(JSON.stringify(result, null, 2));
  } else {
    emit.out(`Contract ${meta.contract_id} approved by ${actor.type}:${actor.id}.`);
    emit.out("Run the authorized delivery when ready:");
    emit.out(`  ${deliverCommand}`);
  }
  return 0;
}

function doRevise(
  emit: Required<Pick<StartControlDeps, "out" | "err">>,
  json: boolean,
  kanban: KanbanRepository,
  db: import("better-sqlite3").Database,
  dbPath: string,
  meta: ContractMeta,
  approval: ContractApprovalRow,
  args: string[],
): number {
  const reason = flag(args, "--reason");
  if (reason === undefined || reason.trim() === "") {
    return emitFailure(emit, json, "bad_request", "revise requires --reason <text>");
  }
  if (approval.status === "stopped") {
    return emitFailure(emit, json, "conflict", `contract "${meta.contract_id}" is stopped and cannot be revised`);
  }
  reopenContractApproval(db, dbPath, approval.approval_id, reason);
  kanban.moveCard(meta.contract_id, CONTRACT_TO_CARD.revising, { blocked_reason: reason, actor: "human:owner" });
  kanban.addComment(meta.contract_id, "human:owner", `revise requested: ${reason}`);

  if (json) {
    const result: AgentCommandResult = {
      protocol_version: PROTOCOL_VERSION,
      status: "ok",
      result: { contract_id: meta.contract_id, status: "revising", reason },
      evidence_refs: [{ kind: "report", ref: meta.contract_path }],
      next_actions: [{ command: "control.approve", reason: `osstack control ${meta.contract_id} approve` }],
    };
    emit.out(JSON.stringify(result, null, 2));
  } else {
    emit.out(`Contract ${meta.contract_id} sent back for revision: ${reason}`);
    emit.out(`  edit ${meta.contract_path}, then: osstack control ${meta.contract_id} approve`);
  }
  return 0;
}

function doStop(
  emit: Required<Pick<StartControlDeps, "out" | "err">>,
  json: boolean,
  kanban: KanbanRepository,
  db: import("better-sqlite3").Database,
  dbPath: string,
  now: Date,
  meta: ContractMeta,
  approval: ContractApprovalRow,
  args: string[],
): number {
  const reason = flag(args, "--reason");
  if (reason === undefined || reason.trim() === "") {
    return emitFailure(emit, json, "bad_request", "stop requires --reason <text>");
  }
  if (approval.status === "stopped") {
    return emitFailure(emit, json, "conflict", `contract "${meta.contract_id}" is already stopped`);
  }
  resolveContractApproval(db, dbPath, approval.approval_id, {
    status: "stopped",
    decided_by_type: "human",
    decided_by_id: "owner",
    decided_at: now.getTime() / 1000,
    reason,
  });
  kanban.moveCard(meta.contract_id, CONTRACT_TO_CARD.stopped, { actor: "human:owner" });
  kanban.addComment(meta.contract_id, "human:owner", `stopped: ${reason}`);

  if (json) {
    const result: AgentCommandResult = {
      protocol_version: PROTOCOL_VERSION,
      status: "ok",
      result: { contract_id: meta.contract_id, status: "stopped", reason },
      evidence_refs: [{ kind: "report", ref: meta.contract_path }],
    };
    emit.out(JSON.stringify(result, null, 2));
  } else {
    emit.out(`Contract ${meta.contract_id} stopped: ${reason}`);
  }
  return 0;
}

function renderStatus(
  emit: Required<Pick<StartControlDeps, "out" | "err">>,
  json: boolean,
  card: CardRow,
  meta: ContractMeta,
  approval: ContractApprovalRow,
): number {
  const status = contractStatusFromCard(card.status);
  const request = contractApprovalRowToRequest(approval);
  const decision = contractApprovalRowToDecision(approval);
  if (json) {
    const result: AgentCommandResult = {
      protocol_version: PROTOCOL_VERSION,
      status: "ok",
      result: {
        contract_id: meta.contract_id,
        repo_id: meta.repo_id,
        goal: meta.goal,
        status,
        verify_command: meta.verify_command,
        budgets: meta.budgets,
        allowed_categories: meta.allowed_categories,
        forbidden_categories: meta.forbidden_categories,
        approval_request: request,
        ...(decision !== undefined ? { approval_decision: decision } : {}),
      },
      evidence_refs: [{ kind: "report", ref: meta.contract_path }],
    };
    emit.out(JSON.stringify(result, null, 2));
  } else {
    emit.out(`Contract ${meta.contract_id} [${status}]`);
    emit.out(`  goal:    ${meta.goal}`);
    emit.out(`  repo:    ${meta.repo_id}`);
    emit.out(`  verify:  ${meta.verify_command}`);
    emit.out(`  file:    ${meta.contract_path}`);
    emit.out("  approval trail:");
    emit.out(`    - requested (${approval.risk}) at ${new Date(approval.requested_at * 1000).toISOString()}`);
    if (decision !== undefined) {
      emit.out(
        `    - ${decision.approved ? "approved" : "stopped"} by ${decision.decided_by.type}:${decision.decided_by.id} at ${decision.decided_at}${decision.reason ? ` (${decision.reason})` : ""}`,
      );
    } else if (approval.reason) {
      emit.out(`    - pending — last note: ${approval.reason}`);
    }
  }
  return 0;
}

// ── contract markdown ────────────────────────────────────────────────────────

/**
 * Render the human-editable Execution Contract. Prose is human display only,
 * never an API surface (ADR-001 D3): the state DB card + contract_approvals
 * table are authoritative; this file is what a human reviews and edits.
 */
function renderContractMarkdown(
  meta: ContractMeta,
  repoConfig: RepoConfig,
  policy: PolicyProfile | undefined,
  now: Date,
  approvalId: string,
): string {
  const lines: string[] = [];
  lines.push(`# Execution Contract — ${meta.contract_id}`, "");
  lines.push("> Human-editable. The TBD sections MUST be filled in before approval.", "");
  lines.push("## Metadata");
  lines.push("");
  lines.push("| field | value |");
  lines.push("|---|---|");
  lines.push(`| contract_id | ${meta.contract_id} |`);
  lines.push(`| approval_id | ${approvalId} |`);
  lines.push(`| repo_id | ${meta.repo_id} |`);
  lines.push(`| product | ${repoConfig.product} |`);
  lines.push(`| repo_path | ${meta.repo_path} |`);
  lines.push(`| default_branch | ${repoConfig.default_branch} |`);
  lines.push(`| policy_mode | ${policy?.mode ?? "(none)"} |`);
  lines.push(`| created_at | ${now.toISOString()} |`);
  lines.push(`| status | needs_approval |`);
  lines.push("");
  lines.push("## Goal");
  lines.push("");
  lines.push(meta.goal);
  lines.push("");
  lines.push("## Non-goals");
  lines.push("");
  lines.push("- TBD — list what this contract explicitly does NOT cover.");
  lines.push("");
  lines.push("## Acceptance criteria");
  lines.push("");
  lines.push("- TBD — the observable conditions that mean the goal is met.");
  lines.push("");
  lines.push("## Verify command");
  lines.push("");
  lines.push("The single CI-equivalent gate (from `.osstack/repo.yaml`):");
  lines.push("");
  lines.push("```");
  lines.push(meta.verify_command);
  lines.push("```");
  lines.push("");
  lines.push("## Budgets");
  lines.push("");
  if (meta.budgets === null) {
    lines.push("- No budgets set in `.osstack/policy.yaml`.");
  } else {
    lines.push(`- max_iterations: ${meta.budgets.max_iterations ?? "-"}`);
    lines.push(`- max_runtime_minutes: ${meta.budgets.max_runtime_minutes ?? "-"}`);
    lines.push(`- max_cost_usd: ${meta.budgets.max_cost_usd ?? "-"}`);
  }
  lines.push("");
  lines.push("## Allowed change categories");
  lines.push("");
  lines.push(
    meta.allowed_categories.length > 0
      ? meta.allowed_categories.map((c) => `- ${c}`).join("\n")
      : "- (none declared in policy)",
  );
  lines.push("");
  lines.push("## Forbidden change categories");
  lines.push("");
  lines.push(
    meta.forbidden_categories.length > 0
      ? meta.forbidden_categories.map((c) => `- ${c}`).join("\n")
      : "- (none declared in policy)",
  );
  lines.push("");
  lines.push("## Approval points");
  lines.push("");
  lines.push(`1. Owner approval — \`osstack control ${meta.contract_id} approve\``);
  lines.push("   (records a protocol ApprovalDecision; then run the authorized `osstack deliver …`).");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

// ── help ─────────────────────────────────────────────────────────────────────

function printStartHelp(out: (line: string) => void): void {
  out(`osstack start — open a contract-gated delivery

  osstack start "<goal>" --repo-id <id> [--registry P] [--workspace P] [--risk low|medium|high] [--json]

Requires the repo registered and a valid .osstack/repo.yaml. Writes an
Execution Contract to .osstack/contracts/<id>.md in the target repo, tracks it
on the "contracts" kanban board, and records a pending approval. Policy mode
observe is refused (exit 2). --json emits a protocol AgentCommandResult with
status needs_approval and the exact \`control approve\` next action.`);
}

function printControlHelp(out: (line: string) => void): void {
  out(`osstack control — drive a contract's approval lifecycle

  osstack control <contract-id> status                       Render the contract + approval trail
  osstack control <contract-id> approve [--actor human:id]   Record approval, emit the deliver command
  osstack control <contract-id> revise --reason <text>       Send back for edits
  osstack control <contract-id> stop --reason <text>         Abandon the contract
      [--json]

approve records a protocol ApprovalDecision (human actors only, A-004) and
emits the ready-to-run \`osstack deliver …\` — it does NOT spawn delivery.`);
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
