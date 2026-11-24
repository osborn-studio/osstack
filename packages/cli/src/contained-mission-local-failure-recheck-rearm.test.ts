import { createHash, randomUUID } from "node:crypto";
import { ContainedMissionStore, RevisionChainStore } from "@osstack/core";
import { publishedRecheck, runFixture } from "@osstack/core/dist/state/local-failure-recheck.testkit.js";
import { afterEach, expect, it, vi } from "vitest";
import { createRecheckRearm, RECHECK_REARM_TTL_MS } from "./contained-mission-local-failure-recheck-rearm.js";
import { LocalFailureRecheckService } from "./contained-mission-local-failure-recheck-step.js";
import * as library from "./contained-mission-local-failure-recheck-run.js";
import { ContainedMissionService, type ContainedMissionServiceOptions } from "./contained-mission-rpc.js";

afterEach(() => vi.restoreAllMocks());

function fixture() {
  const d = publishedRecheck({ recheck: { timeout_seconds: 20 } });
  d.recordConfirmation(); d.confirm();
  const { f } = d, missions = new ContainedMissionStore(f.attention, f.owner);
  const actor = { ...f.principal, operator_scopes: [...f.principal.read_scopes] };
  const deps = { missions, access: { refresh: vi.fn(() => actor) }, now: vi.fn(() => d.now), enabled: vi.fn(() => true), log: vi.fn() };
  const rearm = createRecheckRearm(deps);
  const input = { mission_id: d.r.root_mission_id, expected_attempt: 1, decision_id: "decision-1" };
  const request = (over = {}) => rearm.request(actor, { ...input, ...over });
  const events = () => d.events().filter(e => e.kind === "local_recheck_rearm_requested");
  return { ...d, missions, actor, deps, rearm, input, request, requested: events };
}

it.each(["read_scopes", "write_scopes", "operator_scopes"] as const)("requires %s", scope => {
  const h = fixture(), row = h.open();
  expect(() => h.rearm.request({ ...h.actor, [scope]: [] }, h.input)).toThrow(Error("permission_denied"));
  expect(h.requested()).toEqual([]); expect(h.rearm.armed(row.recheck_id)).toBeNull();
});

it.each(["no ledger", "closed", "shadow", "child", "terminal", "disabled", "low", "high"])("refuses %s before arming", kind => {
  const h = fixture();
  const row = kind === "no ledger" ? undefined : h.open();
  let mission_id = h.input.mission_id, expected_attempt = 1, code = "recheck_rearm_not_waiting";
  if (kind === "closed" || kind === "shadow") h.f.db.exec("UPDATE engineering_revision_chains SET state='closed',revision=revision+1");
  if (kind === "shadow") new RevisionChainStore(h.f.attention, h.f.owner).createShadowChain(h.chain(), h.now);
  if (kind === "child") mission_id = h.dispatch.child_mission_id;
  if (kind === "terminal") h.ledger.evaluate({ recheck_id: row!.recheck_id, result: h.add({ skill_version: "2.0.0" }), now: h.now });
  if (kind === "disabled") { h.deps.enabled.mockReturnValue(false); code = "recheck_rearm_unavailable"; }
  if (kind === "low") {
    const { runs, input } = runFixture(h, row!);
    const run = runs.reserve(input).run;
    runs.settleNotStarted(run.run_id, run.revision, "verify_recheck_not_started");
    code = "recheck_rearm_attempt_mismatch";
  }
  if (kind === "high") { expected_attempt = 2; code = "recheck_rearm_attempt_mismatch"; }
  expect(() => h.request({ mission_id, expected_attempt })).toThrow(Error(code));
  expect(h.requested()).toEqual([]); expect(h.rearm.next()).toBeUndefined();
});

it.each(["reserved", "running", "stop_unknown", "passed", "reproducible_failure"] as const)("refuses a %s run", state => {
  const h = fixture(), row = h.open();
  const { runs, input, settle } = runFixture(h, row);
  let r = runs.reserve(input).run;
  if (state !== "reserved") r = runs.start(r.run_id, r.revision);
  if (state === "stop_unknown") runs.markStopUnknown(r.run_id, r.revision);
  if (state === "passed" || state === "reproducible_failure") settle(r, state);
  expect(() => h.request()).toThrow(Error("recheck_rearm_run_present"));
  expect(h.requested()).toEqual([]); expect(h.rearm.next()).toBeUndefined();
});

it("allows attempt three and refuses attempt four", () => {
  const h = fixture(), row = h.open(), { runs, input } = runFixture(h, row);
  const stop = () => {
    const run = runs.reserve({ ...input, invocation_id: randomUUID() }).run;
    runs.settleNotStarted(run.run_id, run.revision, "verify_recheck_not_started");
  };
  stop(); stop();
  expect(h.request({ expected_attempt: 3 }).attempt).toBe(3);
  expect(h.rearm.next()?.recheck_id).toBe(row.recheck_id);
  stop();
  expect(() => h.request({ expected_attempt: 4 })).toThrow(Error("recheck_run_attempts_exhausted"));
  expect(h.requested()).toHaveLength(1); expect(h.rearm.next()).toBeUndefined();
});

it("records only the request event and binds replay to the decision, principal and session", () => {
  const h = fixture(), row = h.open(), { recheck_id, dispatch_id } = row;
  const snapshot = () => [h.ledger.get(recheck_id), h.chain(), h.f.db.prepare("SELECT * FROM engineering_contained_missions ORDER BY mission_id").all()];
  const before = snapshot(), expires_at = h.now + RECHECK_REARM_TTL_MS;
  const result = h.request();
  expect(result).toEqual({ status: "armed", mission_id: row.root_mission_id, recheck_id, attempt: 1, expires_at, replay: false });
  expect(h.rearm.armed(recheck_id)).toEqual({ expires_at });
  expect(h.request()).toEqual({ ...result, replay: true });
  expect(() => h.request({ decision_id: "other" })).toThrow(Error("recheck_rearm_pending"));
  for (const key of ["principal_id", "client_session_id"])
    expect(() => h.rearm.request({ ...h.actor, [key]: "other" }, h.input)).toThrow(Error("recheck_rearm_pending"));
  h.deps.now.mockReturnValue(expires_at);
  expect(() => h.request()).toThrow(Error("decision_id_conflict"));
  expect(h.requested().map(e => JSON.parse(e.payload_json))).toEqual([{ recheck_id, dispatch_id, attempt: 1,
    decision_id: h.input.decision_id, principal: h.actor.principal_id, session: h.actor.client_session_id, expires_at }]);
  expect(snapshot()).toEqual(before);
});

function rpc(h: ReturnType<typeof fixture>, route: boolean) {
  const authenticate = vi.fn(() => h.actor), draining = vi.fn(() => false);
  const service = new ContainedMissionService({
    access: { authenticate } as unknown as ContainedMissionServiceOptions["access"], draining,
    host: { status: h.missions.readable.bind(h.missions), async close() {} } as unknown as ContainedMissionServiceOptions["host"],
    ...(route && { localFailure: { rearmRecheck: h.rearm.request, recheckView: () => null, publicationReady: false, start() {}, async stop() {}, async recover() {} } }),
  });
  return { service, authenticate, draining, request: () => service.handle("mission.rearm_local_failure_recheck", { ...h.input, credential: "x".repeat(32) }) };
}

it("hides the disabled method before parsing or authentication and keeps the status shape", async () => {
  const h = fixture(), r = rpc(h, false);
  await expect(r.request()).rejects.toThrow(Error("unknown_method"));
  await expect(r.service.handle("mission.rearm_local_failure_recheck", null)).rejects.toThrow(Error("unknown_method"));
  expect(r.authenticate).not.toHaveBeenCalled();
  expect(await r.service.handle("mission.status", { mission_id: h.input.mission_id, credential: "x".repeat(32) })).not.toHaveProperty("recheck");
});
it.each(["draining", "mission_unavailable"])("refuses %s before arming", async code => {
  const h = fixture(), r = rpc(h, true);
  const row = h.open();
  if (code === "draining") r.draining.mockReturnValue(true);
  else await r.service.close();
  await expect(r.request()).rejects.toThrow(Error(code));
  expect(h.requested()).toEqual([]); expect(h.rearm.armed(row.recheck_id)).toBeNull();
});

function step(h: ReturnType<typeof fixture>, rearm = h.rearm) {
  const { f } = h;
  const grant = f.facts.grant;
  const hash = (value: string) => createHash("sha256").update(value).digest("hex");
  const prepare = vi.fn<NonNullable<library.RecheckRunPorts["prepare"]>>(async (_image, _files, installed, authorize) => {
    authorize();
    return { binding: installed.binding, image: { version: 1, daemonId: "fixture", baseImageId: hash("base"),
      imageId: hash("image"), workingDirectory: "/candidate", contentDigest: hash("files"), archiveDigest: hash("archive"),
      trustedProfile: { profileDigest: installed.binding.profile_digest, artifactDigest: installed.binding.trusted_source.artifact_digest,
        contentDigest: hash("harness"), baseImageReference: "fixture" } },
      command: "fixture", argv_digest: hash("argv"), timeoutMs: 20000, outputLimits: { stdoutBytes: 500, stderrBytes: 500 }, runtimeBlockers: [] };
  });
  const run = vi.fn<NonNullable<library.RecheckRunPorts["run"]>>(async (plan, _host, { invocationId }) => {
    const { image, binding, command, argv_digest, timeoutMs, outputLimits } = plan;
    const stopReceipt = { version: 1 as const, kind: "docker_removed" as const, confirmedAt: h.deps.now(),
      launch: { version: 1 as const, invocationId, specDigest: hash("spec"), daemonId: image.daemonId, containerId: hash("container"), nonce: randomUUID() } };
    const capture = { bytes: Buffer.alloc(0), observedBytes: 0, sha256: hash("") };
    return { identity: { version: 1, kind: "contained_profile_run", invocationId, image, binding, command, argv_digest, timeoutMs, outputLimits },
      result: { status: "stopped", termination: "exited", started: true, exitCode: 0, oomKilled: false, reason: null,
        stdout: capture, stderr: capture, stopReceipt, evidence: "docker-removed:" + hash(JSON.stringify(stopReceipt)) } };
  });
  const ports: library.RecheckRunPorts = {
    store: f.store, now: h.deps.now, access: h.deps.access, randomId: randomUUID,
    keys: () => new Map([[grant.key_id, { key_id: grant.key_id, public_key: f.keys.publicKey, max_validity_ms: 86400000 }]]),
    loadInstalledProfile: binding => ({ binding, profile: { checks: [{ check_id: "fixture-check", category: "test" }], limits: { timeout_seconds: 20 } } }) as unknown as ReturnType<library.RecheckRunPorts["loadInstalledProfile"]>,
    readCandidate: async () => ({ tree: f.facts.binding.tree_sha, files: [] }),
    imageOptions: {} as library.RecheckRunPorts["imageOptions"], host: {} as library.RecheckRunPorts["host"], prepare, run,
  };
  const runPortsFor = vi.fn((): library.RecheckRunPorts | null => ports);
  const service = new LocalFailureRecheckService({ ...h.deps, diagnosis: f.store, rearmed: rearm.next, runPortsFor,
    collector: { readOriginalContract: async () => f.input.contract_text, readRecheckContracts: async () => [], readActions: async () => null, hostProof: () => null } });
  const passes = async (n: number) => { for (let i = 0; i < n; i++) await service.runOnce(); };
  return { prepare, run, runPortsFor, service, passes };
}

it("starts one operator attempt on the pass following a successful RPC", async () => {
  const h = fixture(), s = step(h), call = vi.spyOn(library, "runRecheck");
  s.runPortsFor.mockReturnValueOnce(null);
  await s.passes(1);
  const row = h.ledger.forDispatch(h.dispatch.dispatch_id)!;
  runFixture(h, row);
  const r = rpc(h, true);
  await expect(r.request()).resolves.toMatchObject({ status: "armed" });
  expect(call).not.toHaveBeenCalled(); expect(s.prepare).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled();
  expect(h.ledger.runFacts(row.recheck_id).attempts).toEqual([]);
  await s.passes(11);
  expect(call).toHaveBeenCalledExactlyOnceWith(expect.anything(), row.recheck_id, "operator", expect.any(AbortSignal));
  expect(s.prepare).toHaveBeenCalledOnce(); expect(s.run).toHaveBeenCalledOnce();
  expect(h.ledger.runFacts(row.recheck_id).attempts).toMatchObject([{ attempt: 1, outcome: "passed" }]);
});

it.each(["expired", "restart", "stale", "lost scope", "refresh throws", "disabled"])("voids a request when %s", async kind => {
  const h = fixture(), row = h.open(), { expires_at } = h.request();
  const rearm = kind === "restart" ? createRecheckRearm(h.deps) : h.rearm;
  const s = step(h, rearm);
  if (kind === "restart") s.service.recover();
  if (kind === "expired") h.deps.now.mockReturnValue(expires_at + 1);
  if (kind === "lost scope") h.deps.access.refresh.mockReturnValue({ ...h.actor, operator_scopes: [] });
  if (kind === "refresh throws") h.deps.access.refresh.mockImplementation(() => { throw Error(); });
  if (kind === "disabled") h.deps.enabled.mockReturnValue(false);
  if (kind === "stale") {
    const { runs, input } = runFixture(h, row), r = runs.reserve(input).run;
    runs.settleNotStarted(r.run_id, r.revision, "verify_recheck_not_started");
  }
  await s.passes(1);
  expect(rearm.armed(row.recheck_id)).toBeNull();
  const reason = kind === "expired" ? "rearm_expired" : kind === "disabled" ? "rearm_route_disabled" : kind === "stale" ? "rearm_stale" : "rearm_authority_lost";
  if (kind !== "restart") expect(h.deps.log).toHaveBeenCalledWith(`osstack: local-failure recheck: ${row.recheck_id}: ${reason}`);
  h.deps.enabled.mockReturnValue(true);
  await s.passes(10);
  expect(s.runPortsFor).not.toHaveBeenCalled(); expect(s.prepare).not.toHaveBeenCalled(); expect(s.run).not.toHaveBeenCalled();
  if (kind === "disabled" || kind === "expired") expect(h.request({ decision_id: "fresh" }).status).toBe("armed");
});

it.each([false, true])("consumes operator refusals and deduplicates equal reasons (changed=%s)", async changed => {
  const h = fixture(), s = step(h);
  const refusals = () => h.events().filter(e => e.kind === "local_recheck_refused").map(e => JSON.parse(e.payload_json));
  await s.passes(1);
  expect(refusals()).toMatchObject([{ trigger: "automatic", reason: "verify_chain_busy" }]);
  if (changed) h.deps.now.mockReturnValue(h.f.facts.grant.expires_at + 1);
  const { recheck_id } = h.request();
  await s.passes(11);
  const reason = changed ? "verify_grant_invalid" : "verify_chain_busy";
  expect(refusals()).toMatchObject([{ trigger: "automatic", reason: "verify_chain_busy" }, ...(changed ? [{ trigger: "operator", reason }] : [])]);
  expect(h.deps.log).toHaveBeenCalledWith(`osstack: local-failure recheck: ${recheck_id}: operator refused:${reason}`);
  expect(s.runPortsFor).toHaveBeenCalledTimes(2); expect(h.rearm.armed(recheck_id)).toBeNull();
});

it("arms nothing when the fenced write rolls back", () => {
  const h = fixture(), row = h.open();
  const original = RevisionChainStore.prototype.appendEvent;
  vi.spyOn(RevisionChainStore.prototype, "appendEvent").mockImplementationOnce(function (this: RevisionChainStore, ...args) {
    original.apply(this, args);
    throw Error("write_failed");
  });
  expect(() => h.request()).toThrow(Error("write_failed"));
  expect(h.requested()).toEqual([]); expect(h.rearm.armed(row.recheck_id)).toBeNull();
  expect(h.request().replay).toBe(false);
});

it("consumes an operator request with missing ports and leaves queued work alone after stop", async () => {
  const h = fixture(), s = step(h), row = h.open();
  h.request(); s.runPortsFor.mockReturnValueOnce(null);
  await s.passes(11);
  expect(s.runPortsFor).toHaveBeenCalledOnce();
  expect(h.deps.log).toHaveBeenCalledWith(`osstack: local-failure recheck: ${row.recheck_id}: operator host_ports_unavailable`);
  h.request({ decision_id: "next" });
  await s.service.stop(); await s.passes(1);
  expect(h.rearm.armed(row.recheck_id)).not.toBeNull();
});
