import { createHash, randomUUID } from "node:crypto";
import { ContainedMissionStore, RevisionChainStore, signLocalFailureRevisionGrant } from "@osstack/core";
import { DiagnosisStore, LocalFailureDispatchStore, parseVerificationResultV1, verificationDedupKey } from "@osstack/core/verification-intake";
import { diagnosisFixture, diagnosisRenewal, eligibleRequest } from "@osstack/core/dist/state/diagnosis-fixtures.js";
import { missionProtectedSetDigest } from "@osstack/governance";
import { expect, it, onTestFinished, vi } from "vitest";
import { dispatchLocalFailureRepair } from "./contained-mission-local-failure-dispatch.js";
import { createLocalFailureDispatch, LocalFailureDispatchService } from "./contained-mission-local-failure-dispatch-step.js";

type Options = ConstructorParameters<typeof LocalFailureDispatchService>[0];
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const launchCaps = { executor_seconds: 1, verify_seconds: 1 };
const prefix = "osstack: local-failure dispatch: request ";

function fixture(allowedPaths = ["src/a.ts"], options: Parameters<typeof diagnosisFixture>[0] = {}) {
  const f = diagnosisFixture({ allowedPaths, protectedDigest: missionProtectedSetDigest(), ...options });
  onTestFinished(f.close);
  new DiagnosisStore(f.attention, f.owner, () => f.facts.now - 1000).register(f.input);
  const r = eligibleRequest(f);
  const log = vi.fn<(line: string) => void>();
  const ports = {
    store: f.store, now: () => f.facts.now,
    keys: () => new Map([[f.facts.grant.key_id, {
      key_id: f.facts.grant.key_id, public_key: f.keys.publicKey, max_validity_ms: 86400000,
    }]]),
    access: { refresh: () => f.principal },
    loadInstalledProfile: () => ({ binding: f.facts.profile,
      profile: { checks: [{ check_id: "fixture-check" }], limits: { timeout_seconds: 20 } } }),
  };
  const worker = (opts: Partial<Options> = {}) => new LocalFailureDispatchService({
    diagnosis: f.store, portsFor: () => ports, launchCaps, enabled: () => true, log, ...opts,
  });
  const children = () => f.db.prepare(`SELECT m.spec_json,l.parent_mission_id,m.mission_id FROM engineering_contained_missions m
    JOIN engineering_mission_lineage l USING(mission_id) WHERE l.parent_mission_id IS NOT NULL`).all() as {
      spec_json: string; parent_mission_id: string; mission_id: string;
    }[];
  const dispatches = () => f.db.prepare("SELECT * FROM engineering_local_failure_dispatches").all() as {
    request_id: string; dispatch_id: string; child_mission_id: string;
  }[];
  return { f, r, log, worker, children, dispatches, ports };
}

// Give each result its own signed candidate and host receipt on the same database.
function anotherRequest(f: ReturnType<typeof diagnosisFixture>, n: number, sameRoot = false) {
  const missions = new ContainedMissionStore(f.attention, f.owner);
  const origin = missions.get(f.input.root_mission_id);
  const root = sameRoot ? origin : missions.authorize(f.principal, {
    scope_id: origin.scope_id, spec: JSON.parse(origin.spec_json),
    claim: { repo_identity: "fixture", branch: String(n), worktree_identity: String(n) },
  }, f.facts.now);
  const wire = { ...f.v, pr: sameRoot ? f.v.pr : n + 20, result_id: randomUUID(), head_sha: digest(String(n)).slice(0,40) };
  wire.dedup_key = verificationDedupKey(wire);
  const contract_text = JSON.stringify(wire);
  const parsed = parseVerificationResultV1(contract_text);
  if (!parsed.ok) throw Error(parsed.code);
  f.source.record([{ source_kind: "check_run", object_id: n + 20, repository_id: wire.repository_id,
    repository: wire.repository, pr: wire.pr, observed_head_sha: wire.head_sha, app_id: 201, check_name: "fixture",
    response_digest: digest(contract_text), contract_digest: digest(contract_text), verdict: { ok: true }, result: parsed.result }], 1, 1);
  const { signature: _signature, preview_sha256: _preview, ...preview } = f.facts.grant;
  const grant = signLocalFailureRevisionGrant({ ...preview, grant_id: `rg_${randomUUID()}`, root_mission_id: root.mission_id,
    head_sha: wire.head_sha, pr_number: wire.pr }, f.keys.privateKey);
  const chains = new RevisionChainStore(f.attention, f.owner);
  if (sameRoot) {
    f.db.exec("DROP TRIGGER engineering_local_failure_grant_monotonic");
    f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,published_head=?,revision=revision+1 WHERE chain_id=?")
      .run(JSON.stringify(grant), wire.head_sha, f.facts.chain_id);
  }
  const chain = sameRoot ? chains.get(f.facts.chain_id) : chains.createLiveChain({ root_mission_id: root.mission_id,
    repository: wire.repository, pr_number: wire.pr, branch: wire.branch, base_ref: wire.base_ref, published_head: wire.head_sha,
    published_base: wire.base_sha, trace_id: "fixture", grant }, f.facts.now);
  const binding = { ...f.facts.binding, head_sha: wire.head_sha, pr_number: wire.pr };
  const input = { ...f.input, chain_id: chain.chain_id, root_mission_id: root.mission_id, result_id: wire.result_id, contract_text };
  new DiagnosisStore(f.attention, f.owner, () => f.facts.now - 1000 + n).register(input);
  return eligibleRequest({ ...f, input,
    facts: { ...f.facts, binding, intake_id: `lfi_${randomUUID()}`, invocation_id: randomUUID(), grant,
      chain_id: chain.chain_id, grant_digest: digest(chain.grant_json) } });
}

it("creates one unapproved child and logs only host identifiers across restarts", async () => {
  const { worker, r, children, dispatches, log } = fixture();
  const service = worker();
  await service.runOnce();
  const [child] = children(), [dispatch] = dispatches();
  expect(child?.parent_mission_id).toBe(r.root_mission_id);
  expect(JSON.parse(child!.spec_json)).toMatchObject({ local_failure_repair: { request_id: r.request_id },
    publication: { preauthorized: false } });
  await service.runOnce();
  await worker().runOnce();
  expect(children()).toEqual([child]);
  expect(dispatches()).toEqual([dispatch]);
  expect(log.mock.calls).toEqual([[prefix + r.request_id + ": dispatched " + dispatch!.dispatch_id + " " + child!.mission_id]]);
});

it("excludes another eligible request for an already repaired root", async () => {
  const { f, r, worker, ports, children } = fixture();
  const next = anotherRequest(f, 1, true);
  await worker({ portsFor: row => row.request_id === next.request_id ? ports : null }).runOnce();
  expect(children()).toHaveLength(1);
  expect(f.store.receipt(r.receipt_id!).consumed_at).toBeNull();
  const portsFor = vi.fn(() => ports);
  await worker({ portsFor }).runOnce();
  expect(portsFor).not.toHaveBeenCalled();
});

it("holds a refused root after restart", async () => {
  const { r, children, log, worker, ports } = fixture(["src/a.test.ts"]);
  await worker().runOnce();
  const portsFor = vi.fn(() => ports);
  await worker({ portsFor }).runOnce();
  expect(portsFor).not.toHaveBeenCalled();
  expect(children()).toEqual([]);
  expect(log.mock.calls).toEqual([[prefix + r.request_id + ": refused:verify_protected_path"]]);
});

it.each([1, 2] as const)("dispatches once when renewal %i raises the exhausted rounds", async successfulRenewal => {
  const { f, r, ports, worker, children, log } = fixture();
  const service = worker();
  const dispatch = vi.spyOn(LocalFailureDispatchStore.prototype, "dispatch");
  onTestFinished(() => dispatch.mockRestore());
  f.db.exec("UPDATE engineering_revision_chains SET rounds_used=1,revision=revision+1");
  let now = f.facts.now;
  ports.now = () => now;
  const refusal = [prefix + r.request_id + ": refused:verify_repair_limit"];
  await service.runOnce();
  expect(log.mock.calls).toEqual([refusal]);
  if (successfulRenewal === 1) {
    await service.runOnce();
    expect(dispatch).toHaveBeenCalledTimes(1);
  } else {
    diagnosisRenewal(f, ++now).replace();
    await service.runOnce();
    expect(log.mock.calls).toEqual([refusal, refusal]);
    await service.runOnce();
    await service.runOnce();
    await worker().runOnce();
    expect(dispatch).toHaveBeenCalledTimes(2);
  }
  diagnosisRenewal(f, ++now, { rounds: 2 }).replace();
  await service.runOnce();
  expect(log.mock.lastCall?.[0]).toContain(prefix + r.request_id + ": dispatched ");
  expect(children().map(c => c.parent_mission_id)).toEqual([r.root_mission_id]);
  await service.runOnce();
  expect(dispatch).toHaveBeenCalledTimes(successfulRenewal + 1);
});

it("keeps a request skipped when a renewal reopens it", async () => {
  const { f, r, worker, ports, children } = fixture();
  const portsFor = vi.fn<Options["portsFor"]>().mockReturnValueOnce(null).mockReturnValue(ports);
  const service = worker({ portsFor });
  await service.runOnce();
  new ContainedMissionStore(f.attention, f.owner).record(r.root_mission_id, "local_failure_dispatch_refused",
    { state: "awaiting_decision", reason: "verify_chain_busy" }, f.facts.now);
  diagnosisRenewal(f, f.facts.now + 1).replace();
  expect(f.store.dispatchable()[0]?.reopened_by).toBeGreaterThan(0);
  await service.runOnce();
  expect(portsFor).toHaveBeenCalledTimes(1);
  expect(children()).toEqual([]);
});

it("attempts a repeatedly offered request once per reopening sequence", async () => {
  const { f, r, worker } = fixture(["src/a.test.ts"]);
  const read = vi.spyOn(f.store, "dispatchable").mockReturnValue([{ ...r, reopened_by: 4 }]);
  const dispatch = vi.spyOn(LocalFailureDispatchStore.prototype, "dispatch");
  onTestFinished(() => dispatch.mockRestore());
  const service = worker();
  await service.runOnce();
  await service.runOnce();
  expect(dispatch).toHaveBeenCalledTimes(1);
  read.mockReturnValue([{ ...r, reopened_by: 7 }]);
  await service.runOnce();
  await service.runOnce();
  expect(dispatch).toHaveBeenCalledTimes(2);
});

it.each(["before_consume", "after_consume", "after_child", "before_commit"] as const)("rolls back %s and retries after restart", async step => {
  const { f, r, children, dispatches, worker, log } = fixture();
  const service = worker({ fault(point) { if (point === step) throw Error(f.store.receipt(r.receipt_id!).receipt_json); } });
  await service.runOnce();
  await service.runOnce();
  expect(log.mock.calls).toEqual([[prefix + r.request_id + ": dispatch_failed"]]);
  expect(children()).toEqual([]);
  expect(dispatches()).toEqual([]);
  expect(f.store.receipt(r.receipt_id!).consumed_at).toBeNull();
  await worker().runOnce();
  expect(children()).toHaveLength(1);
  expect(dispatches()).toHaveLength(1);
});

it("pages past 101 unavailable requests and checks the switch before reading", async () => {
  const { f, worker, r, ports, children } = fixture();
  for (let i = 1; i <= 101; i++) anotherRequest(f, i);
  const ready = anotherRequest(f, 102);
  let enabled = false;
  const portsFor = vi.fn<Options["portsFor"]>(row => row.request_id === ready.request_id ? ports : null);
  const service = worker({ portsFor, enabled: () => enabled });
  await service.runOnce();
  expect(portsFor).not.toHaveBeenCalled();
  enabled = true;
  await service.runOnce();
  await service.runOnce();
  expect(portsFor).toHaveBeenCalledTimes(103);
  expect(f.store.get(r.request_id).state).toBe("eligible");
  expect(children().map(c => c.parent_mission_id)).toEqual([ready.root_mission_id]);
});

it.each(["normal", "fault", "ports throw", "already dispatched"])("processes one request per tick in creation order (%s)", async mode => {
  const { f, r, worker, dispatches, ports, log } = fixture();
  const next = anotherRequest(f, 1);
  const service = worker({
    portsFor(row) {
      if (row.request_id === r.request_id) {
        if (mode === "ports throw") throw Error(f.input.contract_text);
        if (mode === "already dispatched") dispatchLocalFailureRepair({ ...ports, launchCaps }, r.request_id);
      }
      return ports;
    },
    fault(point) { if (mode === "fault" && point === "before_commit" && !log.mock.calls.length) throw Error("private goal"); },
  });
  await Promise.all([service.runOnce(), service.runOnce()]);
  const first = mode === "normal" || mode === "already dispatched" ? [r.request_id] : [];
  expect(dispatches().map(d => d.request_id)).toEqual(first);
  if (!first.length) expect(log.mock.calls).toEqual([[prefix + r.request_id + ": dispatch_failed"]]);
  if (mode === "already dispatched") expect(log.mock.calls).toEqual([[prefix + r.request_id + ": already_dispatched"]]);
  await service.runOnce();
  expect(dispatches().map(d => d.request_id).sort()).toEqual([...first, next.request_id].sort());
});

it("uses one timer, joins an active tick and stops permanently", async () => {
  const { worker, ports, children } = fixture();
  vi.useFakeTimers();
  try {
    const stopped = worker();
    await stopped.stop();
    stopped.start();
    await stopped.stop();
    await stopped.runOnce();
    expect(vi.getTimerCount()).toBe(0);
    let stopping: Promise<void> | undefined;
    const service = worker({ portsFor() { stopping = service.stop(); return ports; } });
    service.start(); service.start();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(stopping).toBeDefined();
    await stopping;
    service.start();
    await service.runOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(children()).toEqual([]);
  } finally { vi.useRealTimers(); }
});

it.each([undefined, { ...launchCaps, executor_seconds: 0 }, { ...launchCaps, verify_seconds: 1.5 },
  { ...launchCaps, verify_seconds: Number.MAX_SAFE_INTEGER + 1 }])("rejects invalid launch caps %j", async caps => {
  const { f } = fixture();
  await expect(async () => createLocalFailureDispatch({ attention: f.attention, owner: f.owner, now: () => f.facts.now,
    portsFor: () => null, enabled: () => true, log: vi.fn(), launchCaps: caps! })).rejects.toThrow(/^LOCAL_FAILURE_DISPATCH_CAPS_INVALID$/);
});

it("passes only the declared host ports from the diagnosis factory", async () => {
  const { f, ports, children } = fixture();
  const fault = vi.fn(() => { throw Error("diagnosis fault"); });
  const hostPorts = { ...ports, fault, locations: ["src/a.test.ts"] };
  const service = await createLocalFailureDispatch({ attention: f.attention, owner: f.owner, now: ports.now, launchCaps,
    portsFor: () => hostPorts as unknown as Omit<import("./contained-mission-diagnosis.js").DiagnosisPorts, "registration">,
    enabled: () => true, log: vi.fn() });
  await service.runOnce();
  expect(fault).not.toHaveBeenCalled();
  expect(children()).toHaveLength(1);
});

it("logs the depth limit once per instance", async () => {
  const { r, log, worker, dispatches } = fixture(["src/a.ts"], { derive(missions, root, principal) {
    let parent = root;
    for (let depth = 1; depth <= 7; depth++) {
      const result = missions.registerDerived(principal, { scope_id: root.scope_id, spec: JSON.parse(root.spec_json),
        claim: { repo_identity: "fixture", branch: String(depth), worktree_identity: String(depth) },
        parent_mission_id: parent.mission_id, source: { kind: "verification", id: String(depth) },
        idempotency_key: String(depth) }, root.created_at);
      if (result.status !== "registered") throw Error("fixture_lineage");
      parent = result.mission;
    }
    return parent;
  } });
  const service = worker();
  await service.runOnce();
  await service.runOnce();
  expect(log.mock.calls).toEqual([[prefix + r.request_id + ": depth_limit:verify_chain_depth_limit"]]);
  expect(dispatches()).toEqual([]);
});

it.each(["skipped", "attempted"])("retires the scanned prefix at %s capacity", async mode => {
  const { f, r, worker } = fixture();
  const rows = Array.from({ length: 1002 }, (_, n) => ({ ...r, reopened_by: null, created_at: n, request_id: "fixture-" + n }));
  const read = vi.spyOn(f.store, "dispatchable").mockImplementation((limit, after) => {
    const start = after ? after.created_at + 1 : 0;
    return rows.slice(start, start + limit!);
  });
  const portsFor = vi.fn(() => {
    if (mode === "attempted") throw Error("fixture_error");
    return null;
  });
  const service = worker({ portsFor });
  await service.runOnce();
  expect(read.mock.calls.length).toBe(mode === "skipped" ? 10 : 1);
  for (let n = 0; n <= (mode === "skipped" ? 2 : rows.length + 2); n++) await service.runOnce();
  expect(portsFor).toHaveBeenCalledTimes(rows.length);
  expect(read.mock.calls.at(-1)?.[1]?.created_at).toBe(1001);
});
