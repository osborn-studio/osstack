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
//       Contract markdown to a git-tracked path in the target repo
//       (.osstack/contracts/<id>.md — review the TBDs and commit it), tracks
//       it as a kanban card on the "contracts" board, and records a pending
//       approval. `--json` ⇒ a strict protocol AgentCommandResult with status
//       `needs_approval`, an ApprovalRequest, and the exact `control approve`
//       invocation as next_actions[0].
//
//   osstack control <contract-id> status|approve|revise|stop [--json]
//       approve: records a protocol ApprovalDecision (actor from --actor,
//       default human:owner; AGENT actors are an authority denial per A-004 ⇒
//       policy_denied / blocked / exit 2), flips the contract to approved, and
//       emits the ready-to-run deliver command. revise/stop: update the
//       contract status with a --reason. status: renders the contract + the
//       full append-only approval trail + linked evidence.
//
// AUTHORITY MODEL (cross-review B2 ruling): the `contract_approvals` row is
// the AUTHORITATIVE lifecycle state — every guard and every rendered status
// derives SOLELY from it. The kanban card on the "contracts" board is a
// best-effort PROJECTION for board visibility: a failed card move (e.g. the
// card was dragged out-of-band) degrades to a warning, never a failure.
// Projection mapping:
//   pending ⇒ triage    approved ⇒ ready
//   revising ⇒ blocked  stopped  ⇒ archived

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KanbanRepository, contractApprovalRowToDecision, contractApprovalRowToRequest, getContractApprovalByContract, insertContractApproval, listContractDecisions, loadPolicyProfile, loadRepoConfig, recordContractDecision, withWrite, type CardRow, type ContractApprovalRow, type ContractApprovalStatus, type PolicyBudgets, type PolicyProfile, type RepoConfig } from "@osstack/core";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";
import { PROTOCOL_VERSION, type AgentCommandResult } from "@osstack/protocol";
import { readRepoRegistry } from "@osstack/supervisor";
import { osstackHome } from "./paths.js";
import { flag, hasFlag, resolveRegistryPath } from "./supervisor-cli-support.js";

const CONTRACTS_BOARD = "contracts";

export interface StartControlDeps {
  now?: () => Date;
  /** Contract/approval/decision id generator (tests pin it for determinism). */
  genId?: (prefix: string) => string;
  out?: (line: string) => void;
  err?: (line: string) => void;
}

/** Human/protocol-facing contract lifecycle names (approval row is the source). */
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

// ── lifecycle (approval row = authority; card = projection) ──────────────────

/** Approval-row status -> the lifecycle name rendered to humans/agents. */
function contractStatus(approval: Pick<ContractApprovalRow, "status">): ContractStatus {
  const map: Record<ContractApprovalStatus, ContractStatus> = {
    pending: "needs_approval",
    approved: "approved",
    revising: "revising",
    stopped: "stopped",
  };
  return map[approval.status];
}

/** Lifecycle -> the kanban card column the projection aims for. */
const CONTRACT_TO_CARD: Record<ContractStatus, CardStatus> = {
  needs_approval: "triage",
  approved: "ready",
  revising: "blocked",
  stopped: "archived",
};

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

/**
 * POSIX single-quote escaping (B1): inside '…' NOTHING is interpreted by the
 * shell — no $(…), no backticks, no $VAR — so an embedded goal/verify string
 * cannot execute on paste. An embedded single quote closes the quote, emits an
 * escaped quote, and reopens: ' -> '\''.
 *
 * Exported so other command surfaces (R2.4 `daily` dispatchable next_actions)
 * reuse the ONE audited quoting helper instead of re-implementing it.
 */
export function shQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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

/** `--actor human:owner` -> { type, id }. */
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

/**
 * The raw argv the approved contract authorizes (B1): agent consumers use this
 * array verbatim (e.g. spawn("osstack", deliver_args)) and never parse a shell
 * string. Element 0 is the osstack subcommand.
 */
function buildDeliverArgs(meta: ContractMeta): string[] {
  const argv = [
    "deliver",
    meta.goal,
    "--workspace",
    meta.repo_path,
    "--verify",
    meta.verify_command,
  ];
  const iters = meta.budgets?.max_iterations;
  if (iters !== undefined) argv.push("--max-iter", String(iters));
  return argv;
}

/**
 * The human-facing paste-safe `osstack deliver …` string: every interpolated
 * field is POSIX single-quoted (B1) so hostile goal/verify text cannot execute.
 */
function buildDeliverCommand(meta: ContractMeta): string {
  const argv = buildDeliverArgs(meta);
  const rendered = argv.map((token, i) => {
    // Flags and the subcommand are fixed vocabulary; values get quoted.
    if (i === 0 || token.startsWith("--")) return token;
    if (/^\d+$/.test(token)) return token;
    return shQuote(token);
  });
  return ["osstack", ...rendered].join(" ");
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

/**
 * Best-effort card projection (B2): the approval row already carries the
 * authoritative state, so a failed card move (illegal transition after an
 * out-of-band drag, missing card, DB hiccup) degrades to a warning string —
 * it never fails the control action.
 */
function projectCard(
  kanban: KanbanRepository,
  contract_id: string,
  to: CardStatus,
  opts: { blocked_reason?: string; actor?: string },
  comment: { author: string; body: string },
): string | undefined {
  try {
    kanban.moveCard(contract_id, to, opts);
    kanban.addComment(contract_id, comment.author, comment.body);
    return undefined;
  } catch (e) {
    return `kanban card projection failed (${errMessage(e)}) — the approval record is authoritative; the board card may be out of sync`;
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

  // 4. Assemble the contract.
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

  // 5. Track it FIRST, atomically (S3): the kanban card and the pending
  //    approval commit in ONE transaction (nested withWrite = savepoints), so a
  //    crash cannot leave a card without an approval or vice versa. DB errors
  //    become a clean `internal` result.
  const warnings: string[] = [];
  try {
    const home = osstackHome();
    await mkdir(home, { recursive: true });
    const dbPath = join(home, "state.db");
    const db = openDb({ path: dbPath });
    try {
      const kanban = new KanbanRepository(db, dbPath, () => now.getTime() / 1000);
      withWrite(db, dbPath, () => {
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
      });
    } finally {
      db.close();
    }
  } catch (e) {
    return emitFailure(emit, json, "internal", `failed to record the contract: ${errMessage(e)}`);
  }

  // 6. Write the human-editable markdown AFTER the DB commit. DOCUMENTED
  //    CHOICE (S3): if this write fails, the contract record already exists
  //    and is NOT rolled back — the DB is the authority; the markdown is the
  //    human view. We degrade to a warning telling the user how to proceed.
  try {
    const markdown = renderContractMarkdown(meta, repoConfig, policy, now, approvalId);
    await mkdir(join(entry.path, ".osstack", "contracts"), { recursive: true });
    await writeFile(contractPath, markdown, "utf8");
  } catch (e) {
    warnings.push(
      `contract record ${contractId} created, but writing ${contractPath} failed (${errMessage(e)}) — fix the path and re-run start, or 'osstack control ${contractId} stop --reason unwritable' to abandon it`,
    );
  }

  // 7. Output.
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
        ...(warnings.length > 0 ? { warnings } : {}),
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
    for (const w of warnings) out(`  warning:  ${w}`);
    out("");
    out("Review the TBD non-goals / acceptance criteria, commit the contract file, then approve:");
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
  const genId = deps.genId ?? defaultGenId;
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

  // B2: unexpected DB/kanban exceptions anywhere below become a clean
  // `internal` AgentCommandResult + exit 1, never a stack trace.
  try {
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
      // The approval row is the authoritative lifecycle record (B2).
      const approval = getContractApprovalByContract(db, contractId);
      if (approval === undefined) {
        return emitFailure(emit, json, "not_found", `contract "${contractId}" has no approval record`);
      }

      const ctx: ControlContext = { emit, json, kanban, db, dbPath, now, genId, meta, approval };
      switch (action) {
        case "status":
          return renderStatus(ctx);
        case "approve":
          return doApprove(ctx, args);
        case "revise":
          return doRevise(ctx, args);
        case "stop":
          return doStop(ctx, args);
      }
    } finally {
      db.close();
    }
  } catch (e) {
    return emitFailure(emit, json, "internal", `control ${action} failed: ${errMessage(e)}`);
  }
  return 0;
}

interface ControlContext {
  emit: Required<Pick<StartControlDeps, "out" | "err">>;
  json: boolean;
  kanban: KanbanRepository;
  db: import("better-sqlite3").Database;
  dbPath: string;
  now: Date;
  genId: (prefix: string) => string;
  meta: ContractMeta;
  approval: ContractApprovalRow;
}

function doApprove(ctx: ControlContext, args: string[]): number {
  const { emit, json, meta, approval } = ctx;
  const actorRaw = flag(args, "--actor") ?? "human:owner";
  const actor = parseActor(actorRaw);
  if ("error" in actor) {
    return emitFailure(emit, json, "bad_request", actor.error);
  }
  // A-004: an agent actor approving a contract is an AUTHORITY denial, not a
  // malformed request — policy_denied / blocked / exit 2 (agent delegation via
  // allowed_auto_changes is a later increment).
  if (actor.type === "agent") {
    return emitFailure(
      emit,
      json,
      "policy_denied",
      `agent actor "${actorRaw}" cannot approve a contract (A-004): approval requires a human actor`,
    );
  }
  if (approval.status !== "pending" && approval.status !== "revising") {
    return emitFailure(
      emit,
      json,
      "conflict",
      `contract "${meta.contract_id}" is not awaiting approval (status: ${contractStatus(approval)})`,
    );
  }

  const reason = flag(args, "--reason");
  const resolved = recordContractDecision(ctx.db, ctx.dbPath, {
    approval_id: approval.approval_id,
    contract_id: meta.contract_id,
    action: "approve",
    actor_type: actor.type,
    actor_id: actor.id,
    decided_at: ctx.now.getTime() / 1000,
    reason: reason ?? null,
    decision_id: ctx.genId("cd"),
  });
  const warning = projectCard(
    ctx.kanban,
    meta.contract_id,
    CONTRACT_TO_CARD.approved,
    { actor: `${actor.type}:${actor.id}` },
    { author: `${actor.type}:${actor.id}`, body: `approved${reason ? `: ${reason}` : ""}` },
  );

  const deliverCommand = buildDeliverCommand(meta);
  const deliverArgs = buildDeliverArgs(meta);
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
        deliver_args: deliverArgs,
        ...(warning !== undefined ? { warnings: [warning] } : {}),
      },
      evidence_refs: [{ kind: "report", ref: meta.contract_path }],
      next_actions: [{ command: "deliver.run", reason: deliverCommand }],
    };
    emit.out(JSON.stringify(result, null, 2));
  } else {
    emit.out(`Contract ${meta.contract_id} approved by ${actor.type}:${actor.id}.`);
    if (warning !== undefined) emit.out(`  warning: ${warning}`);
    emit.out("Run the authorized delivery when ready:");
    emit.out(`  ${deliverCommand}`);
  }
  return 0;
}

function doRevise(ctx: ControlContext, args: string[]): number {
  const { emit, json, meta, approval } = ctx;
  const reason = flag(args, "--reason");
  if (reason === undefined || reason.trim() === "") {
    return emitFailure(emit, json, "bad_request", "revise requires --reason <text>");
  }
  const actorRaw = flag(args, "--actor") ?? "human:owner";
  const actor = parseActor(actorRaw);
  if ("error" in actor) {
    return emitFailure(emit, json, "bad_request", actor.error);
  }
  if (approval.status === "stopped") {
    return emitFailure(emit, json, "conflict", `contract "${meta.contract_id}" is stopped and cannot be revised`);
  }
  recordContractDecision(ctx.db, ctx.dbPath, {
    approval_id: approval.approval_id,
    contract_id: meta.contract_id,
    action: "revise",
    actor_type: actor.type,
    actor_id: actor.id,
    decided_at: ctx.now.getTime() / 1000,
    reason,
    decision_id: ctx.genId("cd"),
  });
  const warning = projectCard(
    ctx.kanban,
    meta.contract_id,
    CONTRACT_TO_CARD.revising,
    { blocked_reason: reason, actor: actorRaw },
    { author: actorRaw, body: `revise requested: ${reason}` },
  );

  if (json) {
    const result: AgentCommandResult = {
      protocol_version: PROTOCOL_VERSION,
      status: "ok",
      result: {
        contract_id: meta.contract_id,
        status: "revising",
        reason,
        ...(warning !== undefined ? { warnings: [warning] } : {}),
      },
      evidence_refs: [{ kind: "report", ref: meta.contract_path }],
      next_actions: [{ command: "control.approve", reason: `osstack control ${meta.contract_id} approve` }],
    };
    emit.out(JSON.stringify(result, null, 2));
  } else {
    emit.out(`Contract ${meta.contract_id} sent back for revision: ${reason}`);
    if (warning !== undefined) emit.out(`  warning: ${warning}`);
    emit.out(`  edit ${meta.contract_path}, then: osstack control ${meta.contract_id} approve`);
  }
  return 0;
}

function doStop(ctx: ControlContext, args: string[]): number {
  const { emit, json, meta, approval } = ctx;
  const reason = flag(args, "--reason");
  if (reason === undefined || reason.trim() === "") {
    return emitFailure(emit, json, "bad_request", "stop requires --reason <text>");
  }
  const actorRaw = flag(args, "--actor") ?? "human:owner";
  const actor = parseActor(actorRaw);
  if ("error" in actor) {
    return emitFailure(emit, json, "bad_request", actor.error);
  }
  if (approval.status === "stopped") {
    return emitFailure(emit, json, "conflict", `contract "${meta.contract_id}" is already stopped`);
  }
  recordContractDecision(ctx.db, ctx.dbPath, {
    approval_id: approval.approval_id,
    contract_id: meta.contract_id,
    action: "stop",
    actor_type: actor.type,
    actor_id: actor.id,
    decided_at: ctx.now.getTime() / 1000,
    reason,
    decision_id: ctx.genId("cd"),
  });
  const warning = projectCard(
    ctx.kanban,
    meta.contract_id,
    CONTRACT_TO_CARD.stopped,
    { actor: actorRaw },
    { author: actorRaw, body: `stopped: ${reason}` },
  );

  if (json) {
    const result: AgentCommandResult = {
      protocol_version: PROTOCOL_VERSION,
      status: "ok",
      result: {
        contract_id: meta.contract_id,
        status: "stopped",
        reason,
        ...(warning !== undefined ? { warnings: [warning] } : {}),
      },
      evidence_refs: [{ kind: "report", ref: meta.contract_path }],
    };
    emit.out(JSON.stringify(result, null, 2));
  } else {
    emit.out(`Contract ${meta.contract_id} stopped: ${reason}`);
    if (warning !== undefined) emit.out(`  warning: ${warning}`);
  }
  return 0;
}

function renderStatus(ctx: ControlContext): number {
  const { emit, json, meta, approval } = ctx;
  const status = contractStatus(approval);
  const request = contractApprovalRowToRequest(approval);
  const decision = contractApprovalRowToDecision(approval);
  // S1: the append-only decision history is the trail rendered here; the
  // protocol surfaces above still emit only the LATEST decision.
  const trail = listContractDecisions(ctx.db, meta.contract_id);
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
        approval_trail: trail.map((d) => ({
          decision_id: d.decision_id,
          action: d.action,
          actor: `${d.actor_type}:${d.actor_id}`,
          decided_at: new Date(d.decided_at * 1000).toISOString(),
          ...(d.reason !== null ? { reason: d.reason } : {}),
        })),
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
    for (const d of trail) {
      emit.out(
        `    - ${d.action} by ${d.actor_type}:${d.actor_id} at ${new Date(d.decided_at * 1000).toISOString()}${d.reason !== null ? ` (${d.reason})` : ""}`,
      );
    }
  }
  return 0;
}

// ── contract markdown ────────────────────────────────────────────────────────

/**
 * Render the human-editable Execution Contract. Prose is human display only,
 * never an API surface (ADR-001 D3): the contract_approvals row + state DB
 * card are authoritative; this file is written to a git-tracked path for the
 * human to review, edit, and commit.
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

Requires the repo registered (registry from --registry, or
<--workspace|cwd>/.osstack/repos.json) and a valid .osstack/repo.yaml in the
target repo. Writes an Execution Contract to .osstack/contracts/<id>.md (a
git-tracked path — review the TBDs and commit it), tracks it on the
"contracts" kanban board, and records a pending approval. Policy mode observe
is refused (exit 2). --json emits a protocol AgentCommandResult with status
needs_approval and the exact \`control approve\` next action.`);
}

function printControlHelp(out: (line: string) => void): void {
  out(`osstack control — drive a contract's approval lifecycle

  osstack control <contract-id> status                       Render the contract + approval trail
  osstack control <contract-id> approve [--actor human:id]   Record approval, emit the deliver command
  osstack control <contract-id> revise --reason <text>       Send back for edits
  osstack control <contract-id> stop --reason <text>         Abandon the contract
      [--json]

approve records a protocol ApprovalDecision (human actors only — an agent
actor is refused as policy_denied per A-004) and emits the ready-to-run
\`osstack deliver …\` — it does NOT spawn delivery.`);
}
