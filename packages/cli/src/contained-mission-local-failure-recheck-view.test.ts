import { randomUUID } from "node:crypto";
import { ContainedMissionStore, RevisionChainStore } from "@osstack/core";
import { publishedRecheck, runFixture } from "@osstack/core/dist/state/local-failure-recheck.testkit.js";
import { expect, it, vi } from "vitest";
import { ContainedMissionHost, type ContainedMissionHostOptions } from "./contained-mission-host.js";
import { createRecheckRearm } from "./contained-mission-local-failure-recheck-rearm.js";
import { readLocalFailureRecheckView } from "./contained-mission-local-failure-recheck-view.js";
import { ContainedMissionService, type ContainedMissionServiceOptions } from "./contained-mission-rpc.js";

function fixture() {
  const d = publishedRecheck();
  d.recordConfirmation(); d.confirm();
  const missions = new ContainedMissionStore(d.f.attention, d.f.owner);
  const actor = { ...d.f.principal, operator_scopes: d.f.principal.read_scopes };
  const now = vi.fn(() => d.now + 50);
  const rearm = createRecheckRearm({ missions, access: { refresh: () => actor }, enabled: () => true, now, log: vi.fn() });
  const view = (id = d.r.root_mission_id) => readLocalFailureRecheckView({ missions, now, armed: rearm.armed }, id);
  return { ...d, missions, actor, clock: now, rearm, view };
}
it("reads the pending ledger, attempts and latest events without writing", () => {
  const h = fixture();
  expect(h.view()).toBeNull();
  const row = h.open(), { recheck_id, dispatch_id, chain_id, repository, pr_number } = row;
  const { runs, input } = runFixture(h, row);
  const r = runs.reserve(input).run;
  const stopped = runs.settleNotStarted(r.run_id, r.revision, "verify_recheck_not_started");
  const chains = new RevisionChainStore(h.f.attention, h.f.owner);
  const refusal = { trigger: "automatic", state: "awaiting_decision", reason: "verify_chain_busy" };
  chains.appendEvent(chain_id, "local_recheck_refused", { ...refusal, recheck_id, dispatch_id }, h.now);
  chains.appendEvent(chain_id, "local_recheck_refused", { ...refusal, recheck_id: "other", dispatch_id }, h.now + 1);
  const requested = h.rearm.request(h.actor, { mission_id: row.root_mission_id, decision_id: "first", expected_attempt: 2 });
  const before = [h.events(), h.chain(), h.ledger.get(recheck_id), runs.get(r.run_id)];
  h.f.db.pragma("query_only=ON");
  expect(h.view()).toEqual({ recheck_id, dispatch_id, chain_id, repository, pr_number, head: row.new_head_sha, base: row.base_sha,
    state: row.state, reason: row.reason, missing: ["result", "actions", "host"], opened_at: h.now, waited_ms: 50, attempts_used: 1, attempts_max: 3,
    attempts: [{ attempt: 1, state: "stopped", outcome: "not_started", conclusion_state: stopped.conclusion_state,
      conclusion_reason: stopped.conclusion_reason, updated_at: stopped.updated_at }], last_refusal: { ...refusal, at: h.now },
    rearm: { allowed: true, expected_attempt: 2, blocked_by: null, armed: { expires_at: requested.expires_at }, last_requested_at: h.clock() } });
  expect([h.events(), h.chain(), h.ledger.get(recheck_id), runs.get(r.run_id)]).toEqual(before);
  h.clock.mockReturnValue(h.now - 1); expect(h.view()?.waited_ms).toBe(0);
});
it.each(["present", "exhausted", "terminal", "closed"])("identifies the admission block for %s", kind => {
  const h = fixture(), row = h.open(), { runs, input } = runFixture(h, row);
  let code = "recheck_rearm_not_waiting";
  if (kind === "closed") h.f.db.exec("UPDATE engineering_revision_chains SET state='closed',revision=revision+1");
  if (kind === "terminal") h.ledger.evaluate({ recheck_id: row.recheck_id, result: h.add({ skill_version: "2.0.0" }), now: h.now });
  if (kind === "present") { runs.reserve(input); code = "recheck_rearm_run_present"; }
  if (kind === "exhausted") {
    for (let i = 0; i < 3; i++) {
      const r = runs.reserve({ ...input, invocation_id: randomUUID() }).run;
      runs.settleNotStarted(r.run_id, r.revision, "verify_recheck_not_started");
    }
    code = "recheck_run_attempts_exhausted";
  }
  expect(h.view()?.rearm).toEqual({ allowed: false, expected_attempt: null, blocked_by: code, armed: null, last_requested_at: null });
  if (kind === "terminal") expect(h.view()?.waited_ms).toBeNull();
});

it("checks read scope before adding the status view", async () => {
  const h = fixture(), authenticate = vi.fn(() => h.actor);
  const recheckView = vi.fn(h.view);
  const host = new ContainedMissionHost({ ports: { store: h.missions } as ContainedMissionHostOptions["ports"] });
  const service = new ContainedMissionService({ host, draining: () => false,
    access: { authenticate } as unknown as ContainedMissionServiceOptions["access"],
    localFailure: { publicationReady: false, rearmRecheck: h.rearm.request, recheckView, start() {}, async recover() {}, async stop() {} } });
  const status = () => service.handle("mission.status", { mission_id: h.r.root_mission_id, credential: "x".repeat(32) });
  expect(await status()).toHaveProperty("recheck", null);
  h.open(); expect(await status()).toMatchObject({ recheck: h.view() });
  authenticate.mockReturnValue({ ...h.actor, read_scopes: [] });
  await expect(status()).rejects.toThrow(Error("permission_denied"));
  expect(recheckView).toHaveBeenCalledTimes(2);
});

it("omits free text in a malformed refusal", () => {
  const h = fixture(), { chain_id, recheck_id } = h.open();
  new RevisionChainStore(h.f.attention, h.f.owner).appendEvent(chain_id, "local_recheck_refused",
    { recheck_id, trigger: "automatic", state: "awaiting_decision", reason: "private PR description" }, h.now);
  expect(h.view()?.last_refusal).toBeNull();
});
