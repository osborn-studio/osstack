import { createHmac } from "node:crypto";
import type Database from "better-sqlite3";
import { DecisionProbes, type DecisionQueries, type EngineeringPrincipal } from "@osstack/core";
import { DecisionsAnswerParams, DecisionsAnswerResult, SessionDecision } from "@osstack/protocol";
import { decisionItem } from "./list.js";

type Ports = {
  db: Database.Database;
  queries: DecisionQueries;
  authenticate: (credential: unknown) => EngineeringPrincipal;
  forward: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  resolveHermes: (method: "approval.resolve" | "clarify.resolve", params: Record<string, unknown>) => unknown;
};
const classify = (code: string): DecisionsAnswerResult["outcome"] => /conflict|owner_mismatch|already_reserved|already_resolved/.test(code) ? "conflict"
  : /stale|source_changed|source_missing/.test(code) ? "stale" : "refused";

/** Routing only. Source stores retain all admission, transition and execution authority. */
export async function answerDecision(ports: Ports, input: unknown): Promise<DecisionsAnswerResult> {
  let current: DecisionsAnswerResult["current"] = { state: "unknown", item: null };
  const result = (outcome: DecisionsAnswerResult["outcome"], code: string | null = null, accepted = false, replay = false, local_command?: string) =>
    DecisionsAnswerResult.parse({ accepted, replay, outcome, code, current, ...(local_command ? { local_command } : {}) });
  const parsed = DecisionsAnswerParams.safeParse(input);
  if (!parsed.success) return result("refused", "bad_request");
  const p = parsed.data;
  try {
    const actor = ports.authenticate(p.credential);
    const engineering = ["contained_mission", "ci_repair", "revision_chain"].includes(p.source);
    let scope: string | undefined;
    if (engineering) {
      const row = (p.source === "revision_chain"
        ? ports.db.prepare("SELECT m.scope_id FROM engineering_revision_chains c JOIN engineering_contained_missions m ON m.mission_id=c.root_mission_id WHERE c.chain_id=?")
        : ports.db.prepare("SELECT scope_id FROM engineering_contained_missions WHERE mission_id=?")).get(p.source_id) as { scope_id: string } | undefined;
      scope = row?.scope_id;
      if (!scope || !actor.read_scopes.includes(scope) || !actor.write_scopes.includes(scope)) return result("refused", "permission_denied");
    }
    const probes = p.source === "probe" ? new DecisionProbes(ports.db) : undefined;
    const refresh = () => {
      const row = ports.queries[p.source]({ read_scopes: actor.read_scopes, after: p.source_id, inclusive: true, limit: 1 })[0];
      const item = row?.id === p.source_id ? decisionItem(p.source, row) : null;
      let state = item ? row!.state : "not_found";
      const lookup = p.source === "session" ? ["attention_items", "item_id"]
        : p.source === "revision_chain" ? ["engineering_revision_chains", "chain_id"]
        : engineering ? ["engineering_contained_missions", "mission_id"] : null;
      if (!item && lookup) state = (ports.db.prepare(`SELECT state FROM ${lookup[0]} WHERE ${lookup[1]}=?`).get(p.source_id) as { state: string } | undefined)?.state ?? state;
      if (p.source === "hermes") {
        const approval = p.source_id.startsWith("approval:");
        state = (ports.db.prepare(`SELECT status FROM ${approval ? "approvals" : "clarifies"} WHERE ${approval ? "approval_id" : "clarify_id"}=?`).get(p.source_id.slice(p.source_id.indexOf(":") + 1)) as { status: string } | undefined)?.status ?? "not_found";
      }
      if (probes && !item) {
        const probe = probes.status(p.source_id, Date.now());
        state = probe?.expired ? "expired" : probe?.state ?? "not_found";
      }
      current = { state, item }; return item;
    };
    const item = probes ? null : refresh();
    if (engineering && p.answer === "rearm_local_failure_recheck") return result("local_only", "local_only", false, false, "mission recheck-rearm");
    if (engineering && p.answer === "approve_local_failure_repair") {
      return result("local_only", "local_only", false, false, "mission approve-local-failure-repair");
    }
    if (engineering && (p.answer === "grant_revisions" || p.answer === "grant_local_failure_repair")) {
      return result("local_only", "local_only", false, false, "mission grant-revisions");
    }
    if (p.source === "loop" || p.source === "autonomy" || (p.source === "session" && item?.requires_local_signature)) {
      return result("local_only", "local_only", false, false, p.answer === "grant_revisions" ? "mission grant-revisions" : p.source === "session" ? "attention answer" : p.source === "autonomy" ? (p.answer === "reject" ? "autonomy reject" : "autonomy approve") : item?.answer_command.name ?? "cockpit retry");
    }
    if (p.source === "revision_chain") {
      if (item && item.source_revision !== p.source_revision) return result("stale", "stale_revision");
      // chainDecide awaits remote reconcile/cancel work. Its own revision CAS does not
      // accept a client revision or receipt key. A wrapper transaction cannot cover it.
      return result("not_answerable", "idempotency_unsupported", false, false, "mission chain-decide");
    }
    const only = (...keys: string[]) => { if (Object.keys(p.params).some(k => !keys.includes(k))) throw Error("bad_request"); };
    if (probes) {
      const digest = createHmac("sha256", p.credential).update(JSON.stringify([
        p.source_id, p.answer, p.source_revision, actor.principal_id, actor.client_session_id,
      ])).digest("hex");
      const revision = /^[1-9][0-9]*$/.test(p.source_revision) ? Number(p.source_revision) : NaN;
      const { code } = probes.answer({
        probe_id: p.source_id, answer: p.answer, answer_id: p.answer_id, digest,
        actor: actor.principal_id, expected_revision: revision, now: Date.now(), hasParams: Object.keys(p.params).length > 0,
      });
      refresh();
      if (code === "applied" || code === "replay") return result("applied", null, true, code === "replay");
      return result(classify(code), code);
    }
    if (p.source === "hermes") {
      const approval = p.source_id.startsWith("approval:");
      if (!approval && !p.source_id.startsWith("clarify:")) return result("refused", "bad_request");
      only(approval ? "choice" : "text");
      const value = p.params[approval ? "choice" : "text"];
      if (p.answer !== (approval ? "choice" : "free_text") || !value?.trim()) return result("refused", "bad_request");
      // A producer can supply request payload fields. Authenticate router-owned
      // receipt metadata before treating any such field as a successful answer.
      const digest = createHmac("sha256", p.credential).update(JSON.stringify([p.source_id, p.answer, value, p.source_revision, actor.principal_id, actor.client_session_id])).digest("hex");
      return ports.db.transaction(() => {
        const prior = ports.db.prepare("SELECT payload_json FROM events WHERE type IN ('approval.requested','clarify.requested') AND json_extract(payload_json,'$.decisions_answer.answer_id')=? LIMIT 1").get(p.answer_id) as { payload_json: string } | undefined;
        if (prior) {
          refresh(); const receipt = (JSON.parse(prior.payload_json) as { decisions_answer: { digest: string } }).decisions_answer;
          return receipt.digest === digest && current.state !== "pending" ? result("applied", null, true, true) : result("conflict", "answer_id_conflict");
        }
        const live = refresh();
        if (current.state !== "pending") return result("conflict", "already_resolved");
        if (!live || live.source_revision !== p.source_revision) return result("stale", "stale_revision");
        const id = p.source_id.slice(p.source_id.indexOf(":") + 1);
        const table = approval ? "approvals" : "clarifies"; const key = approval ? "approval_id" : "clarify_id";
        const run = ports.db.prepare(`SELECT r.run_id,r.session_id FROM ${table} h JOIN runs r ON r.run_id=h.run_id WHERE h.${key}=?`).get(id) as { run_id: string; session_id: string };
        const request = ports.db.prepare("SELECT event_id,json_extract(payload_json,'$.decisions_answer') receipt FROM events WHERE run_id=? AND type=? AND json_extract(payload_json,?)=? ORDER BY seq LIMIT 1")
          .get(run.run_id, approval ? "approval.requested" : "clarify.requested", `$.${key}`, id) as { event_id: string; receipt: unknown } | undefined;
        if (!request) return result("not_answerable", "idempotency_unsupported", false, false, approval ? "approval.resolve" : "clarify.resolve");
        if (request.receipt !== null) return result("conflict", "answer_receipt_conflict");
        ports.resolveHermes(approval ? "approval.resolve" : "clarify.resolve", { [key]: id, [approval ? "choice" : "answer"]: value, actor: actor.principal_id });
        // Keep the producer's sequence intact. The existing request event can
        // carry receipt metadata; no source event is inserted or renumbered.
        ports.db.prepare("UPDATE events SET payload_json=json_set(payload_json,'$.decisions_answer',json(?)) WHERE event_id=?")
          .run(JSON.stringify({ digest, answer_id: p.answer_id, source_id: p.source_id, actor: actor.principal_id, client_session_id: actor.client_session_id }), request.event_id);
        refresh(); return result("applied", null, true);
      }).immediate();
    }
    let method: string; let params: Record<string, unknown>;
    if (p.source === "session") {
      only("text", "takeover", "takeover_grant_id");
      const row = ports.db.prepare("SELECT scope_id,decision_json FROM attention_items WHERE item_id=?").get(p.source_id) as { scope_id: string; decision_json: string } | undefined;
      if (!row) return result("refused", "not_found");
      const decision = SessionDecision.parse(JSON.parse(row.decision_json));
      if (["risk_approval", "task_authorization"].includes(decision.continuation?.gate_kind ?? "")) return result("local_only", "local_only", false, false, "attention answer");
      const [revision, content_hash] = p.source_revision.split(":");
      if (!/^[1-9][0-9]*:[a-f0-9]{64}$/.test(p.source_revision)) return result("stale", "stale_item");
      const choice = decision.choices.find(c => c.choice_id === p.answer);
      if (decision.choices.length ? !choice || p.params.text !== undefined : p.answer !== "free_text") return result("refused", "invalid_answer");
      if (p.params.takeover !== undefined && !["true", "false"].includes(p.params.takeover)) return result("refused", "bad_request");
      if (p.params.takeover_grant_id !== undefined && (!p.params.takeover_grant_id || p.params.takeover_grant_id.length > 256)) return result("refused", "bad_request");
      method = "attention.answer";
      params = { scope_id: row.scope_id, item_id: p.source_id, action_id: p.answer_id, revision: Number(revision), content_hash, text: choice?.label ?? p.params.text ?? "", takeover: p.params.takeover === "true", actor: JSON.stringify([actor.principal_id, actor.client_session_id]), answer_kind: p.answer, ...(p.params.takeover_grant_id ? { takeover_grant_id: p.params.takeover_grant_id } : {}) };
    } else {
      const ci = p.source === "ci_repair" && p.answer === "approve_ci_repair";
      only(...(ci ? ["candidate"] : []));
      if (!/^[1-9][0-9]*$/.test(p.source_revision) || !Number.isSafeInteger(Number(p.source_revision))) return result("stale", "stale_revision");
      method = ci ? "mission.approve_ci_repair" : "mission.decide";
      params = { credential: p.credential, mission_id: p.source_id, decision_id: p.answer_id, expected_revision: Number(p.source_revision), ...(ci ? { candidate: p.params.candidate } : { decision: p.answer }) };
    }
    try {
      const response = await ports.forward(method, params) as Record<string, unknown>;
      refresh();
      const code = typeof response.code === "string" ? response.code : null;
      const replay = response.replay === true;
      const unknown = response.outcome === "unknown" || ["uncertain", "in_flight", "needs_reconciliation"].includes(String(response.state));
      return result(code ? classify(code) : unknown ? "unknown" : response.outcome === "accepted" || response.state === "reserved" || (response.accepted === true && response.mission !== undefined && response.state === undefined) ? "accepted" : "applied", code, response.accepted !== false, replay);
    } catch (error) { refresh(); throw error; }
  } catch (error) {
    const code = error instanceof Error && /^[A-Za-z_]{1,128}$/.test(error.message) ? error.message : "decisions_unavailable";
    return result(classify(code), code);
  }
}
