import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AttentionStore, ContainedMissionStore, openDb, RevisionChainStore, signLocalFailureRevisionGrant, type AttentionSender,
} from "@osstack/core";
import { eligibleRequest } from "@osstack/core/dist/state/diagnosis-fixtures.js";
import { publishedRecheck, record, runFixture } from "@osstack/core/dist/state/local-failure-recheck.testkit.js";
import { LocalFailureDispatchStore, verificationDedupKey } from "@osstack/core/verification-intake";
import { expect, it, vi } from "vitest";
import { localAttentionSender } from "./attention-local-delivery.js";
import { readLocalFailureCloseout } from "./contained-mission-local-failure-closeout.js";
import { DEFAULT_RECHECK_WAITING_NOTICE_MS, noticeWaitingRechecks } from "./contained-mission-local-failure-recheck-waiting.js";

const kind = "local_recheck_waiting_notice";
const waitMs = DEFAULT_RECHECK_WAITING_NOTICE_MS;
const empty = { examined: 0, sent: 0, failed: 0, skipped: 0 };

function setup() {
  const d = publishedRecheck({ summary: "untrusted-marker" });
  d.recordConfirmation();
  d.confirm();
  const row = d.open();
  const store = new ContainedMissionStore(d.f.attention, d.f.owner);
  const now = () => row.created_at + waitMs;
  const deps = { store, now, waitMs, signal: new AbortController().signal, send: vi.fn<AttentionSender>().mockResolvedValue(undefined) };
  const notices = () => d.events().filter(e => e.kind === kind).map(e => JSON.parse(e.payload_json));
  const view = (state: "OPEN" | "CLOSED" = "OPEN", clock = now) => readLocalFailureCloseout({
    store, now: clock, countedApprovers: [], readPr: async () => ({
      pr: { complete: true, state, head_oid: row.new_head_sha, base_ref_name: d.chain().base_ref, base_tip_oid: row.base_sha,
        merge_commit_oid: null, merged_head_oid: null, merge_base_oid: null, merged_by: null },
      reviews: { complete: true, items: [] }, threads: { complete: true, unresolved: 0 },
    }),
  }, row.child_mission_id);
  const restart = async () => {
    const db = openDb({ path: d.f.path });
    try {
      db.pragma("synchronous=FULL");
      const reopened = new ContainedMissionStore(new AttentionStore(db, d.f.path), d.f.owner);
      return await noticeWaitingRechecks({ ...deps, store: reopened });
    } finally {
      db.close();
    }
  };
  return { ...d, row, deps, notices, view, restart };
}

it("waits until the configured age", async () => {
  const { deps, row, notices } = setup();
  expect(await noticeWaitingRechecks({ ...deps, now: () => row.created_at + waitMs - 1 })).toEqual(empty);
  expect(deps.send).not.toHaveBeenCalled();
  expect(notices()).toEqual([]);
});

it("claims before sending identifiers once and preserves the full ledger row across replay", async () => {
  const { f, row, deps, ledger, notices, restart, view } = setup();
  const id = row.recheck_id;
  const delivery_id = "recheck-waiting:" + id;
  const ids = { recheck_id: id, delivery_id };
  deps.send.mockImplementationOnce(async () => {
    expect(f.db.inTransaction).toBe(false);
    expect(notices()).toEqual([{ ...ids, status: "claimed" }]);
    expect(await restart()).toEqual(empty);
  });
  expect(await noticeWaitingRechecks(deps)).toEqual({ ...empty, examined: 1, sent: 1 });
  expect(deps.send).toHaveBeenCalledWith({
    delivery_id, item_id: "verification-waiting:" + createHash("sha256").update(id).digest("hex").slice(0, 32),
    scope_id: f.facts.grant.scope_id, state: "verification_waiting",
    question: `Waiting for the verification result: ${row.repository}#${row.pr_number} head ${row.new_head_sha} recheck ${id}`,
  }, deps.signal);
  expect(notices()).toEqual([{ ...ids, status: "claimed" }, { ...ids, status: "sent" }]);
  expect(JSON.stringify([deps.send.mock.calls, notices()])).not.toContain("untrusted-marker");
  expect(await noticeWaitingRechecks(deps)).toEqual(empty);
  expect(await restart()).toEqual(empty);
  expect(deps.send).toHaveBeenCalledTimes(1);
  expect(ledger.get(id)).toEqual(row);
  expect((await view()).waiting_notice).toEqual({ status: "sent", at: deps.now() });
});

it.each([
  ["attention_webhook_http_500", "attention_webhook_http_500"],
  ["fixture secret https://fixture.invalid/TOKEN", "send_failed"],
])("records only the permitted failure code for %s", async (message, error) => {
  const { deps, row, ledger, view, notices } = setup();
  deps.send.mockRejectedValue(Error(message));
  expect(await noticeWaitingRechecks(deps)).toEqual({ ...empty, examined: 1, failed: 1 });
  const ids = { recheck_id: row.recheck_id, delivery_id: "recheck-waiting:" + row.recheck_id };
  expect(notices()).toEqual([{ ...ids, status: "claimed" }, { ...ids, status: "failed", error }]);
  expect(ledger.get(row.recheck_id)).toEqual(row);
  expect(await view()).toMatchObject({ waiting: { since: row.created_at }, waiting_notice: { status: "failed", at: deps.now() } });
  await noticeWaitingRechecks(deps);
  expect(deps.send).toHaveBeenCalledTimes(1);
});

it("preserves a claim after a crash and ignores notices for other rows in the chain", async () => {
  const { f, row, deps, restart, view } = setup();
  const chains = new RevisionChainStore(f.attention, f.owner);
  chains.appendEvent(row.chain_id, kind, { recheck_id: row.recheck_id, status: "claimed", delivery_id: "recheck-waiting:" + row.recheck_id }, deps.now());
  chains.appendEvent(row.chain_id, kind, { recheck_id: "other", status: "sent", delivery_id: "recheck-waiting:other" }, deps.now() + 1);
  expect(await restart()).toEqual(empty);
  expect(deps.send).not.toHaveBeenCalled();
  expect((await view()).waiting_notice).toEqual({ status: "claimed", at: deps.now() });
});

it("defers a quiet root scope until the posture is removed", async () => {
  const { deps, f, notices } = setup();
  f.db.prepare("INSERT INTO attention_postures(scope_id,actor,posture,entered_at) VALUES(?,'fixture','quiet',?)")
    .run(f.facts.grant.scope_id, deps.now());
  expect(await noticeWaitingRechecks(deps)).toEqual({ ...empty, examined: 1, skipped: 1 });
  expect(notices()).toEqual([]);
  expect(deps.send).not.toHaveBeenCalled();
  f.db.prepare("DELETE FROM attention_postures WHERE scope_id=?").run(f.facts.grant.scope_id);
  expect(await noticeWaitingRechecks(deps)).toEqual({ ...empty, examined: 1, sent: 1 });
});

it("refuses invalid configuration and honors cancellation before claim", async () => {
  const { deps, notices } = setup();
  for (const patch of [
    ...[59_999, 7 * 24 * waitMs + 1, 60_000.5, NaN, Infinity].map(waitMs => ({ waitMs })),
    ...[0, 51, 1.5, NaN].map(limit => ({ limit })),
  ]) {
    await expect(noticeWaitingRechecks({ ...deps, ...patch })).rejects.toThrow("recheck_waiting_notice_config_invalid");
  }
  expect(await noticeWaitingRechecks({ ...deps, signal: AbortSignal.abort() })).toEqual(empty);
  expect(deps.send).not.toHaveBeenCalled();
  expect(notices()).toEqual([]);
});

it("reports waiting time without changing the close-out audit, and clears both fields on closure", async () => {
  const { deps, events, notices, row, view } = setup();
  const audit = () => events().filter(e => e.kind === "local_repair_closeout").map(e => e.payload_json);
  expect(await view()).toMatchObject({ waiting_notice: null,
    waiting: { missing: ["result", "actions", "host"], since: row.created_at, waited_ms: waitMs } });
  const before = audit();
  expect(before).toHaveLength(1);
  expect(Object.keys(JSON.parse(before[0]!)).sort()).toEqual([
    "dispatch_id", "recheck_id", "state", "reason", "hold", "head", "merge_commit_oid", "verified_base_sha", "merged_onto_oid",
  ].sort());
  expect(notices()).toEqual([]);
  await noticeWaitingRechecks(deps);
  expect((await view("OPEN", () => row.created_at - 1)).waiting?.waited_ms).toBe(0);
  expect(audit()).toEqual(before);
  for (const state of ["CLOSED", "OPEN"] as const)
    expect(await view(state)).toMatchObject({ state: "closed_unmerged", waiting: null, waiting_notice: null });
  expect(audit()).toHaveLength(2);
});

it("ignores rows waiting only for host or Actions proof and a passed row", async () => {
  const d = setup();
  const { row, deps, view, notices } = d;
  const recheck_id = row.recheck_id, result = d.add(), now = deps.now();
  const actions = { head_sha: row.new_head_sha, attempt: 1, complete: true, conclusion: "success" as const, digest: "a".repeat(64) };
  const run = runFixture(d, row);
  const reserved = run.runs.reserve(run.input).run;
  run.settle(run.runs.start(reserved.run_id, reserved.revision));
  const host = run.runs.hostProof(recheck_id)!;
  for (const [proof, missing] of [[{ actions }, ["host"]], [{ host }, ["actions"]], [{ host, actions }, []]] as const) {
    const updated = d.ledger.evaluate({ recheck_id, now, result, ...proof });
    expect(JSON.parse(updated.missing_json)).toEqual(missing);
    expect(updated.state).toBe(missing.length ? "reverify_pending" : "recheck_passed");
    expect(await noticeWaitingRechecks(deps)).toEqual(empty);
    expect((await view()).waiting).toEqual(missing.length ? { missing, since: row.created_at, waited_ms: waitMs } : null);
  }
  expect(deps.send).not.toHaveBeenCalled();
  expect(notices()).toEqual([]);
});

it("ignores a row awaiting a decision", async () => {
  const { row, deps, ledger, add, notices } = setup();
  expect(ledger.evaluate({ recheck_id: row.recheck_id, now: deps.now(), result: add({ skill_version: "2.0.0" }) }).state)
    .toBe("awaiting_decision");
  expect(await noticeWaitingRechecks(deps)).toEqual(empty);
  expect(deps.send).not.toHaveBeenCalled();
  expect(notices()).toEqual([]);
});

// Open an independent PR in the same database so both claims use the real owner fence and ledger.
function additionalRecheck(d: ReturnType<typeof setup>, offset = 1, scope_id = d.f.facts.grant.scope_id) {
  const { f, deps, row } = d;
  const v = { ...f.v, result_id: randomUUID(), pr: row.pr_number + offset };
  v.dedup_key = verificationDedupKey(v);
  const text = record(f, v, offset + 1);
  const label = `pr-${v.pr}`;
  const principal = { ...f.principal, write_scopes: [scope_id], read_scopes: [scope_id], stop_scopes: [scope_id] };
  const root = deps.store.authorize(principal, {
    scope_id, spec: { goal: label, allowed_paths: ["src/a.ts"] },
    claim: { branch: label, repo_identity: "fixture", worktree_identity: label },
  }, d.now);
  const { preview_sha256: _digest, signature: _signature, ...preview } = f.facts.grant;
  const grant = signLocalFailureRevisionGrant({ ...preview, scope_id, root_mission_id: root.mission_id, pr_number: v.pr,
    grant_id: "rg_" + randomUUID() }, f.keys.privateKey);
  const chains = new RevisionChainStore(f.attention, f.owner);
  const chain = chains.createLiveChain({ ...d.chain(), root_mission_id: root.mission_id, pr_number: v.pr,
    published_head: v.head_sha, grant }, d.now);
  const grant_digest = createHash("sha256").update(chain.grant_json).digest("hex");
  const request = eligibleRequest({ ...f, v, input: { ...f.input, result_id: v.result_id, contract_text: text,
    root_mission_id: root.mission_id, chain_id: chain.chain_id },
    facts: { ...f.facts, grant, grant_digest, chain_id: chain.chain_id, binding: { ...f.facts.binding, pr_number: v.pr },
      intake_id: "lfi_" + randomUUID(), invocation_id: randomUUID(), journal_ref: label } });
  const dispatch = new LocalFailureDispatchStore(f.store).dispatch({
    request_id: request.request_id, now: () => d.now,
    verify: () => ({ grant_digest, principal, check_ids: ["fixture-check"] }),
    launchCaps: { executor_seconds: 3, verify_seconds: 2 }, locations: ["src/a.ts"],
    withinAllowed: (p, allowed) => allowed.includes(p), checkPaths: () => null,
    buildChild: ({ goal, binding }) => ({ spec: { goal, publication: { preauthorized: false }, local_failure_repair: binding },
      claim: { repo_identity: "fixture", branch: `${label}-child`, worktree_identity: `${label}-child` } }),
  });
  if (dispatch.status !== "dispatched") throw Error(dispatch.reason);
  const child_mission_id = dispatch.child_mission_id;
  deps.store.record(child_mission_id, "verify_repair_push_confirmed", d.payload, d.now);
  chains.confirmLocalRepairPush({ child_mission_id, new_head: d.payload.candidate }, d.now);
  return d.ledger.open({ child_mission_id, original_contract_text: text, now: d.now + offset });
}

it("claims one row per pass in creation order until no candidates remain", async () => {
  const d = setup();
  const second = additionalRecheck(d);
  const third = additionalRecheck(d, 2);
  const deps = { ...d.deps, limit: 1, now: () => third.created_at + waitMs };
  for (const row of [d.row, second, third]) {
    expect(await noticeWaitingRechecks(deps)).toEqual({ ...empty, examined: 1, sent: 1 });
    expect(deps.send.mock.lastCall?.[0].delivery_id).toBe("recheck-waiting:" + row.recheck_id);
  }
  expect(await noticeWaitingRechecks(deps)).toEqual(empty);
  expect(deps.send).toHaveBeenCalledTimes(3);
});

it("skips an older quiet scope without spending the claim limit", async () => {
  const d = setup();
  const { f } = d;
  f.db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('other','other','running',1,1)");
  const scope = f.attention.registerScope(f.owner, "other", f.root);
  const newer = additionalRecheck(d, 1, scope.scope_id);
  const deps = { ...d.deps, limit: 1, now: () => newer.created_at + waitMs };
  f.db.prepare("INSERT INTO attention_postures(scope_id,actor,posture,entered_at) VALUES(?,'fixture','quiet',?)")
    .run(f.facts.grant.scope_id, deps.now());
  expect(await noticeWaitingRechecks(deps)).toEqual({ ...empty, examined: 2, skipped: 1, sent: 1 });
  expect(d.notices()).toEqual([]);
  f.db.prepare("DELETE FROM attention_postures WHERE scope_id=?").run(f.facts.grant.scope_id);
  expect(await noticeWaitingRechecks(deps)).toEqual({ ...empty, examined: 1, sent: 1 });
  expect(deps.send.mock.calls.map(([m]) => m.delivery_id)).toEqual(
    [newer, d.row].map(r => "recheck-waiting:" + r.recheck_id));
});

it("excludes a row with only a failed notice from the examined count", async () => {
  const { f, row, deps } = setup();
  new RevisionChainStore(f.attention, f.owner).appendEvent(row.chain_id, kind, {
    recheck_id: row.recheck_id, delivery_id: "recheck-waiting:" + row.recheck_id, status: "failed", error: "send_failed",
  }, deps.now());
  expect(await noticeWaitingRechecks(deps)).toEqual(empty);
  expect(deps.send).not.toHaveBeenCalled();
});

it("continues to the next eligible row after a failed send", async () => {
  const d = setup();
  const second = additionalRecheck(d);
  const { deps, row } = d;
  deps.send.mockRejectedValueOnce(Error("fixture_failure"));
  expect(await noticeWaitingRechecks({ ...deps, now: () => second.created_at + waitMs }))
    .toEqual({ examined: 2, failed: 1, sent: 1, skipped: 0 });
  expect(deps.send.mock.calls.map(([m]) => m.delivery_id)).toEqual(
    [row, second].map(r => "recheck-waiting:" + r.recheck_id));
});

it("delivers the waiting message locally as a plain notice", async () => {
  const { f, deps } = setup();
  const local = localAttentionSender(f.root);
  deps.send.mockImplementation(local);
  expect(await noticeWaitingRechecks(deps)).toEqual({ ...empty, examined: 1, sent: 1 });
  const dir = join(f.root, "attention-notifications");
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  expect(JSON.parse(await readFile(join(dir, files[0]!), "utf8"))).toEqual({
    ...deps.send.mock.calls[0]![0], transport: "local_spool",
  });
});
