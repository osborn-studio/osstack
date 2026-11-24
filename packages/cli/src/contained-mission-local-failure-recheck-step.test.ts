import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalJson, ContainedMissionStore, RevisionChainStore, signLocalFailureRevisionGrant } from "@osstack/core";
import { LocalFailureRecheckRunStore, LocalFailureRecheckStore, LocalFailureDispatchStore, verificationDedupKey } from "@osstack/core/verification-intake";
import { publishedRecheck, record } from "@osstack/core/dist/state/local-failure-recheck.testkit.js";
import { eligibleRequest } from "@osstack/core/dist/state/diagnosis-fixtures.js";
import { LocalFailureRecheckService } from "./contained-mission-local-failure-recheck-step.js";
import * as runLibrary from "./contained-mission-local-failure-recheck-run.js";
import type { RecheckCollectorDeps } from "./contained-mission-local-failure-recheck-collect.js";
import { loadInstalledVerificationProfile, type ContainedVerificationProfile } from "./contained-mission-verification-profile.js";
import type { RecheckRunPorts } from "./contained-mission-local-failure-recheck-run.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
afterEach(() => vi.restoreAllMocks());
function fixture(optIn = true) {
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
  const d = publishedRecheck({
    ...(optIn ? { recheck: { timeout_seconds: 20 } } : {}),
    artifactDigest: sha(bytes),
    profileDigest: sha(canonicalJson(profile)),
  });
  d.recordConfirmation();
  d.confirm();

  const { f } = d;
  const runs = new LocalFailureRecheckRunStore(f.store, () => d.now);
  const finishChild = (id: string) => f.db.prepare("UPDATE engineering_contained_missions SET state='failed',stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(id);
  finishChild(d.dispatch.child_mission_id);
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
  const prepare = vi.fn<NonNullable<RecheckRunPorts["prepare"]>>(async (_options, _files, _installed, authorize) => {
    authorize();
    return prepared;
  });
  const run = vi.fn<NonNullable<RecheckRunPorts["run"]>>(async (_plan, _host, { invocationId }) => {
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
        termination: "exited",
        started: true,
        exitCode: 0,
        oomKilled: false,
        reason: null,
        stdout: capture,
        stderr: capture,
        stopReceipt,
        evidence: `docker-removed:${sha(JSON.stringify(stopReceipt))}`,
      },
    };
  });
  const ports: RecheckRunPorts = {
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
    readCandidate: vi.fn(async (head) => {
      expect(head).toBe(d.payload.candidate);
      return {
        tree: f.facts.binding.tree_sha,
        files: [{ path: "fixture", mode: "100644" as const, bytes: Buffer.from("fixture") }],
      };
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
  const originals = new Map([[f.v.result_id, f.input.contract_text]]);
  const collector = {
    readOriginalContract: vi.fn<RecheckCollectorDeps["readOriginalContract"]>(async q => originals.get(q.result_id) ?? null),
    readRecheckContracts: vi.fn<RecheckCollectorDeps["readRecheckContracts"]>(async () => []),
    readActions: vi.fn<RecheckCollectorDeps["readActions"]>(async () => null),
    hostProof: vi.fn((id: string) => runs.hostProof(id)),
  };
  const missions = new ContainedMissionStore(f.attention, f.owner);
  const options = { missions, diagnosis: f.store, collector, enabled: () => true, now, log: vi.fn(),
    runPortsFor: vi.fn((): RecheckRunPorts | null => ports) };
  const service = new LocalFailureRecheckService(options);
  const ledgerRow = () => d.ledger.forDispatch(d.dispatch.dispatch_id)!;
  return { ...d, runs, run, prepare, collector, options, service, ledgerRow, originals, finishChild };
}

it("skips all reads and starts while disabled", async () => {
  const h = fixture();
  h.options.enabled = () => false;
  const query = vi.spyOn(LocalFailureRecheckStore.prototype, "collectable");
  await h.service.runOnce();
  expect(query).not.toHaveBeenCalled();
  expect(h.collector.readOriginalContract).not.toHaveBeenCalled();
  expect(h.ledgerRow()).toBeUndefined();
  expect(h.options.runPortsFor).not.toHaveBeenCalled();
});

it("runs once on opening and collects the host proof on the next pass", async () => {
  const h = fixture();
  const call = vi.spyOn(runLibrary, "runRecheck");
  await h.service.runOnce();
  const { recheck_id } = h.ledgerRow();
  expect(call).toHaveBeenCalledExactlyOnceWith(h.options.runPortsFor.mock.results[0]!.value, recheck_id, "automatic", expect.any(AbortSignal));
  expect(h.runs.forRecheck(recheck_id)).toMatchObject([{ state: "stopped", outcome: "passed" }]);
  await h.service.runOnce();
  expect(h.ledgerRow()).toMatchObject({ state: "reverify_pending", missing_json: '["result","actions"]', host_receipt_id: expect.any(String) });
  expect(h.prepare).toHaveBeenCalledOnce();
  expect(h.run).toHaveBeenCalledOnce();
  expect(call).toHaveBeenCalledOnce();
  expect(h.options.log.mock.calls).toEqual([[`osstack: local-failure recheck: ${recheck_id}: stopped:host_passed`]]);
});

it("leaves a refusal final across passes and restart", async () => {
  const h = fixture(false), call = vi.spyOn(runLibrary, "runRecheck");
  await h.service.runOnce();
  const events = h.events();
  expect(events.filter(e => e.kind === "local_recheck_refused")).toHaveLength(1);
  expect(h.options.log).toHaveBeenCalledWith(`osstack: local-failure recheck: ${h.ledgerRow().recheck_id}: refused:verify_grant_missing`);
  for (let i = 0; i < 10; i++) await h.service.runOnce();
  await h.service.stop();
  const restarted = new LocalFailureRecheckService(h.options);
  restarted.recover();
  await restarted.runOnce();
  expect(call).toHaveBeenCalledOnce();
  expect(h.events()).toEqual(events);
  expect(h.run).not.toHaveBeenCalled();
});

it("collects a pre-existing pending row without a run", async () => {
  const h = fixture();
  h.open();
  await h.service.runOnce();
  expect(h.collector.readActions).toHaveBeenCalledOnce();
  expect(h.collector.readOriginalContract).not.toHaveBeenCalled();
  expect(h.options.runPortsFor).not.toHaveBeenCalled();
});

it.each(["null", "throws"])("logs unavailable host ports once when the factory %s", async mode => {
  const h = fixture();
  h.options.runPortsFor.mockImplementation(() => { if (mode === "throws") throw Error(); return null; });
  await h.service.runOnce();
  await h.service.runOnce();
  expect(h.options.log.mock.calls).toEqual([[`osstack: local-failure recheck: ${h.ledgerRow().recheck_id}: host_ports_unavailable`]]);
  expect(h.options.runPortsFor).toHaveBeenCalledOnce();
  expect(h.prepare).not.toHaveBeenCalled();
});

it("checks the ledger after collection throws", async () => {
  const h = fixture();
  vi.spyOn(LocalFailureRecheckStore.prototype, "evaluate").mockImplementationOnce(() => { throw Error(); });
  await h.service.runOnce();
  expect(h.options.log).toHaveBeenCalledWith(`osstack: local-failure recheck: child ${h.dispatch.child_mission_id}: collect_failed`);
  expect(h.run).toHaveBeenCalledOnce();
});

it("aborts collection during shutdown and skips the automatic start", async () => {
  const h = fixture();
  h.collector.readActions.mockImplementation(async (_q, signal) => {
    void h.service.stop();
    expect(signal.aborted).toBe(true);
    return null;
  });
  await h.service.runOnce();
  expect(h.ledgerRow().state).toBe("reverify_pending");
  expect(h.options.runPortsFor).not.toHaveBeenCalled();
});

it.each(["reserved", "running"])("recovers a %s run once without launching", async state => {
  const h = fixture(), row = h.open();
  const { runs, f } = h;
  const { run } = runs.reserve({ recheck_id: row.recheck_id, tree_sha: f.facts.binding.tree_sha,
    grant_id: f.facts.grant.grant_id, grant_digest: f.facts.grant_digest, invocation_id: randomUUID(),
    journal_ref: "fixture", container_cap_seconds: 12, now: h.now });
  if (state === "running") runs.start(run.run_id, run.revision);
  h.options.enabled = () => false;
  const recover = vi.spyOn(runLibrary, "recoverRecheckRuns");
  h.service.recover(); h.service.recover();
  expect(recover).toHaveBeenCalledOnce();
  expect(h.options.log.mock.calls).toEqual([["osstack: local-failure recheck: recovered=1"]]);
  expect(runs.get(run.run_id)).toMatchObject(state === "running" ? { state: "stop_unknown" } : { state: "stopped", outcome: "not_started" });
  h.options.enabled = () => true;
  await h.service.runOnce();
  expect(h.options.runPortsFor).not.toHaveBeenCalled();
  expect(h.prepare).not.toHaveBeenCalled();
  expect(h.run).not.toHaveBeenCalled();
});

it("contains a timer store exception and can run the next pass", async () => {
  const h = fixture();
  vi.spyOn(LocalFailureRecheckStore.prototype, "collectable").mockImplementationOnce(() => { throw Error(); });
  await expect(h.service.runOnce()).resolves.toBeUndefined();
  expect(h.run).not.toHaveBeenCalled();
  await h.service.runOnce();
  expect(h.run).toHaveBeenCalledOnce();
});

// Give the same host a second root and PR under a separately signed grant.
function secondChild(h: ReturnType<typeof fixture>) {
  const { f, options: { missions, now } } = h;
  const original = missions.get(h.r.root_mission_id);
  const root = missions.authorize(f.principal, { scope_id: original.scope_id, spec: JSON.parse(original.spec_json),
    claim: { repo_identity: "fixture", branch: "second", worktree_identity: "second" } }, now());
  const wire = { ...f.v, result_id: randomUUID(), pr: f.v.pr + 1 };
  wire.dedup_key = verificationDedupKey(wire);
  const contract_text = record(f, wire, 2);
  h.originals.set(wire.result_id, contract_text);
  const { signature: _sig, preview_sha256: _hash, ...preview } = f.facts.grant;
  const grant = signLocalFailureRevisionGrant({ ...preview, root_mission_id: root.mission_id, grant_id: 'rg_' + randomUUID(),
    pr_number: wire.pr }, f.keys.privateKey);
  const chains = new RevisionChainStore(f.attention, f.owner);
  const chain = chains.createLiveChain({ ...h.chain(), root_mission_id: root.mission_id, pr_number: wire.pr,
    published_head: wire.head_sha, grant }, now());
  const facts = { ...f.facts, chain_id: chain.chain_id, grant, grant_digest: sha(chain.grant_json),
    binding: { ...f.facts.binding, pr_number: wire.pr }, intake_id: 'lfi_' + randomUUID(), invocation_id: randomUUID() };
  const request = eligibleRequest({ ...f, facts, input: { ...f.input, result_id: wire.result_id, contract_text,
    root_mission_id: root.mission_id, chain_id: chain.chain_id } });
  const dispatch = new LocalFailureDispatchStore(f.store).dispatch({ request_id: request.request_id, now,
    verify: () => ({ grant_digest: facts.grant_digest, principal: f.principal, check_ids: ["fixture-check"] }),
    launchCaps: { executor_seconds: 3, verify_seconds: 2 }, locations: ["src/a.ts"],
    withinAllowed: (path, allowed) => allowed.includes(path), checkPaths: () => null,
    buildChild: ({ goal, binding }) => ({ spec: { goal, publication: { preauthorized: false }, local_failure_repair: binding },
      claim: { branch: "second-child", repo_identity: "fixture", worktree_identity: "second-child" } }),
  });
  if (dispatch.status !== "dispatched") throw Error(dispatch.reason);
  missions.record(dispatch.child_mission_id, "verify_repair_push_confirmed", h.payload, now());
  chains.confirmLocalRepairPush({ child_mission_id: dispatch.child_mission_id, new_head: h.payload.candidate }, now());
  h.finishChild(dispatch.child_mission_id);
  return dispatch;
}

it("serializes passes and stops after the first opened row of a two-child batch", async () => {
  const h = fixture(), other = secondChild(h);
  const ids = [h.dispatch.dispatch_id, other.dispatch_id].sort();
  let release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const passRun = h.run.getMockImplementation()!;
  h.run.mockImplementationOnce(async (...args) => { entered(); await gate; return passRun(...args); });
  const pass = h.service.runOnce();
  await waiting;
  expect(h.service.runOnce()).toBe(pass);
  expect(h.ledger.forDispatch(ids[1]!)).toBeUndefined();
  release();
  await pass;
  expect(h.run).toHaveBeenCalledOnce();
  await h.service.runOnce();
  for (const id of ids) expect(h.runs.forRecheck(h.ledger.forDispatch(id)!.recheck_id)).toMatchObject([{ state: "stopped", outcome: "passed" }]);
  expect(h.run).toHaveBeenCalledTimes(2);
});
