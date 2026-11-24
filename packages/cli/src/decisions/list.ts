import { createHash } from "node:crypto";
import { z } from "zod";
import { REFRESHABLE_STOP_REASONS, type DecisionQueries, type DecisionRow, type EngineeringPrincipal } from "@osstack/core";
import { DecisionSource, DecisionsListParams, DecisionsListResult, PendingDecision, SessionDecision } from "@osstack/protocol";
import { redactBridge } from "../contained-mission-redact.js";

const Cursor = z.object({ source: DecisionSource, id: z.string().min(1).max(1024), binding: z.string().length(64) }).strict();
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const summary = (text: string) => redactBridge(text).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ").trim().slice(0, 240);
const command = (name: string, ...required_params: string[]) => ({ name, required_params });

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function hasLocalRepair(details: string): boolean {
  try { return isObject(JSON.parse(details)?.local_failure_repair); }
  catch { return false; }
}

function loopReportSummary(details: string, fallback: string): string {
  let payload: unknown;
  try { payload = JSON.parse(details); }
  catch { return fallback; }
  if (!isObject(payload) || payload.reason_code !== "report_invalid") return fallback;
  if (payload.task_id !== undefined && typeof payload.task_id !== "string") return fallback;

  const role = payload.role === "builder" || payload.role === "reviewer" ? `${payload.role} ` : "";
  // Redact before shortening so the cut cannot leave a partial secret in the notice.
  const id = typeof payload.task_id === "string" ? summary(payload.task_id).slice(0, 64) : "";
  const reason = typeof payload.reason === "string" ? payload.reason.trim() : "";
  return `The ${role}report was invalid and could not be repaired. The work is kept. See the completed task${id ? ` ${id}` : ""} in LOOP-STATE.json. Choosing retry redoes the work.${reason ? ` — ${reason}` : ""}`;
}

export function decisionItem(source: DecisionSource, row: DecisionRow): PendingDecision {
  let allowed_answers: string[] = [];
  let answer_command: PendingDecision["answer_command"] = command("mission.decide", "mission_id", "decision");
  let description = row.summary ?? row.state;
  let requires_local_signature = false;
  switch (source) {
    case "session": {
      const decision = SessionDecision.parse(JSON.parse(row.details_json));
      allowed_answers = decision.choices.length ? decision.choices.map(c => c.choice_id) : ["free_text"];
      requires_local_signature = ["risk_approval", "task_authorization"].includes(decision.continuation?.gate_kind ?? "");
      // Existing host routes reject these gates until a signed approval path is supplied.
      if (requires_local_signature) allowed_answers = [];
      answer_command = command("attention.answer", "scope_id", "item_id", "action_id", "revision", "content_hash", "text", "takeover");
      break;
    }
    case "contained_mission": {
      allowed_answers = ["abandon"];
      if (row.state === "stop_unknown") allowed_answers.push("retry_stop_check");
      if (row.state === "needs_reconciliation") {
        if (!hasLocalRepair(row.details_json)) allowed_answers.push("discard_changes");
        allowed_answers.push("adopt_worktree");
      }
      if (row.state === "awaiting_decision") {
        const reason = row.reason ?? "";
        const spec = JSON.parse(row.details_json) as { publish_target?: unknown; ci_repair?: unknown; local_failure_repair?: unknown };
        const local = spec.local_failure_repair;
        if (isObject(local) && reason === "publication_pending") {
          allowed_answers.push("approve_local_failure_repair");
          requires_local_signature = true;
          answer_command = { ...command("mission.decide", "mission_id", "decision"),
            alternatives: [command("mission approve-local-failure-repair", "--mission", "--candidate")] };
        }
        if (local === undefined && reason === "repair_cycles_exhausted") allowed_answers.push("extra_repair");
        if (isObject(spec.publish_target) && reason === "budget_exhausted") allowed_answers.push("resume_budget");
        if (isObject(spec.publish_target) && reason.startsWith("grant_stopped:")) allowed_answers.push("resume_grant");
        if (reason === "workspace_recovered") allowed_answers.push("resume_workspace");
        if (local === undefined && !spec.ci_repair && (reason === "publication_pending" || reason.startsWith("publication_failed") || reason.startsWith("revalidation_failed"))) allowed_answers.push("approve_publication");
      }
      break;
    }
    case "ci_repair":
      allowed_answers = ["approve_ci_repair", "abandon"];
      answer_command = { ...command("mission.approve_ci_repair", "mission_id", "candidate"), alternatives: [command("mission.decide", "mission_id", "decision")] };
      break;
    case "revision_chain": {
      const alternatives = [];
      // Shadow chains have no answering surface. The live service rejects them.
      if (row.kind === "live") {
        const facts = JSON.parse(row.details_json) as { uncertain?: number; unsettled?: number; recheck?: { mission_id: string; attempt: number } };
        const recheck = command("mission recheck-rearm", "--mission", "--attempt");
        if (facts.recheck && row.state !== "ready_for_human" && row.state !== "awaiting_decision") {
          requires_local_signature = true;
          description = `recheck waiting: attempt ${facts.recheck.attempt} of 3, mission ${facts.recheck.mission_id}`;
          answer_command = { ...command("mission.chain_decide", "chain_id", "decision"), alternatives: [recheck] };
          break;
        }
        allowed_answers = ["abandon", "takeover"];
        if (facts.uncertain) allowed_answers.push("reconcile");
        if (!facts.unsettled && (row.state === "ready_for_human" || REFRESHABLE_STOP_REASONS.has(row.reason ?? ""))) {
          alternatives.push(command("mission grant-revisions", "--chain"));
          allowed_answers.push("grant_revisions"); requires_local_signature = true;
        }
        if (facts.recheck) alternatives.push(recheck);
      }
      answer_command = { ...command("mission.chain_decide", "chain_id", "decision"),
        ...(alternatives.length ? { alternatives } : {}),
      };
      break;
    }
    case "autonomy":
      allowed_answers = ["approve", "reject"]; requires_local_signature = true;
      answer_command = { ...command("autonomy approve", "run_id", "--decision"), alternatives: [command("autonomy reject", "run_id", "--decision")] };
      break;
    case "hermes":
      allowed_answers = [row.kind === "approval" ? "choice" : "free_text"];
      answer_command = row.kind === "approval" ? command("approval.resolve", "approval_id", "choice") : command("clarify.resolve", "clarify_id", "answer");
      break;
    case "loop":
      if (row.kind === "loop") description = loopReportSummary(row.details_json, description);
      allowed_answers = [row.kind === "loop_card" ? "approve" : "retry"];
      answer_command = row.kind === "loop_card" ? command("cockpit approve", "card_id") : command("cockpit retry", "task_id", "--workspace");
      break;
  }
  return {
    source, source_id: row.id, scope_id: row.scope_id, waiting_since: row.waiting_since,
    summary: summary(description), allowed_answers, answer_command, requires_local_signature,
    source_revision: row.revision ?? digest(row),
  };
}

/** Re-authenticate on each page. No host recovery, timer, notifier or write port is reachable. */
export async function listDecisions(
  queries: DecisionQueries, input: unknown,
  authenticate?: (credential: unknown) => EngineeringPrincipal,
): Promise<DecisionsListResult> {
  const parsed = DecisionsListParams.safeParse(input ?? {});
  if (!parsed.success) throw Error("bad_request");
  const params = parsed.data;
  let read_scopes: readonly string[] = [];
  let accessError: "permission_denied" | "source_unavailable" | undefined;
  try {
    if (!authenticate) accessError = "source_unavailable";
    else read_scopes = authenticate(params.credential).read_scopes;
  } catch { accessError = "permission_denied"; }
  const binding = digest([params.scope_id ?? null, [...read_scopes].sort(), accessError ?? null]);
  let after: z.infer<typeof Cursor> | undefined;
  if (params.cursor) {
    try {
      after = Cursor.parse(JSON.parse(Buffer.from(params.cursor, "base64url").toString("utf8")));
      if (after.binding !== binding) throw Error("binding");
    } catch { throw Error("bad_cursor"); }
  }
  const sources = DecisionSource.options;
  const failures: DecisionsListResult["failures"] = [];
  const items: PendingDecision[] = [];
  for (const source of sources) {
    if (accessError && ["contained_mission", "ci_repair", "revision_chain"].includes(source)) {
      failures.push({ source, code: accessError }); continue;
    }
    try {
      // Each source returns at most limit+1. Previous sources are still probed
      // so failures are reported consistently on every page.
      const previous = after && sources.indexOf(source) < sources.indexOf(after.source);
      const rows = queries[source]({ read_scopes, after: source === after?.source ? after.id : "", limit: previous ? 1 : params.limit + 1,
        ...(params.scope_id ? { scope_id: params.scope_id } : {}) });
      if (!previous) {
        // A corrupt row fails only its own source. Never return a partial source page.
        const mapped = rows.map(row => PendingDecision.parse(decisionItem(source, row)));
        items.push(...mapped);
      }
    } catch { failures.push({ source, code: "read_failed" }); }
  }
  const page = items.slice(0, params.limit);
  const last = page.at(-1);
  const next_cursor = items.length > params.limit && last
    ? Buffer.from(JSON.stringify({ source: last.source, id: last.source_id, binding })).toString("base64url") : null;
  return DecisionsListResult.parse({ items: page, failures, next_cursor });
}
