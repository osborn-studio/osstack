import { expect, it } from "vitest";
import { registerDiagnosis, type DiagnosisPorts } from "./contained-mission-diagnosis.js";
it.each([null, {}, { schema_version: 1, producers: [] }])("stays closed with empty policy", async (policy) => {
  const ports = new Proxy({} as DiagnosisPorts, {
    get() {
      throw Error("unexpected store access");
    },
  });
  expect(await registerDiagnosis(ports, "missing", policy)).toEqual({
    status: "closed",
  });
});

import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import { canonicalJson } from "@osstack/core";
import { DiagnosisStore } from "@osstack/core/verification-intake";
import { diagnosisFixture } from "@osstack/core/dist/state/diagnosis-fixtures.js";
import { loadInstalledVerificationProfile, type ContainedVerificationProfile } from "./contained-mission-verification-profile.js";
import { recoverDiagnoses, runDiagnosis } from "./contained-mission-diagnosis.js";
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
    if (mode === "throw") throw Error("fixture");
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
    if (mode === "stop_unknown")
      return {
        identity,
        result: { status: "stop_unknown", reason: "lost ack" },
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
        termination: mode === "timeout" ? "timeout" : "exited",
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
  const ports: DiagnosisPorts = {
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
    registration: async () => f.input,
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
  const fresh = (): DiagnosisPorts => ({
    ...ports,
    store: new DiagnosisStore(f.attention, f.owner, now),
  });
  return { f, ports, prepare, run, fresh, profile, image };
}
it.each([
  ["failed", "eligible", null],
  ["passed", "diagnostic_closed", "verify_not_reproduced"],
  ["timeout", "awaiting_decision", "verify_infrastructure_error"],
  ["stop_unknown", "awaiting_decision", "verify_stop_unproven"],
  ["throw", "awaiting_decision", "verify_stop_unproven"],
  ["prepare-error", "awaiting_decision", "verify_infrastructure_error"],
])("concludes %s once", async (mode, state, reason) => {
  const { f, ports, prepare, run, fresh } = fixture(mode!);
  const registered = await registerDiagnosis(ports, f.v.result_id, f.input.policy);
  if (registered.status === "closed") throw Error("closed");
  const r = registered.request,
    signal = new AbortController().signal;
  const result = await runDiagnosis(ports, r.request_id, signal);
  expect(result.request).toMatchObject({ state, reason });
  if (reason === "verify_stop_unproven") {
    expect(f.store.intakes.containerDebit(f.facts.chain_id)).toBe(20);
    expect(f.store.intakes.activeExclusions(f.facts.chain_id)).toHaveLength(1);
    expect(result.request.receipt_id).toBeNull();
  } else if (mode !== "prepare-error")
    expect(f.store.receipt(result.request.receipt_id!).receipt_json).not.toContain("secret text");
  recoverDiagnoses(fresh());
  await runDiagnosis(fresh(), r.request_id, signal);
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(run).toHaveBeenCalledTimes(mode === "prepare-error" ? 0 : 1);
});
it.each([
  "after_reserve",
  "after_launch_journal",
  "mid_run",
  "before_receipt",
] as const)("recovers a crash at %s without replay", async (step) => {
  const { ports, f, fresh, run, prepare } = fixture();
  const r = f.store.register(f.input),
    signal = new AbortController().signal;
  await expect(
    runDiagnosis(
      {
        ...ports,
        fault: (s) => {
          if (s === step) throw Error("crash");
        },
      },
      r.request_id,
      signal,
    ),
  ).rejects.toThrow("crash");
  const recovered = recoverDiagnoses(fresh()).recovered[0]!;
  expect(recovered).toMatchObject({
    state: "awaiting_decision",
    receipt_id: null,
    reason: step === "after_reserve" ? "verify_infrastructure_error" : "verify_stop_unproven",
  });
  await runDiagnosis(fresh(), r.request_id, signal);
  expect(recoverDiagnoses(fresh()).recovered).toEqual([]);
  expect(prepare).toHaveBeenCalledTimes(step === "after_reserve" ? 0 : 1);
  expect(run).toHaveBeenCalledTimes(step === "mid_run" || step === "before_receipt" ? 1 : 0);
});

// Same Engine API responses as B3, injected at the HTTP transport boundary.
// Both image preparation and command execution use their real implementation.
it("records a proven namespace rejection from the real profile executor", async () => {
  const { ContainedDocker } = await import("@osstack/agents/dist/contained-docker.js");
  const { f, ports, image, profile } = fixture();
  const container = sha("container");
  let cwd = "",
    labels: Record<string, string> = {},
    removed = false;
  let config: { HostConfig: object } | undefined;
  const reply = (status: number, value: unknown) => ({
    status,
    bytes: Buffer.from(JSON.stringify(value)),
    headers: {},
  });
  const transport = vi.spyOn(ContainedDocker.prototype, "call").mockImplementation(async (method, path, body) => {
    if (path === "/info") return reply(200, { ID: image.daemonId, OSType: "linux" });
    if (path.startsWith("/build?")) {
      cwd = /WORKDIR (\/osstack-candidate-[a-z0-9-]+)/.exec((body as Buffer).toString())![1]!;
      labels = JSON.parse(new URLSearchParams(path.split("?")[1]).get("labels")!);
      return reply(200, { aux: { ID: image.imageId } });
    }
    if (path.startsWith("/images/")) {
      const base = path.includes(image.baseImageId);
      return reply(200, {
        Id: base ? image.baseImageId : image.imageId,
        RepoDigests: [profile.image],
        Config: { WorkingDir: base ? "" : cwd, Labels: base ? {} : labels },
      });
    }
    if (path === "/containers/create") {
      config = body as typeof config;
      return reply(201, { Id: container });
    }
    if (path.includes("/archive?")) return reply(404, {});
    if (method === "DELETE") {
      removed = true;
      return reply(204, {});
    }
    if (path === `/containers/${container}/json`)
      return removed
        ? reply(404, {})
        : reply(200, {
            Id: container,
            Image: image.imageId,
            Config: config,
            HostConfig: { ...config!.HostConfig, CapAdd: null },
            Mounts: [],
            State: {
              Status: "created",
              Running: false,
              ExitCode: 0,
              OOMKilled: false,
            },
          });
    throw Error("unexpected fixture endpoint");
  });
  try {
    const r = f.store.register(f.input);
    const { prepare: _prepare, run: _run, ...real } = ports;
    const result = await runDiagnosis(real, r.request_id, new AbortController().signal);
    expect(result.request.reason).toBe("verify_infrastructure_error");
    expect(f.store.receipt(result.request.receipt_id!).outcome).toBe("infrastructure_error");
    expect(removed).toBe(true);
  } finally {
    transport.mockRestore();
  }
});
it.each([
  "bad-signature",
  "expired",
  "future",
  "principal",
  "session",
  "scope",
  "installed-pin",
  "tree",
  "profile-unavailable",
  "v1",
])("refuses %s before reserving or preparing", async (mode) => {
  const { f, ports, run, prepare } = fixture(),
    r = f.store.register(f.input);
  if (mode === "expired") ports.now = () => f.facts.grant.expires_at;
  if (mode === "future") ports.now = () => f.facts.grant.issued_at - 1;
  if (mode === "tree")
    f.db
      .prepare("UPDATE engineering_contained_missions SET candidate_head=?,candidate_tree=?,revision=revision+1 WHERE mission_id=?")
      .run(r.head_sha, "c".repeat(40), r.root_mission_id);
  if (mode === "principal" || mode === "session" || mode === "scope")
    ports.access = {
      refresh: () => ({
        ...f.principal,
        ...(mode === "principal"
          ? { principal_id: "other" }
          : mode === "session"
            ? { client_session_id: "other" }
            : { write_scopes: [] }),
      }),
    };
  if (mode === "profile-unavailable")
    ports.loadInstalledProfile = () => {
      throw Error("unavailable");
    };
  if (mode === "installed-pin") {
    const load = ports.loadInstalledProfile;
    ports.loadInstalledProfile = (b) => ({
      ...load(b),
      binding: { ...b, profile_digest: "0".repeat(64) },
    });
  }
  if (mode === "bad-signature" || mode === "v1") {
    const { local_failure: _pin, ...shared } = f.facts.grant;
    const grant = mode === "v1" ? { ...shared, version: 1 } : { ...f.facts.grant, signature: "A".repeat(86) + "==" };
    // Simulate a database without the schema 64 guard to keep the inner defence covered.
    f.db.exec("DROP TRIGGER IF EXISTS engineering_local_failure_grant_monotonic");
    f.db
      .prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1 WHERE chain_id=?")
      .run(JSON.stringify(grant), f.facts.chain_id);
  }
  const result = await runDiagnosis(ports, r.request_id, new AbortController().signal);
  expect(result.request.reason).toBe(
    mode === "v1" ? "verify_grant_missing" : mode === "profile-unavailable" ? "verify_profile_unavailable" : "verify_grant_invalid",
  );
  expect(f.db.prepare("SELECT * FROM engineering_local_failure_intakes").all()).toEqual([]);
  expect(run).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
it("persists a refusal when the session is revoked at admission", async () => {
  const { f, ports } = fixture();
  const request = f.store.register(f.input);
  const transactions: boolean[] = [];
  const refresh = vi.spyOn(ports.access, "refresh");
  refresh.mockImplementationOnce(() => {
    transactions.push(f.db.inTransaction);
    return f.principal;
  }).mockImplementationOnce(() => {
    transactions.push(f.db.inTransaction);
    throw Error("permission_denied");
  });

  const result = await runDiagnosis(ports, request.request_id, new AbortController().signal);

  expect(transactions).toEqual([false, true]);
  expect(result.status).toBe("awaiting_decision");
  expect(f.store.get(request.request_id)).toMatchObject({
    state: "awaiting_decision",
    reason: "verify_grant_invalid",
    intake_id: null,
  });
  expect(f.db.prepare("SELECT intake_id FROM engineering_local_failure_intakes").all()).toEqual([]);
  expect(f.store.intakes.containerDebit(f.facts.chain_id)).toBe(0);
  expect(f.db.prepare("SELECT intake_id FROM engineering_verification_sources WHERE seq=?").get(request.source_seq))
    .toEqual({ intake_id: null });
});
it("never fabricates a missing host receipt from a stopped intake", () => {
  const { f, ports } = fixture(),
    r = f.store.register(f.input);
  const a = f.store.admit(r.request_id, 1, f.facts);
  if (a.status !== "admitted") throw Error(a.reason);
  f.store.intakes.start(a.intake.intake_id, 1);
  f.store.intakes.settleStopped(a.intake.intake_id, 2, {
    outcome: "passed",
    receipt_json: "{}",
    container_used_seconds: 1,
    evidence_digest: sha("evidence"),
    proof_ref: "proof",
    proof_digest: sha("proof"),
  });
  expect(recoverDiagnoses(ports).recovered[0]).toMatchObject({
    state: "awaiting_decision",
    reason: "verify_receipt_binding_invalid",
    receipt_id: null,
  });
});
it("rolls stopped settlement back when receipt insertion fails", async () => {
  const { f, ports, fresh, run } = fixture(),
    r = f.store.register(f.input),
    signal = new AbortController().signal;
  f.db.exec("CREATE TEMP TRIGGER no_receipt BEFORE INSERT ON engineering_host_receipts BEGIN SELECT RAISE(ABORT,'crash'); END");
  await expect(runDiagnosis(ports, r.request_id, signal)).rejects.toThrow("crash");
  const i = f.store.get(r.request_id).intake_id!;
  expect(f.store.intakes.get(i)).toMatchObject({
    state: "running",
    stop_obligation: 1,
  });
  expect(recoverDiagnoses(fresh()).recovered[0]).toMatchObject({
    state: "awaiting_decision",
    reason: "verify_stop_unproven",
    receipt_id: null,
  });
  await runDiagnosis(fresh(), r.request_id, signal);
  expect(run).toHaveBeenCalledTimes(1);
});
