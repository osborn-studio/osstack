import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalJson, ContainedMissionStore, RevisionChainStore } from "@osstack/core";
import { DiagnosisStore, verificationDedupKey, parseVerificationResultV1 } from "@osstack/core/verification-intake";
import { diagnosisFixture } from "@osstack/core/dist/state/diagnosis-fixtures.js";
import { loadInstalledVerificationProfile, type ContainedVerificationProfile } from "./contained-mission-verification-profile.js";
import type { DiagnosisPorts } from "./contained-mission-diagnosis.js";
import { LocalFailureDiagnosisService, createLocalFailureDiagnosis } from "./contained-mission-local-failure-diagnose.js";
import * as verification from "./contained-verification.js";
import * as recheck from "./contained-mission-local-failure-recheck-ports.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});
function fixture(mode = "failed") {
  const profile: ContainedVerificationProfile = {
    version: 1,
    profile_id: "fixture-profile",
    checks: [{ check_id: "fixture-check", category: "test", failure_exit_codes: [1] }],
    harness: { path: "/osstack-trusted/check", content: "fixture" },
    fixtures: [],
    argv: ["/usr/bin/node", "/osstack-trusted/check"],
    image: `fixture@sha256:${"f".repeat(64)}`,
    working_directory: "candidate",
    network: "none",
    read_only_rootfs: true,
    no_new_privileges: true,
    limits: {
      memory_mb: 128,
      cpus: 1,
      pids: 64,
      timeout_seconds: 20,
      stdout_bytes: 500,
      stderr_bytes: 500,
    },
  };
  const bytes = JSON.stringify({
    version: 1,
    trusted_source: {
      repository: "fixture-owner/fixture-harness",
      commit: "e".repeat(40),
    },
    profile,
  });
  const f = diagnosisFixture({
    allowedPaths: ["src"],
    artifactDigest: sha(bytes),
    profileDigest: sha(canonicalJson(profile)),
  });
  const count = () => f.db.prepare("SELECT count(*) n FROM engineering_contained_missions").get();
  const missions = count();
  cleanup.push(() => {
    try {
      expect(count()).toEqual(missions);
    } finally {
      f.close();
    }
  });
  writeFileSync(join(f.root, `${sha(bytes)}.json`), bytes, { mode: 0o600 });
  const pin = f.facts.profile,
    now = () => f.facts.now;
  const image = {
    version: 1 as const,
    daemonId: "fixture",
    baseImageId: `sha256:${sha("base")}`,
    imageId: `sha256:${sha("image")}`,
    workingDirectory: "/osstack-candidate-00000000-0000-4000-8000-000000000000",
    contentDigest: sha("files"),
    archiveDigest: sha("tar"),
    trustedProfile: {
      profileDigest: pin.profile_digest,
      artifactDigest: pin.trusted_source.artifact_digest,
      contentDigest: sha("harness"),
      baseImageReference: profile.image,
    },
  };
  const prepared = {
    binding: pin,
    image,
    command: "fixture",
    argv_digest: sha("argv"),
    timeoutMs: 20000,
    outputLimits: { stdoutBytes: 500, stderrBytes: 500 },
    runtimeBlockers: [],
  };
  const prepare = vi.fn<NonNullable<DiagnosisPorts["prepare"]>>(async () => {
    if (mode === "prepare-error") throw Error("fixture");
    return prepared;
  });
  const run = vi.fn<NonNullable<DiagnosisPorts["run"]>>(async (_plan, _host, { invocationId }) => {
    const identity = {
      version: 1 as const,
      kind: "contained_profile_run" as const,
      invocationId,
      binding: pin,
      command: prepared.command,
      argv_digest: prepared.argv_digest,
      image,
      timeoutMs: 20000,
      outputLimits: prepared.outputLimits,
    };
    const capture = {
      bytes: Buffer.from("secret text"),
      sha256: sha("secret text"),
      observedBytes: 11,
    };
    const stopReceipt = {
      version: 1 as const,
      kind: "docker_removed" as const,
      launch: {
        version: 1 as const,
        invocationId,
        specDigest: sha("spec"),
        daemonId: "fixture",
        containerId: sha("container"),
        nonce: randomUUID(),
      },
      confirmedAt: now(),
    };
    return {
      identity,
      result: {
        status: "stopped",
        termination: mode === "cancelled" ? "cancelled" : mode === "timeout" ? "timeout" : "exited",
        started: true,
        exitCode: mode === "passed" ? 0 : 1,
        oomKilled: false,
        reason: null,
        stdout: capture,
        stderr: capture,
        stopReceipt,
        evidence: `docker-removed:${sha(JSON.stringify(stopReceipt))}`,
      },
    };
  });
  const ports: Omit<DiagnosisPorts, "registration"> = {
    store: f.store,
    now,
    access: { refresh: () => f.principal },
    keys: () =>
      new Map([
        [
          f.facts.grant.key_id,
          {
            key_id: f.facts.grant.key_id,
            public_key: f.keys.publicKey,
            max_validity_ms: 86400000,
          },
        ],
      ]),
    readCandidate: async () => ({
      tree: f.facts.binding.tree_sha,
      files: [{ path: "fixture", mode: "100644", bytes: Buffer.from("fixture") }],
    }),
    loadInstalledProfile: (binding) =>
      loadInstalledVerificationProfile(
        {
          installedRoot: f.root,
          ownerUid: process.getuid!(),
          allowedArgv: [profile.argv],
        },
        binding,
      ),
    imageOptions: {
      socketPath: join(f.root, "fixture.sock"),
      baseImageId: image.baseImageId,
      daemonId: image.daemonId,
    },
    host: {
      socketPath: join(f.root, "fixture.sock"),
      journalRoot: f.root,
      authorizeRead: () => {},
      authorizeStop: () => {},
    },
    randomId: randomUUID,
    prepare,
    run,
  };
  const log = vi.fn();
  const service = (opts: Partial<ConstructorParameters<typeof LocalFailureDiagnosisService>[0]> = {}) =>
    new LocalFailureDiagnosisService({ diagnosis: f.store, portsFor: () => ports, enabled: () => true, log, ...opts });
  return { f, ports, prepare, run, service, log, profile };
}
type Fixture = ReturnType<typeof fixture>;
function registerOther({ f }: Fixture, n: number) {
  const wire = { ...f.v, pr: n + 20, result_id: randomUUID() };
  wire.dedup_key = verificationDedupKey(wire);
  const contract_text = JSON.stringify(wire);
  const parsed = parseVerificationResultV1(contract_text);
  if (!parsed.ok) throw Error(parsed.code);
  f.source.record([{ source_kind: "check_run", object_id: n + 20, repository_id: wire.repository_id,
    repository: wire.repository, pr: wire.pr, observed_head_sha: wire.head_sha, app_id: 201,
    check_name: "fixture", response_digest: sha(contract_text), contract_digest: sha(contract_text),
    verdict: { ok: true }, result: parsed.result }], 1, 1);
  return new DiagnosisStore(f.attention, f.owner, () => f.facts.now - 1)
    .register({ ...f.input, result_id: wire.result_id, contract_text });
}
it.each([
  ["failed", "eligible", null], ["passed", "diagnostic_closed", "verify_not_reproduced"],
  ["timeout", "awaiting_decision", "verify_infrastructure_error"], ["cancelled", "awaiting_decision", "verify_infrastructure_error"],
  ["prepare-error", "awaiting_decision", "verify_infrastructure_error"],
])("runs %s once and logs only ledger fields", async (mode, state, reason) => {
  const { f, service, log, run, prepare } = fixture(mode!);
  const { request_id } = f.store.register(f.input);
  const worker = service();
  await worker.runOnce(); await worker.runOnce();
  const row = f.store.get(request_id);
  expect(row).toMatchObject({ state, reason });
  if (mode === "failed") expect(f.store.receipt(row.receipt_id!).outcome).toBe("reproducible_failure");
  expect(log.mock.calls).toEqual([[`osstack: local-failure diagnosis: request ${request_id}: ${state}${reason ? ":" + reason : ""}`]]);
  expect(prepare).toHaveBeenCalledOnce();
  expect(run).toHaveBeenCalledTimes(mode === "prepare-error" ? 0 : 1);
});
it.each(["after_reserve", "after_launch_journal", "mid_run", "before_receipt"] as const)("recovers %s without replay", async step => {
  const { f, ports, service, log, prepare, run } = fixture();
  const { request_id } = f.store.register(f.input);
  ports.fault = point => { if (point === step) throw Error("secret text"); };
  const worker = service();
  await worker.runOnce(); await worker.runOnce();
  expect(log.mock.calls).toEqual([[`osstack: local-failure diagnosis: request ${request_id}: run_failed`]]);
  const next = service({diagnosis: new DiagnosisStore(f.attention, f.owner, ports.now)});
  next.recover(); next.recover();
  await next.runOnce();
  expect(f.store.get(request_id)).toMatchObject({state: "awaiting_decision", reason: step === "after_reserve" ? "verify_infrastructure_error" : "verify_stop_unproven"});
  expect(prepare).toHaveBeenCalledTimes(step === "after_reserve" ? 0 : 1);
  expect(run).toHaveBeenCalledTimes(["before_receipt", "mid_run"].includes(step) ? 1 : 0);
  expect(log.mock.calls[1]).toEqual(["osstack: local-failure diagnosis: recovered=1"]);
});
for (const enabled of [true, false]) {
  it.each(["reserved", "running", "stop_unknown"])("recovers %s with enabled=" + enabled, state => {
    const { f, service, run, prepare } = fixture();
    const r = f.store.register(f.input);
    const a = f.store.admit(r.request_id, r.revision, f.facts);
    if (a.status !== "admitted") throw Error(a.reason);
    const i = a.intake;
    if (state !== "reserved") {
      const running = f.store.intakes.start(i.intake_id, i.revision);
      if (state === "stop_unknown") f.store.intakes.markStopUnknown(i.intake_id, running.revision, "verify_stop_unproven");
    }
    service({ enabled: () => enabled }).recover();
    expect(f.store.get(r.request_id)).toMatchObject({ state: "awaiting_decision",
      reason: state === "reserved" ? "verify_infrastructure_error" : "verify_stop_unproven" });
    expect(run).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
}
it("pages past 101 skipped requests when enabled", async () => {
  const x = fixture();
  for (let n = 0; n < 101; n++) registerOther(x, n);
  const r = x.f.store.register(x.f.input);
  let enabled = false;
  const portsFor = vi.fn((row: typeof r) => row.request_id === r.request_id ? x.ports : null);
  const worker = x.service({ portsFor, enabled: () => enabled });
  await worker.runOnce(); expect(portsFor).not.toHaveBeenCalled();
  enabled = true;
  await worker.runOnce(); await worker.runOnce();
  expect(portsFor).toHaveBeenCalledTimes(102);
  expect(x.f.store.registered(100)).toHaveLength(100);
  expect(x.run).toHaveBeenCalledOnce();
});
it("continues after a throw before admission without retrying the request", async () => {
  const x = fixture();
  const first = registerOther(x, 1);
  x.f.store.register(x.f.input);
  const portsFor = vi.fn((row: typeof first) => row.request_id === first.request_id
    ? { ...x.ports, randomId: () => { throw Error("secret text"); } } : x.ports);
  const worker = x.service({portsFor});
  await worker.runOnce();
  expect(x.f.store.get(first.request_id).state).toBe("registered");
  expect(x.log.mock.calls).toEqual([[`osstack: local-failure diagnosis: request ${first.request_id}: run_failed`]]);
  await worker.runOnce(); await worker.runOnce();
  expect(portsFor).toHaveBeenCalledTimes(2); expect(x.run).toHaveBeenCalledOnce();
});
it.each([false, true])("serializes ticks and waits for an active run, stop=%s", async stopping => {
  const x = fixture();
  x.f.store.register(x.f.input);
  let release!: () => void;
  let entered!: (s: AbortSignal) => void;
  const started = new Promise<AbortSignal>(resolve => { entered = resolve; });
  const finish = new Promise<void>(resolve => { release = resolve; });
  const normal = x.run.getMockImplementation()!;
  x.run.mockImplementationOnce(async (...args) => { entered(args[2].signal!); await finish; return normal(...args); });
  const portsFor = vi.fn(() => x.ports);
  const worker = x.service({portsFor});
  const first = worker.runOnce(), signal = await started;
  registerOther(x, 1);
  const overlapping = worker.runOnce();
  const stop = stopping ? worker.stop() : undefined;
  expect(signal.aborted).toBe(stopping);
  let stopped = false;
  void stop?.then(() => { stopped = true; });
  await Promise.resolve(); expect(stopped).toBe(false);
  expect(portsFor).toHaveBeenCalledTimes(1);
  release(); await Promise.all([first, overlapping, stop]);
  await worker.runOnce();
  expect(portsFor).toHaveBeenCalledTimes(stopping ? 1 : 2);
  await worker.stop(); await worker.stop();
});
it("uses one timer and cannot restart after stop", async () => {
  const x = fixture();
  vi.useFakeTimers();
  try {
    const worker = x.service({ intervalMs: 100, initialDelayMs: 5 });
    worker.start(); worker.start(); expect(vi.getTimerCount()).toBe(1);
    x.f.store.register(x.f.input);
    await vi.advanceTimersByTimeAsync(4); expect(x.run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(x.run).toHaveBeenCalledOnce();
    await worker.stop(); worker.start(); expect(vi.getTimerCount()).toBe(0);
    const never = x.service(); await never.stop(); never.start(); expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});

async function factoryFixture() {
  const x = fixture();
  const { f } = x;
  mkdirSync(join(f.root, "bridge"), {mode: 0o700});
  writeFileSync(join(f.root, "bridge", "revision-issuer.json"), JSON.stringify({version: 1, keys: [{
    key_id: f.facts.grant.key_id, max_validity_ms: 86400000,
    public_key_spki_b64: f.keys.publicKey.export({type: "spki", format: "der"}).toString("base64"),
  }]}), {mode: 0o600});
  const file = join(f.root, 'bridge', 'verification-profile-host.json');
  const host = () => writeFileSync(file, JSON.stringify({version: 1, installed_root: f.root, allowed_argv: [x.profile.argv]}), {mode: 0o600});
  const missions = new ContainedMissionStore(f.attention, f.owner);
  const deps = { home: f.root, attention: f.attention, owner: f.owner, missions, access: x.ports.access,
    enabled: () => true, now: x.ports.now, log: x.log, docker: x.ports.imageOptions, prepare: x.prepare, run: x.run };
  return { ...x, deps, file, host, journal: join(f.root, 'local-failure-diagnosis') };
}
it("recovers without host settings and leaves registered work alone", async () => {
  const { f, deps, journal, run, log } = await factoryFixture();
  const r = f.store.register(f.input);
  const worker = await createLocalFailureDiagnosis(deps);
  worker.recover(); await worker.runOnce();
  expect(log.mock.calls).toEqual([["osstack: local-failure diagnosis: off (no bridge/verification-profile-host.json)"]]);
  expect(existsSync(journal)).toBe(false);
  expect(f.store.get(r.request_id).state).toBe("registered"); expect(run).not.toHaveBeenCalled();
});
it.each(["symlink", "mode", "invalid", "issuer"])("rejects factory config %s", async kind => {
  const { f, deps, journal, host, file } = await factoryFixture(); host();
  if (kind === "symlink") symlinkSync(f.root, journal);
  if (kind === "mode") { mkdirSync(journal); chmodSync(journal, 0o750); }
  if (kind === "invalid") writeFileSync(file, "{}");
  if (kind === "issuer") deps.home = join(f.root, "missing");
  const error = kind === "invalid" ? "VERIFICATION_PROFILE_HOST_CONFIG_INVALID:schema"
    : kind === "issuer" ? "LOCAL_FAILURE_ROUTE_ISSUER_REQUIRED" : "LOCAL_FAILURE_DIAGNOSIS_JOURNAL_INVALID";
  await expect(createLocalFailureDiagnosis(deps)).rejects.toEqual(Error(error));
});
it.each(["missing", "unparsable", "relative", "file"])("skips a Mission with %s repository input and runs its successor", async kind => {
  const x = await factoryFixture(); x.host();
  const skipped = registerOther(x, 0);
  const runnable = x.f.store.register(x.f.input);
  const mission = x.deps.missions.get(runnable.root_mission_id);
  const get = vi.spyOn(x.deps.missions, "get").mockImplementationOnce(() => {
    if (kind === "missing") throw Error("missing");
    return { ...mission, spec_json: kind === "unparsable" ? "{" : JSON.stringify({ ...JSON.parse(mission.spec_json),
      repo_path: kind === "relative" ? "relative" : x.file }) };
  });
  const factory = vi.spyOn(recheck, "createRecheckRunPorts");
  const candidate = vi.spyOn(verification, "exportContainedCommit").mockReturnValue({ tree: x.f.facts.binding.tree_sha, files: [] });
  try {
    const worker = await createLocalFailureDiagnosis(x.deps);
    expect(lstatSync(x.journal).mode & 0o777).toBe(0o700);
    await worker.runOnce(); await worker.runOnce();
    expect(get).toHaveBeenCalledTimes(2); expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]![0]).toMatchObject({repositoryPath: x.f.root, docker: {journalRoot: x.journal}});
    expect(x.f.store.get(skipped.request_id).state).toBe("registered"); expect(x.run).toHaveBeenCalledOnce();
    expect(candidate).toHaveBeenCalledWith(x.f.root, runnable.head_sha);
    expect(x.f.store.get(runnable.request_id).state).toBe("eligible");
  } finally { candidate.mockRestore(); factory.mockRestore(); }
});

it.each([1000, 1001])("resumes after ten pages and never reconsiders skipped ids at capacity (%s)", async skipped => {
  const x = fixture();
  const r = x.f.store.register(x.f.input);
  const rows = Array.from({length: skipped}, (_, n) => ({ ...r, request_id: "skip-" + n }));
  rows.push(r);
  const read = vi.spyOn(x.f.store, "registered").mockImplementation((limit, after) => {
    const index = after ? rows.findIndex(row => row.request_id === after.request_id) + 1 : 0;
    return rows.slice(index, index + limit!);
  });
  const worker = x.service({portsFor: row => row.request_id === r.request_id ? x.ports : null});
  await worker.runOnce(); expect(read).toHaveBeenCalledTimes(10); expect(x.run).not.toHaveBeenCalled();
  await worker.runOnce(); await worker.runOnce();
  expect(x.run).toHaveBeenCalledOnce();
});
it("keeps attempted ids on capacity exhaustion", async () => {
  const x = fixture();
  const r = x.f.store.register(x.f.input);
  const rows = Array.from({length: 1002}, (_, n) => ({...r, created_at: n, request_id: "attempt-" + n}));
  const read = vi.spyOn(x.f.store, "registered").mockImplementation((limit, after) =>
    rows.slice(after ? after.created_at + 1 : 0, (after ? after.created_at + 1 : 0) + limit!));
  const portsFor = vi.fn(() => x.ports);
  const worker = x.service({portsFor});
  for (let i = 0; i < rows.length + 10; i++) await worker.runOnce();
  expect(portsFor).toHaveBeenCalledTimes(rows.length);
  expect(read.mock.calls.at(-1)?.[1]).toMatchObject({created_at: 1001});
});

it("remembers a refused admission and logs the stored state", async () => {
  const x = fixture();
  const r = x.f.store.register(x.f.input);
  new RevisionChainStore(x.f.attention, x.f.owner).reserve(x.f.facts.chain_id, 1,
    { head: r.head_sha, review_ids: [7], feedback_digest: sha("review") }, x.f.facts.now);
  const admit = vi.spyOn(x.f.store, "admit");
  const portsFor = vi.fn(() => x.ports);
  const worker = x.service({ portsFor });
  await worker.runOnce(); await worker.runOnce();
  expect(admit.mock.results[0]?.value).toMatchObject({status: "refused", reason: "verify_chain_busy"});
  expect(x.f.store.get(r.request_id)).toMatchObject({state: "awaiting_decision", reason: "verify_chain_busy"});
  expect(x.log.mock.calls).toEqual([[`osstack: local-failure diagnosis: request ${r.request_id}: awaiting_decision:verify_chain_busy`]]);
  expect(portsFor).toHaveBeenCalledOnce(); expect(x.prepare).not.toHaveBeenCalled();
});
it("preserves the skipped prefix if port construction throws mid-page", async () => {
  const x = fixture();
  const r = x.f.store.register(x.f.input);
  const rows = Array.from({length: 1001}, (_, i) => ({...r, request_id: "skipped-" + i}));
  rows.push(r);
  vi.spyOn(x.f.store, "registered").mockImplementation((limit, after) => {
    const start = after ? rows.findIndex(row => row.request_id === after.request_id) + 1 : 0;
    return rows.slice(start, start + limit!);
  });
  let failed = false;
  const worker = x.service({portsFor(row) {
    if (row.request_id === r.request_id && !failed) { failed = true; throw Error("secret text"); }
    return failed ? x.ports : null;
  }});
  await worker.runOnce(); await worker.runOnce(); await worker.runOnce();
  expect(x.f.store.get(r.request_id).state).toBe("eligible");
  expect(x.log.mock.calls).toEqual([[`osstack: local-failure diagnosis: request ${r.request_id}: eligible`]]);
});

it("exposes the host ports for the supplied request", () => {
  const { f, service, ports } = fixture();
  const request = f.store.register(f.input);
  const portsFor = vi.fn().mockReturnValueOnce(ports).mockReturnValueOnce(null);
  const worker = service({ portsFor });
  expect(worker.portsFor(request)).toBe(ports);
  expect(worker.portsFor(request)).toBeNull();
  expect(portsFor.mock.calls).toEqual([[request], [request]]);
});
