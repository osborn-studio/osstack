import { ContainedMissionStore } from "@osstack/core";
import { diagnosisFixture, eligibleRequest } from "@osstack/core/dist/state/diagnosis-fixtures.js";
import { missionProtectedSetDigest } from "@osstack/governance";
import { afterEach, expect, it, vi } from "vitest";
import { assertLocalFailureApproval } from "./contained-mission-local-failure-approval.js";
import { dispatchLocalFailureRepair } from "./contained-mission-local-failure-dispatch.js";
import { ContainedMissionService, type ContainedMissionServiceOptions } from "./contained-mission-rpc.js";
import { parseContainedMissionSpec } from "./contained-mission-runner.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

function fixture(route: "disabled" | "unavailable" | "ready" = "ready") {
  const f = diagnosisFixture({ allowedPaths: ["src/**"], protectedDigest: missionProtectedSetDigest() });
  cleanup.push(f.close);
  const request = eligibleRequest(f);
  const { grant, now, profile } = f.facts;
  const dispatch = dispatchLocalFailureRepair({
    store: f.store, now: () => now, worktreesRoot: f.root,
    keys: () => new Map([[grant.key_id, { public_key: f.keys.publicKey, key_id: grant.key_id, max_validity_ms: 86400000 }]]),
    access: { refresh: () => f.principal },
    loadInstalledProfile: () => ({ binding: profile, profile: { checks: [{ check_id: "fixture-check" }], limits: { timeout_seconds: 20 } } }),
    launchCaps: { executor_seconds: 1, verify_seconds: 1 },
  }, request.request_id);
  if (dispatch.status !== "dispatched") throw Error(dispatch.reason);
  const id = dispatch.child_mission_id, candidate = "d".repeat(40);
  const store = new ContainedMissionStore(f.attention, f.owner);
  f.db.prepare("UPDATE engineering_contained_missions SET state='awaiting_decision', candidate_verified=1, candidate_head=?, candidate_tree=?, revision=revision+1 WHERE mission_id=?")
    .run(candidate, "e".repeat(40), id);
  store.record(id, "halted", { reason: "publication_pending" }, now);
  const actor = { ...f.principal, operator_scopes: [...f.principal.write_scopes] };
  const host = { store, isBusy: vi.fn(() => false), tick: vi.fn(), decide: vi.fn(), recover: vi.fn(), close: vi.fn() };
  const draining = vi.fn(() => false);
  const service = new ContainedMissionService({
    access: { authenticate: () => actor } as unknown as ContainedMissionServiceOptions["access"],
    host: host as unknown as ContainedMissionServiceOptions["host"], draining,
    ...(route === "disabled" ? {} : { localFailure: { rearmRecheck: vi.fn(), recheckView: () => null, publicationReady: route === "ready", start() {}, async recover() {}, async stop() {} } }),
  });
  cleanup.push(() => service.close());
  vi.spyOn(Date, "now").mockReturnValue(now);
  const approve = (over: Record<string, unknown> = {}) => service.handle("mission.approve_local_failure_repair", {
    credential: "c".repeat(32), mission_id: id, candidate, ...over,
  });
  const events = () => store.events(id);
  return { approve, actor, store, host, draining, events, id, now, candidate };
}

it.each(["disabled", "unavailable"] as const)("refuses a %s route before reading the Mission", async route => {
  const f = fixture(route), before = f.events();
  const depth = vi.spyOn(f.store, "atDepthLimit"), read = vi.spyOn(f.store, "readable"), get = vi.spyOn(f.store, "get");
  const code = route === "disabled" ? "local_failure_route_disabled" : "local_failure_publication_unavailable";
  await expect(f.approve()).rejects.toThrow(code);
  await expect(f.approve({ mission_id: "cm_" + "0".repeat(36) })).rejects.toThrow(code);
  f.actor.read_scopes = [];
  f.actor.write_scopes = [];
  f.actor.operator_scopes = [];
  await expect(f.approve()).rejects.toThrow(code);
  expect(depth).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
  expect(f.events()).toEqual(before);
});

it.each(["before", "after"])("refuses draining or busy Missions %s the import yields", async when => {
  const f = fixture(), before = f.events();
  if (when === "after") f.draining.mockReturnValueOnce(false);
  f.draining.mockReturnValueOnce(true);
  await expect(f.approve()).rejects.toThrow("draining");
  if (when === "after") f.host.isBusy.mockReturnValueOnce(false);
  f.host.isBusy.mockReturnValueOnce(true);
  await expect(f.approve()).rejects.toThrow("CONTAINED_MISSION_BUSY");
  expect(f.events()).toEqual(before);
});

it("binds one approval to the exact candidate and operator session for 15 minutes", async () => {
  const f = fixture();
  const result = await f.approve();
  expect(result).toMatchObject({ mission_id: f.id, state: "revalidating" });
  expect(result).not.toHaveProperty("spec_json");
  const mission = f.store.get(f.id), spec = parseContainedMissionSpec(mission.spec_json);
  expect(mission.state).toBe("revalidating");
  const approvals = () => f.events().filter(event => event.kind === "verify_repair_approval");
  expect(approvals()).toHaveLength(1);
  const expires = f.now + 15 * 60_000;
  expect(JSON.parse(approvals()[0]!.payload_json)).toMatchObject({
    principal: f.actor.principal_id, session: f.actor.client_session_id, candidate: f.candidate, expires_at: expires,
  });
  const check = (time: number) => assertLocalFailureApproval(f.store, mission, spec, () => f.actor, time);
  expect(() => check(expires - 1)).not.toThrow();
  expect(() => check(expires)).toThrow("verify_publish_authority_invalid");
  await expect(f.approve()).rejects.toThrow("verify_repair_approval_refused");
  expect(approvals()).toHaveLength(1);
  expect(f.host.decide).not.toHaveBeenCalled();
  expect(f.host.tick).not.toHaveBeenCalled();
});

it.each(["read_scopes", "write_scopes", "operator_scopes"] as const)("requires %s", async scope => {
  const f = fixture(), before = f.events();
  f.actor[scope] = [];
  await expect(f.approve()).rejects.toThrow("verify_repair_approval_refused");
  expect(f.events()).toEqual(before);
});

it("refuses a different candidate and rejects malformed or extended requests", async () => {
  const f = fixture(), before = f.events();
  await expect(f.approve({ candidate: "f".repeat(40) })).rejects.toThrow("verify_repair_approval_refused");
  for (const extra of [{ candidate: "bad" }, { extra: true }, { decision_id: "synthetic" }, { expected_revision: 1 }]) {
    await expect(f.approve(extra)).rejects.toThrow("bad_request");
  }
  expect(f.events()).toEqual(before);
});

it("reveals the chain depth limit only to the scoped operator", async () => {
  const f = fixture(), before = f.events();
  vi.spyOn(f.store, "atDepthLimit").mockImplementation(id => id === f.id);
  await expect(f.approve()).rejects.toThrow("verify_chain_depth_limit");
  f.actor.operator_scopes = [];
  await expect(f.approve()).rejects.toThrow("permission_denied");
  expect(f.events()).toEqual(before);
});
