import { createHash } from "node:crypto";
import { copyFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  appendEvent, AttentionActions, AttentionStore, ContainedMissionStore, createScratchDirSync,
  DecisionProbes, DecisionQueries, openDb, RevisionChainStore, SessionRepository,
} from "@osstack/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGrantMissionView, RevisionGrantService } from "../contained-mission-grant.js";
import type { ContainedMissionHost } from "../contained-mission-host.js";
import { ContainedMissionService } from "../contained-mission-rpc.js";
import {
  ContainedMissionRunner, GITHUB_CI_SANDBOX, type ContainedMissionPorts, type IdentifiedContainedDecision,
} from "../contained-mission-runner.js";
import { EngineeringAccess } from "../engineering-access.js";
import { answerDecision } from "./answer.js";
import { resolveHermesDecision } from "./hermes-resolve.js";
import { listDecisions } from "./list.js";

const routes = [
  ["contained_mission", "abandon"], ["contained_mission", "extra_repair"],
  ["ci_repair", "approve_ci_repair"], ["ci_repair", "abandon"],
  ["hermes", "choice"], ["hermes", "free_text"], ["session", "free_text"], ["probe", "blue"],
  ["revision_chain", "abandon"], ["revision_chain", "reconcile"],
] as const;
const rejectedApproval = ["hermes", "choice", "rejected"] as const;
type Route = typeof routes[number] | typeof rejectedApproval;
type Point = "P1" | "P2" | "P3" | "P4";
type Db = ReturnType<typeof openDb>;
const credential = "c".repeat(32);
const candidate = "d".repeat(40);
const points = ([source, answer]: Route): Point[] =>
  source === "session" || answer === "extra_repair" || answer === "reconcile" ? ["P1", "P2", "P3", "P4"] : ["P1", "P2", "P4"];

let template: string;
beforeAll(() => {
  template = createScratchDirSync("tests", "decisions-crash-schema");
  const db = openDb({ path: join(template, "empty.db") });
  try {
    // Clone only the closed, migrated schema. Each scenario has independent files and authority.
    db.exec("CREATE TABLE observed_effects (kind TEXT NOT NULL)");
  } finally { db.close(); }
});
afterAll(() => rmSync(template, { recursive: true, force: true }));

function seed(root: string, [source, answer]: Route) {
  const path = join(root, "state.db");
  copyFileSync(join(template, "empty.db"), path);
  const db = openDb({ path });
  db.pragma("synchronous=FULL");
  try {
    db.exec(`INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1);
      INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at)
        VALUES('r','t','s','codex-cli','code','execute',1)`);
    const attention = new AttentionStore(db, path);
    const owner = attention.claimOwner("setup");
    const scope = attention.registerScope(owner, "t", root).scope_id;
    const principal = { principal_id: "human", client_session_id: "desktop", read_scopes: [scope],
      write_scopes: [scope], stop_scopes: [scope], operator_scopes: [scope] };
    writeFileSync(join(root, "authority.json"), JSON.stringify({ version: 1, principals: [
      { ...principal, credential_sha256: createHash("sha256").update(credential).digest("hex") },
    ] }), { mode: 0o600 });

    if (source === "probe") {
      new DecisionProbes(db).create({ created_by: principal.principal_id, now: Date.now() });
    } else if (source === "hermes") {
      const approval = answer === "choice";
      appendEvent(db, path, { event_id: "request", run_id: "r", session_id: "s", seq: 0, created_at: 1, terminal: false,
        type: approval ? "approval.requested" : "clarify.requested",
        payload: approval ? { approval_id: "a", action_summary: "Proceed?", risk: "low" } : { clarify_id: "a", question: "Which?" } });
      db.exec(`CREATE TRIGGER count_resolution AFTER UPDATE OF status ON ${approval ? "approvals" : "clarifies"}
        BEGIN INSERT INTO observed_effects VALUES ('resolution'); END`);
    } else if (source === "session") {
      const decision = { decision_id: "d", question: "Which?", choices: [] };
      db.prepare(`INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,
        resume_supported,version,updated_at,native_session_id) VALUES('s','t','r','codex-cli',?,?,'awaiting_decision',1,1,1,'native')`)
        .run("a".repeat(64), root);
      db.prepare(`INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at)
        VALUES('turn','s',1,'awaiting_decision',?,1,1)`).run(JSON.stringify(decision));
      attention.projectDecision(owner, { scopeId: scope, sessionId: "s", turnId: "turn", sourceVersion: 1, decision, now: 1 });
    } else {
      const store = new ContainedMissionStore(attention, owner);
      const ci = source === "ci_repair";
      const spec = { goal: "repair", branch: "osstack/mission/repair", repo_path: root, worktree_path: root,
        start_commit: "a".repeat(40), base_ref: "main", allowed_paths: ["PROBE_FAIL"], verify: { argv: ci ? [] : ["test"] },
        ...(ci ? { verification_mode: "github_actions", max_repair_cycles: 0,
          publication: { remote: "origin", repository: GITHUB_CI_SANDBOX, base: "main", draft: false },
          ci_repair: { root: "cm_00000000-0000-4000-8000-000000000001", branch: "osstack/mission/root",
            pr: 1, check_run_id: 2, base: "b".repeat(40) } } : {}) };
      let m = store.authorize(principal, { scope_id: scope, spec,
        claim: { repo_identity: "repo", branch: spec.branch, worktree_identity: "worktree" } }, 1);
      if (source === "revision_chain") {
        const chains = new RevisionChainStore(attention, owner);
        const chain = chains.createLiveChain({ root_mission_id: m.mission_id, repository: "owner/repo", pr_number: 1,
          branch: spec.branch, base_ref: "main", published_head: spec.start_commit, published_base: "b".repeat(40),
          trace_id: "trace", grant: { rounds: 2 } }, 1);
        const reserved = chains.reserve(chain.chain_id, chain.revision, { head: chain.published_head,
          review_ids: [1], feedback_digest: "d".repeat(64) }, 2);
        const child = store.authorize(principal, { scope_id: scope, spec: { goal: "child" },
          claim: { repo_identity: "repo", branch: "child", worktree_identity: "child" } }, 2);
        const dispatched = chains.dispatch(chain.chain_id, reserved.chain.revision, chain.published_head, child.mission_id, 2).chain;
        const { intent } = chains.recordIntent(chain.chain_id, dispatched.revision, { kind: "push", branch: chain.branch,
          expected_old_head: chain.published_head, new_head: candidate, expected_base_sha: chain.published_base,
          child_mission_id: child.mission_id }, 2);
        chains.settleIntent(intent.intent_id, "uncertain", 2);
        return;
      }
      const step = (to: typeof m.state, extra: Partial<Parameters<typeof store.transition>[1]> = {}) => {
        m = store.transition(m.mission_id, { if_revision: m.revision, to, event: { kind: to, payload: {} }, ...extra }, 2);
      };
      step("workspace_ready", { event: { kind: "workspace_created", payload: { git_dir: join(root, "git") } } });
      if (ci) {
        step("executing", { expected_head: spec.start_commit });
        m = store.recordStopEvidence(m.mission_id, m.revision, { stop_proof: "test" }, 2);
        step("candidate_ready", { candidate: { head: candidate, tree: "e".repeat(40), diff_digest: "f".repeat(64) } });
        step("verifying");
        m = store.recordStopEvidence(m.mission_id, m.revision, { stop_proof: "test" }, 2);
        step("verified");
      }
      step("awaiting_decision", { event: { kind: "halted", payload: { reason: ci ? "publication_pending" : "repair_cycles_exhausted" } } });
      db.exec(`CREATE TRIGGER count_transition AFTER INSERT ON engineering_contained_events
        WHEN NEW.kind IN ('decision_abandon','ci_repair_approved')
        BEGIN INSERT INTO observed_effects VALUES (NEW.kind); END`);
    }
  } finally { db.close(); }
}

function death(): never { throw Error("injected_death"); }

async function openRouter(root: string, point?: Point) {
  const path = join(root, "state.db");
  const db = openDb({ path });
  db.pragma("synchronous=FULL");
  const attention = new AttentionStore(db, path);
  const owner = attention.claimOwner(point ? "original" : "restarted");
  const actions = new AttentionActions(attention, owner);
  const store = new ContainedMissionStore(attention, owner);
  const access = new EngineeringAccess(join(root, "authority.json"));
  const queries = new DecisionQueries(db);
  const authenticate = (token: unknown) => access.authenticate(token);
  const record = (kind: string) => db.prepare("INSERT INTO observed_effects VALUES (?)").run(kind);
  const executor: ContainedMissionPorts["execute"] = async input => {
    record("execute");
    const launch = { pid: 4242, pgid: 4242, started_at: 1 };
    input.onLaunched(launch);
    // Abandon this process-local continuation forever. The runner has written executor_start.
    if (point === "P3") return new Promise(() => {});
    return { launch, exit_code: 0, signal: null, timed_out: false, cancelled: false,
      stop: { stop_proof: "group_empty+sandbox_inherited", pgid: 4242, signals: [], confirmed_at: 2 },
      patch: { ok: false, reason: "PATCH_MISSING" }, stdout: "", stderr: "", stdout_truncated: false, stderr_truncated: false };
  };
  const unexpected = (): never => { throw Error("unexpected_runner_port"); };
  const denied = { write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" } as const;
  const runner = new ContainedMissionRunner({ store, now: Date.now, execute: executor,
    qualify: async () => ({ qualified: true, version: "test", reasons: [], identity_sha256: null, profile: ":read-only",
      host_observed_writes: [], results: { parent: denied, escaped_child: denied } }),
    createWorkspace: unexpected, resumeWorkspace: unexpected, readFile: unexpected, commit: unexpected,
    cumulativeDiff: unexpected, restoreWorkspace: unexpected, worktreeDiff: unexpected, commitWorktree: unexpected,
    verify: unexpected, publish: unexpected,
  });
  const host = { store, runner, isBusy: () => false,
    decide: (_actor: unknown, id: string, decision: IdentifiedContainedDecision) => runner.decide(id, decision),
  } as unknown as ContainedMissionHost;
  const chains = new RevisionChainStore(attention, owner);
  const grants = new RevisionGrantService({ chains, missions: await createGrantMissionView(store), access,
    registry: { repository: "owner/repo", publisher: [] }, readPr: unexpected, compare: unexpected,
    protectedSetDigest: unexpected, loadIssuer: unexpected, enabled: () => true, now: Date.now,
    cancelChild: async () => { record("cancel"); },
    reconcileReceipt: async chain => {
      record("read");
      if (point === "P3") death();
      const intent = chains.intents(chain.chain_id).find(i => i.kind === "push" && i.state === "uncertain")!;
      chains.settleIntent(intent.intent_id, "confirmed", Date.now());
      return { settled: true };
    },
  });
  const missions = new ContainedMissionService({ grants, host, access, draining: () => false, ackMs: 1,
    githubCi: { start: () => {}, stop: async () => {} } });
  const forward = async (method: string, params: Record<string, unknown>) => {
    if (point === "P1") death();
    let reply: unknown;
    if (method === "attention.answer") {
      const input = params as unknown as Parameters<AttentionActions["reserve"]>[0];
      const prior = actions.replay(input);
      if (prior) return prior;
      const reservation = actions.reserve(input);
      record("send");
      if (point === "P3") death();
      new SessionRepository(db, path).markMessageApplied(reservation.message_id, Date.now() / 1000);
      reply = actions.reconcile(reservation);
    } else {
      reply = await missions.handle(method, params);
      if (point === "P3") death(); // The executor is suspended and the service has acknowledged admission.
    }
    if (point === "P2") death();
    return reply;
  };
  const resolveHermes = (method: "approval.resolve" | "clarify.resolve", params: Record<string, unknown>) => {
    if (point === "P1") death();
    return resolveHermesDecision(db, method, params);
  };
  return { db, list: () => listDecisions(queries, { credential }, authenticate),
    answer: (input: unknown) => answerDecision({ db, queries, authenticate, forward, resolveHermes }, input) };
}

function installFault(db: Db, [source, answer]: Route, point: Point) {
  if (point === "P1" && source === "probe") db.transaction = death;
  if (point === "P2" && (source === "hermes" || source === "probe" || source === "revision_chain")) {
    // Drop the answer transaction’s return value immediately after SQLite commits.
    const transaction = db.transaction.bind(db);
    db.transaction = fn => {
      const tx = transaction(fn);
      return Object.assign(tx.bind(null), tx, { immediate: (...args: Parameters<typeof tx.immediate>) => {
        const value = tx.immediate(...args);
        if (!db.inTransaction) death();
        return value;
      } });
    };
  }
  if (point !== "P4") return;
  const target = source === "session" ? "AFTER INSERT ON attention_actions"
    : source === "probe" ? "AFTER UPDATE ON decision_probes"
    : source === "hermes" ? "AFTER UPDATE OF payload_json ON events WHEN json_type(NEW.payload_json,'$.decisions_answer')='object'"
    : source === "revision_chain" ? `AFTER INSERT ON engineering_revision_chain_events WHEN NEW.kind='${answer === "abandon" ? "chain_answer_accepted" : "chain_answer_effect_started"}'`
    : `AFTER INSERT ON engineering_contained_events WHEN NEW.kind='${answer === "abandon" ? "decision_result"
      : answer === "approve_ci_repair" ? "ci_repair_answer" : "decision_accepted"}'`;
  // TEMP scopes the fault to this connection. All prior writes in admission must roll back.
  db.exec(`CREATE TEMP TRIGGER abort_admission ${target} BEGIN SELECT RAISE(ABORT,'injected_death'); END`);
}

const count = (db: Db, table: string) => db.prepare<[], number>(`SELECT count(*) FROM ${table}`).pluck().get()!;
function eventCounts(db: Db, [source]: Route) {
  if (source === "probe") return db.prepare("SELECT * FROM decision_probes").all();
  const tables = source === "session" ? ["session_messages", "attention_actions", "attention_dispatch_phases",
    "attention_receipt_resolutions", "events"] : source === "hermes" ? ["events"]
    : source === "revision_chain" ? ["engineering_revision_chain_events"] : ["engineering_contained_events"];
  return tables.map(table => count(db, table));
}
function parameters(answer: string, status?: "rejected"): Record<string, string> {
  if (answer === "approve_ci_repair") return { candidate };
  if (answer === "choice") return status ? { choice: "yes", status } : { choice: "yes" };
  if (answer === "free_text") return { text: "answer" };
  return {};
}

async function interrupt(root: string, route: Route, point: Point) {
  const [source, answer] = route;
  const router = await openRouter(root, point);
  try {
    const page = await router.list();
    expect(page.failures).toEqual([]);
    expect(page.items).toHaveLength(1);
    const item = page.items[0]!;
    expect(item.source).toBe(source);
    expect(item.allowed_answers).toContain(answer);
    const request = { credential, source, answer, params: parameters(answer, route[2]), answer_id: "key:1",
      source_id: item.source_id, source_revision: item.source_revision! };
    const before = eventCounts(router.db, route);
    installFault(router.db, route, point);
    expect(await router.answer(request)).toMatchObject({ accepted: false, code: "injected_death" });
    return { request, before };
  } finally { router.db.close(); }
}

async function scenario(route: Route, point: Point, retries: number) {
  const [source, answer] = route;
  const root = realpathSync(createScratchDirSync("tests", "decisions-crash"));
  try {
    seed(root, route);
    const { request, before } = await interrupt(root, route, point);
    const { db, list, answer: send } = await openRouter(root);
    try {
      const page = await list();
      expect(page.failures).toEqual([]);
      expect(page.items.length).toBeLessThanOrEqual(1);
      const pending = page.items[0];
      if (pending) {
        expect(pending).toMatchObject({ source, source_id: request.source_id });
        if (pending.source_revision !== request.source_revision) {
          expect(source).not.toBe("hermes"); // Hermes revisions are digests.
          expect(parseInt(pending.source_revision!, 10)).toBeGreaterThan(parseInt(request.source_revision, 10));
        }
      }

      const effectCount = () => source === "probe"
        ? db.prepare("SELECT count(*) FROM decision_probes WHERE state <> 'pending'").pluck().get()
        : count(db, "observed_effects");
      const unapplied = point === "P1" || point === "P4";
      const interruptedAdmission = source === "revision_chain" && point === "P2";
      const expectedEffects = interruptedAdmission ? 0 : 1;
      expect(effectCount()).toBe(unapplied ? 0 : expectedEffects);
      if (source === "revision_chain" && (point === "P2" || point === "P3")) {
        const events = db.prepare("SELECT kind FROM engineering_revision_chain_events WHERE kind GLOB 'chain_answer_*' ORDER BY seq").pluck().all();
        expect(events).toEqual(answer === "abandon" ? ["chain_answer_accepted"] : ["chain_answer_accepted", "chain_answer_effect_started"]);
      }
      if (unapplied) {
        expect(pending?.source_revision).toBe(request.source_revision);
        expect(eventCounts(db, route)).toEqual(before);
      }
      if (point === "P4" && source === "hermes") {
        const approval = answer === "choice";
        expect(db.prepare(`SELECT status, resolved_at, ${approval ? "choice" : "answer"} value
          FROM ${approval ? "approvals" : "clarifies"}`).all()).toEqual([{ status: "pending", resolved_at: null, value: null }]);
        expect(db.prepare("SELECT json_type(payload_json,'$.decisions_answer') receipt FROM events").all()).toEqual([{ receipt: null }]);
      }
      if (point === "P3" && answer === "extra_repair") {
        expect(db.prepare("SELECT kind FROM engineering_contained_events WHERE kind IN ('decision_effect_started','decision_result','host_decision_failed')").all())
          .toEqual([{ kind: "decision_effect_started" }]);
      }
      if (point === "P3" && source === "session") {
        expect(db.prepare("SELECT state FROM session_messages").all()).toEqual([{ state: "accepted" }]);
      }
      const receiptCounts = eventCounts(db, route);
      let firstOutcome: string | undefined;
      for (let attempt = 0; attempt < retries; attempt++) {
        const result = await send(request);
        // The guide requires a stale revision to be refused before a new admission.
        // P1 and rolled-back P4 preserve the listed revision, so the first retry must be admitted.
        expect(result).toMatchObject({ accepted: true, code: null, replay: !unapplied || attempt > 0 });
        if (route[2] === "rejected") expect(result.current.state).toBe("rejected");
        if (source === "probe") {
          expect(result.outcome).toBe("applied");
          expect(db.prepare("SELECT revision, state, answer FROM decision_probes").all()).toEqual([
            { revision: Number(request.source_revision) + 1, state: "answered", answer },
          ]);
        }
        if (point === "P3" || interruptedAdmission) {
          expect(result.outcome).toBe("unknown");
          expect(eventCounts(db, route)).toEqual(receiptCounts);
        } else {
          expect(["applied", "accepted"]).toContain(result.outcome);
        }
        if (firstOutcome !== undefined) expect(result.outcome).toBe(firstOutcome);
        firstOutcome = result.outcome;
        expect(effectCount()).toBe(expectedEffects);
      }

      const writes = () => db.prepare("SELECT total_changes()").pluck().get();
      const stable = writes();
      const otherAnswer = source === "revision_chain" ? "takeover" : answer === "abandon" ? (source === "ci_repair" ? "approve_ci_repair" : "extra_repair")
        : answer === "extra_repair" ? "abandon" : source === "probe" ? "red" : answer;
      const params = otherAnswer !== answer ? parameters(otherAnswer) : answer === "approve_ci_repair" ? { candidate: "e".repeat(40) }
        : answer === "choice" ? { choice: "no" } : { text: "different" };
      expect(await send({ ...request, answer: otherAnswer, params })).toMatchObject({ outcome: "conflict", accepted: false });
      expect(writes()).toBe(stable);
      if (source === "probe" && point === "P2") {
        expect(await send({ ...request, answer_id: "key:2" })).toMatchObject({
          outcome: "conflict", accepted: false, code: "already_resolved",
        });
        expect(writes()).toBe(stable);
      }
      if (point === "P3") {
        // Chain answer events preserve the revision until the receipt settles.
        const source_revision = source === "revision_chain" ? String(Number(request.source_revision) - 1) : request.source_revision;
        expect(await send({ ...request, source_revision, answer_id: "key:2" })).toMatchObject({ outcome: "stale", accepted: false,
          code: source === "session" ? "stale_item" : "stale_revision" });
        expect(writes()).toBe(stable);
      }
      expect(effectCount()).toBe(expectedEffects);
    } finally { db.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
}

for (const route of [...routes, rejectedApproval]) {
  describe(route.join(" / "), () => {
    for (const point of points(route)) it(point, () => scenario(route, point, 2));
  });
}

function mulberry32(seed: number) {
  return () => {
    seed += 0x6d2b79f5;
    let n = seed;
    n = Math.imul(n ^ n >>> 15, n | 1);
    n ^= n + Math.imul(n ^ n >>> 7, n | 61);
    return ((n ^ n >>> 14) >>> 0) / 0x100000000;
  };
}

it("preserves forwarded answer identity across 200 seeded crashes", async () => {
  const selected = process.env["OSSTACK_DECISIONS_CRASH_SEED"];
  const seeds = selected === undefined ? Array.from({ length: 200 }, (_, i) => i + 1) : [Number(selected)];
  for (const seed of seeds) {
    expect(Number.isSafeInteger(seed) && seed >= 1 && seed <= 200).toBe(true);
    const random = mulberry32(seed);
    const route = routes[Math.floor(random() * routes.length)]!;
    const available = points(route);
    const point = available[Math.floor(random() * available.length)]!;
    const retries = 1 + Math.floor(random() * 3);
    try { await scenario(route, point, retries); }
    catch (cause) {
      throw Error(`OSSTACK_DECISIONS_CRASH_SEED=${seed} ${route.join("/")} ${point}, ${retries} retries: ${String(cause)}`, { cause });
    }
  }
});
