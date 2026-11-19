import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { canonicalJson } from "@osstack/core";
import { LocalFailureRecheckRunStore } from "@osstack/core/verification-intake";
import { publishedRecheck, record, runFixture } from "@osstack/core/dist/state/local-failure-recheck.testkit.js";
import { withdrawalVerificationFixture } from "@osstack/core/dist/bridge/verification-result-fixtures.js";
import { checkRootAdmission, readRecheckContainerDebit } from "@osstack/core/dist/state/engineering-root-admission.js";
import { loadInstalledVerificationProfile, type ContainedVerificationProfile } from "./contained-mission-verification-profile.js";
import { recoverRecheckRuns, runRecheck, type RecheckRunPorts } from "./contained-mission-local-failure-recheck-run.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function fixture(mode = "passed") {
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
    ...(mode === "no-opt-in" ? {} : { recheck: { timeout_seconds: 20 } }),
    artifactDigest: sha(bytes),
    profileDigest: sha(canonicalJson(profile)),
  });
  d.recordConfirmation();
  d.confirm();
  const row = d.open();
  const { f } = d;
  const runs = mode === "busy" ? new LocalFailureRecheckRunStore(f.store) : runFixture(d, row).runs;
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
    runtimeBlockers: mode === "blocker" ? ["output_caps_exceed_runtime_maximum" as const] : [],
  };
  const prepare = vi.fn<NonNullable<RecheckRunPorts["prepare"]>>(async (_options, _files, _installed, authorize) => {
    authorize();
    if (mode === "prepare-error") throw Error("fixture");
    return prepared;
  });
  const run = vi.fn<NonNullable<RecheckRunPorts["run"]>>(async (_plan, _host, { invocationId }) => {
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
    if (mode === "identity") identity.command = "other";
    if (mode === "head") f.db.exec("UPDATE engineering_revision_chains SET published_head=published_base,revision=revision+1");
    if (mode === "base") f.db.exec("UPDATE engineering_revision_chains SET published_base=published_head,revision=revision+1");
    if (mode === "withdrawn") record(f, withdrawalVerificationFixture());
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
        termination: mode === "timeout" || mode === "output_limit" || mode === "namespace_rejected" || mode === "cancelled" ? mode : "exited",
        started: true,
        exitCode: mode === "failed" ? 1 : 0,
        oomKilled: mode === "oom",
        reason: null,
        stdout: capture,
        stderr: capture,
        stopReceipt,
        evidence: mode === "bad-proof" ? "unbound" : `docker-removed:${sha(JSON.stringify(stopReceipt))}`,
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
      expect(head).toBe(row.new_head_sha);
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
  const start = (trigger: "automatic" | "operator" = "automatic", id = row.recheck_id) =>
    runRecheck(ports, id, trigger, new AbortController().signal);
  const audit = () => d.events().filter(e => e.kind === "local_recheck_refused").map(e => JSON.parse(e.payload_json));
  const writes = () => f.db.prepare("SELECT total_changes()").pluck().get();
  return { ...d, row, runs, start, audit, writes, ports, run, prepare };
}

it.each([
  ["passed", "passed", "host_passed", null],
  ["failed", "reproducible_failure", "awaiting_decision", "verify_recheck_host_failed"],
  ...["oom", "output_limit", "namespace_rejected", "timeout", "cancelled"].map(mode =>
    [mode, mode === "timeout" || mode === "cancelled" ? mode : "infrastructure_error", "awaiting_decision", "verify_infrastructure_error"]),
  ...["stop_unknown", "identity", "bad-proof", "throw", "sync-throw"].map(mode =>
    [mode, null, "awaiting_decision", "verify_stop_unproven"]),
  ["head", "passed", "awaiting_decision", "verify_stale_head"],
  ["base", "passed", "awaiting_decision", "verify_base_changed"],
  ["withdrawn", "passed", "closed", "verify_withdrawn"],
  ["blocker", "not_started", "awaiting_decision", "verify_profile_unavailable"],
  ["prepare-error", "not_started", "awaiting_decision", "verify_recheck_not_started"],
])("records %s in the journal and preserves the ledger", async (mode, outcome, conclusion_state, conclusion_reason) => {
  const d = fixture(mode!);
  if (mode === "sync-throw") d.run.mockImplementationOnce(() => { throw Error("executor"); });
  const result = await d.start();
  const rows = d.runs.forRecheck(d.row.recheck_id);
  expect(rows).toHaveLength(1);
  expect(result).toEqual({ status: "concluded", run: rows[0] });
  expect(rows[0]).toMatchObject({ state: outcome === null ? "stop_unknown" : "stopped", outcome, conclusion_state, conclusion_reason });
  if (outcome && outcome !== "not_started") {
    expect(JSON.parse(rows[0]!.receipt_json!)).toMatchObject({ outcome, head: d.row.new_head_sha });
    expect(rows[0]!.receipt_json).not.toContain("secret text");
  } else expect(rows[0]!.receipt_json).toBeNull();
  const proof = d.runs.hostProof(d.row.recheck_id);
  if (mode === "passed") expect(proof).toMatchObject({ outcome: "passed", receipt_digest: rows[0]!.receipt_digest });
  else expect(proof).toBeNull();
  expect(d.ledger.get(d.row.recheck_id)).toEqual(d.row);
  expect(d.run).toHaveBeenCalledTimes(outcome === "not_started" ? 0 : 1);
});

it.each(["after_reserve", "after_launch_journal", "mid_run", "before_receipt"] as const)(
  "recovers a crash at %s and fences future triggers", async step => {
    const d = fixture();
    d.ports.fault = point => { if (point === step) throw Error("crash"); };
    await expect(d.start()).rejects.toThrow("crash");
    delete d.ports.fault;
    const unstarted = step === "after_reserve";
    const id = d.row.recheck_id;
    expect(d.runs.active(id)?.state).toBe(unstarted ? "reserved" : "running");
    const { recovered } = recoverRecheckRuns(d.ports);
    expect(recovered).toEqual(d.runs.forRecheck(id));
    expect(recovered[0]).toMatchObject({
      state: unstarted ? "stopped" : "stop_unknown", outcome: unstarted ? "not_started" : null,
      conclusion_state: "awaiting_decision", conclusion_reason: unstarted ? "verify_recheck_not_started" : "verify_stop_unproven",
    });
    const changes = d.writes();
    expect(recoverRecheckRuns(d.ports).recovered).toEqual(unstarted ? [] : recovered);
    expect(d.writes()).toBe(changes);
    expect(d.runs.hostProof(id)).toBeNull();
    if (unstarted) {
      for (let i = 0; i < 2; i++) expect(await d.start()).toMatchObject({
        status: "refused", state: "awaiting_decision", reason: "verify_recheck_not_started", run: null,
      });
      expect(d.audit()).toHaveLength(1);
      expect(await d.start("operator")).toMatchObject({ status: "concluded", run: { attempt: 2, conclusion_state: "host_passed" } });
    } else {
      for (const trigger of ["automatic", "operator"] as const)
        expect(await d.start(trigger)).toEqual({ status: "existing", run: recovered[0] });
    }
    expect(d.runs.forRecheck(id)).toHaveLength(unstarted ? 2 : 1);
    expect(d.run).toHaveBeenCalledTimes(step === "after_launch_journal" ? 0 : 1);
    expect(d.ledger.get(id)).toEqual(d.row);
  },
);

it("returns the same run during preparation, execution and after settlement", async () => {
  const d = fixture();
  const duplicate = async (state: string) => {
    const row = d.runs.active(d.row.recheck_id);
    expect(row?.state).toBe(state);
    const before = d.writes();
    expect(await d.start()).toEqual({ status: "existing", run: row });
    expect(d.writes()).toBe(before);
  };
  const prepare = d.prepare.getMockImplementation()!;
  d.prepare.mockImplementationOnce(async (...args) => {
    await duplicate("reserved");
    expect(d.f.store.transaction(() => checkRootAdmission(d.f.db, d.row.root_mission_id, "review")))
      .toEqual({ ok: false, holder: "recheck", code: "verify_chain_busy" });
    expect(readRecheckContainerDebit(d.f.db, d.row.chain_id)).toBe(20);
    return prepare(...args);
  });
  const run = d.run.getMockImplementation()!;
  d.run.mockImplementationOnce(async (...args) => {
    await duplicate("running");
    // The real executor checks the preparation callback again at launch.
    d.prepare.mock.calls[0]![3]();
    return run(...args);
  });
  expect(await d.start()).toMatchObject({ status: "concluded", run: { conclusion_state: "host_passed" } });
  await duplicate("stopped");
  expect(d.run).toHaveBeenCalledTimes(1);
  expect(d.prepare).toHaveBeenCalledTimes(1);
  expect(d.ports.readCandidate).toHaveBeenCalledTimes(1);
  expect(d.ledger.get(d.row.recheck_id)).toEqual(d.row);
});

it.each([
  ["missing", "recheck_run_state_denied"], ["sealed", "recheck_run_state_denied"],
  ["closed-chain", "verify_grant_missing"], ["v1", "verify_grant_missing"], ["no-opt-in", "verify_grant_missing"],
  ["profile_id", "verify_grant_invalid"], ["profile_digest", "verify_grant_invalid"], ["trusted_source", "verify_grant_invalid"],
  ["load-error", "verify_profile_unavailable"], ["wrong-check", "verify_profile_unavailable"], ["multiple-checks", "verify_profile_unavailable"],
  ["candidate", "verify_infrastructure_error"], ["revision", "verify_grant_invalid"], ["expired", "verify_grant_invalid"],
  ["signature", "verify_grant_invalid"], ["scope", "verify_grant_invalid"], ["refresh-error", "verify_grant_invalid"],
  ["installed-pin", "verify_grant_invalid"], ["withdrawal", "verify_withdrawn"], ["stale", "verify_stale_head"],
  ["changed-base", "verify_base_changed"], ["busy", "verify_chain_busy"], ["budget", "verify_budget_exhausted"],
  ["binding-trigger", "verify_grant_invalid"], ["grant-mismatch", "verify_grant_invalid"],
] as const)("refuses %s before reservation and deduplicates its audit", async (mode, reason) => {
  const d = fixture(mode);
  const { f, ports, row } = d;
  const grant = structuredClone(f.facts.grant);
  const setGrant = (value: unknown) => f.db.prepare("UPDATE engineering_revision_chains SET grant_json=?,revision=revision+1")
    .run(JSON.stringify(value));
  const refreshTransactions: boolean[] = [];
  const load = ports.loadInstalledProfile;
  switch (mode) {
    case "sealed":
      d.ledger.evaluate({ recheck_id: row.recheck_id, now: d.now, result: d.add({ skill_version: "2.0.0" }) });
      break;
    case "closed-chain":
      f.db.exec("UPDATE engineering_revision_chains SET state='closed',revision=revision+1");
      break;
    case "v1": {
      const { local_failure: _local, ...shared } = grant;
      setGrant({ ...shared, version: 1 });
      break;
    }
    case "profile_id":
    case "profile_digest":
    case "trusted_source":
      if (mode === "trusted_source") grant.local_failure.trusted_source.commit = "a".repeat(40);
      else grant.local_failure[mode] = mode === "profile_id" ? "other" : "0".repeat(64);
      setGrant(grant);
      break;
    case "load-error":
      ports.loadInstalledProfile = () => { throw Error("load"); };
      break;
    case "multiple-checks":
    case "wrong-check":
    case "installed-pin":
      ports.loadInstalledProfile = binding => {
        const installed = load(binding);
        if (mode === "installed-pin") return { ...installed, binding: { ...binding, profile_id: "other" } };
        const check = installed.profile.checks[0]!;
        const other = { ...check, check_id: "other" };
        return { ...installed, profile: { ...installed.profile, checks: mode === "wrong-check" ? [other] : [check, other] } };
      };
      break;
    case "candidate":
      ports.readCandidate = async () => { throw Error("read"); };
      break;
    case "revision": {
      const read = ports.readCandidate;
      ports.readCandidate = head => {
        f.db.exec("UPDATE engineering_revision_chains SET revision=revision+1");
        return read(head);
      };
      break;
    }
    case "expired":
      ports.now = () => grant.expires_at;
      break;
    case "signature":
      setGrant({ ...grant, signature: "A".repeat(86) + "==" });
      break;
    case "scope":
      ports.access.refresh = () => ({ ...f.principal, write_scopes: [] });
      break;
    case "refresh-error":
      ports.access.refresh = vi.fn(() => {
        refreshTransactions.push(f.db.inTransaction);
        throw Error("permission_denied");
      });
      break;
    case "withdrawal":
      record(f, withdrawalVerificationFixture());
      break;
    case "stale":
      f.db.exec("UPDATE engineering_revision_chains SET published_head=published_base,revision=revision+1");
      break;
    case "changed-base":
      f.db.exec("UPDATE engineering_revision_chains SET published_base=published_head,revision=revision+1");
      break;
    case "budget":
      f.db.prepare(`UPDATE engineering_revision_chains SET spent_json=json_set(spent_json,
        '$.allocations.' || ? || '.container_used', ?),revision=revision+1`).run(row.child_mission_id, grant.budget.max_container_seconds);
      break;
    case "binding-trigger":
      f.db.exec("UPDATE engineering_revision_chains SET state='awaiting_decision',stop_reason='verify_chain_busy',revision=revision+1");
      break;
    case "grant-mismatch":
      vi.spyOn(LocalFailureRecheckRunStore.prototype, "reserve").mockImplementation(() => { throw Error("recheck_run_grant_mismatch"); });
      break;
  }
  const before = d.ledger.get(row.recheck_id);
  const state = reason === "verify_withdrawn" ? "closed" : "awaiting_decision";
  try {
    for (const trigger of ["automatic", "operator"] as const) {
      expect(await d.start(trigger, mode === "missing" ? "missing" : row.recheck_id)).toEqual({
        status: "refused", state, reason, run: null,
      });
    }
  } finally {
    vi.restoreAllMocks();
  }
  if (mode === "refresh-error") expect(refreshTransactions).toEqual([true, true]);
  expect(d.audit()).toEqual(reason === "recheck_run_state_denied" || mode === "closed-chain" ? [] : [{
    dispatch_id: row.dispatch_id, recheck_id: row.recheck_id, trigger: "automatic", state, reason,
  }]);
  expect(d.runs.forRecheck(row.recheck_id)).toEqual([]);
  expect(d.runs.hostProof(row.recheck_id)).toBeNull();
  expect(d.ledger.get(row.recheck_id)).toEqual(before);
  expect(d.prepare).not.toHaveBeenCalled();
  expect(d.run).not.toHaveBeenCalled();
});

it("audits a change in refusal reason for the same dispatch", async () => {
  const d = fixture();
  d.ports.readCandidate = async () => { throw Error("unreadable"); };
  await d.start();
  d.ports.loadInstalledProfile = () => { throw Error("missing"); };
  await d.start("operator");
  await d.start();
  expect(d.audit().map(e => [e.trigger, e.reason])).toEqual([
    ["automatic", "verify_infrastructure_error"], ["operator", "verify_profile_unavailable"],
  ]);
  expect(d.runs.forRecheck(d.row.recheck_id)).toEqual([]);
  expect(d.ledger.get(d.row.recheck_id)).toEqual(d.row);
  expect(d.run).not.toHaveBeenCalled();
});

it("caps unstarted attempts at three", async () => {
  const d = fixture("prepare-error");
  for (const [index, trigger] of (["automatic", "operator", "operator"] as const).entries())
    expect(await d.start(trigger)).toMatchObject({ status: "concluded", run: {
      attempt: index + 1, state: "stopped", outcome: "not_started", conclusion_reason: "verify_recheck_not_started",
    } });
  for (const trigger of ["operator", "automatic"] as const) expect(await d.start(trigger)).toEqual({
    status: "refused", state: "awaiting_decision", reason: "recheck_run_attempts_exhausted", run: null,
  });
  expect(d.audit()).toHaveLength(1);
  expect(d.runs.forRecheck(d.row.recheck_id)).toHaveLength(3);
  expect(d.runs.hostProof(d.row.recheck_id)).toBeNull();
  expect(d.ledger.get(d.row.recheck_id)).toEqual(d.row);
  expect(d.prepare).toHaveBeenCalledTimes(3);
  expect(d.run).not.toHaveBeenCalled();
});

it("recovers an empty journal without writing or entering the execution ports", () => {
  const d = fixture();
  const changes = d.writes();
  expect(recoverRecheckRuns(d.ports)).toEqual({ recovered: [] });
  expect(d.writes()).toBe(changes);
  expect(d.ports.readCandidate).not.toHaveBeenCalled();
  expect(d.prepare).not.toHaveBeenCalled();
  expect(d.run).not.toHaveBeenCalled();
  expect(d.ledger.get(d.row.recheck_id)).toEqual(d.row);
});

it.each(["aborted", "revoked", "withdrawn", "start-denied"] as const)(
  "settles a reservation when the launch fence fails for %s", async mode => {
    const d = fixture();
    const controller = new AbortController();
    const prepare = d.prepare.getMockImplementation()!;
    d.prepare.mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args);
      if (mode === "aborted") controller.abort();
      if (mode === "revoked") d.ports.access.refresh = () => { throw Error("revoked"); };
      if (mode === "withdrawn") record(d.f, withdrawalVerificationFixture());
      if (mode === "start-denied")
        vi.spyOn(LocalFailureRecheckRunStore.prototype, "start").mockImplementationOnce(() => { throw Error("start denied"); });
      return prepared;
    });
    try {
      expect(await runRecheck(d.ports, d.row.recheck_id, "automatic", controller.signal)).toMatchObject({
        status: "concluded", run: { state: "stopped", outcome: "not_started", conclusion_state: "awaiting_decision",
          conclusion_reason: "verify_recheck_not_started", container_used_seconds: 0 },
      });
    } finally {
      vi.restoreAllMocks();
    }
    expect(d.runs.hostProof(d.row.recheck_id)).toBeNull();
    expect(d.ledger.get(d.row.recheck_id)).toEqual(d.row);
    expect(d.run).not.toHaveBeenCalled();
  },
);

it("rechecks automatic attempt eligibility after the candidate read", async () => {
  const d = fixture("prepare-error");
  const read = d.ports.readCandidate;
  d.ports.readCandidate = async head => {
    d.ports.readCandidate = read;
    await d.start();
    return read(head);
  };
  expect(await d.start()).toEqual({ status: "refused", run: null, state: "awaiting_decision", reason: "verify_recheck_not_started" });
  expect(d.runs.forRecheck(d.row.recheck_id)).toMatchObject([{ state: "stopped", outcome: "not_started", attempt: 1 }]);
  expect(d.prepare).toHaveBeenCalledTimes(1);
  expect(d.run).not.toHaveBeenCalled();
  expect(d.ledger.get(d.row.recheck_id)).toEqual(d.row);
});

it.each([[1001, 2], [21000, 20]])("charges elapsed time of %i ms against the signed cap", async (elapsed, used) => {
  const d = fixture();
  let now = d.now;
  d.ports.now = () => now;
  const run = d.run.getMockImplementation()!;
  d.run.mockImplementationOnce((...args) => {
    now += elapsed;
    return run(...args);
  });
  expect(await d.start()).toMatchObject({ status: "concluded", run: {
    started_at: d.now, updated_at: d.now + elapsed, state: "stopped", container_used_seconds: used, conclusion_state: "host_passed",
  } });
  expect(d.run).toHaveBeenCalledTimes(1);
  expect(d.ledger.get(d.row.recheck_id)).toEqual(d.row);
});

it("refuses to launch from an enclosing transaction", async () => {
  const d = fixture();
  let pending: ReturnType<typeof d.start> | undefined;
  d.f.store.transaction(() => { pending = d.start(); });
  await expect(pending).rejects.toThrow("recheck_run_nested_launch");
  expect(d.runs.forRecheck(d.row.recheck_id)).toEqual([]);
  expect(d.prepare).not.toHaveBeenCalled();
  expect(d.run).not.toHaveBeenCalled();
});
