import { expect, it, vi } from "vitest";
import {
  checkLocalFailureRepairPaths,
  dispatchLocalFailureRepair,
  recoverLocalFailureDispatch,
  type LocalFailureDispatchPorts,
} from "./contained-mission-local-failure-dispatch.js";
import { diagnosisFixture, eligibleRequest } from "@osstack/core/dist/state/diagnosis-fixtures.js";
import { matchMissionProtectedPath, missionProtectedSetDigest } from "@osstack/governance";

function portsFor(f: ReturnType<typeof diagnosisFixture>): LocalFailureDispatchPorts {
  return {
    store: f.store,
    now: () => f.facts.now,
    worktreesRoot: f.root,
    keys: () =>
      new Map([
        [
          f.facts.grant.key_id,
          {
            public_key: f.keys.publicKey,
            key_id: f.facts.grant.key_id,
            max_validity_ms: 86400000,
          },
        ],
      ]),
    access: { refresh: () => f.principal },
    loadInstalledProfile: () => ({
      binding: f.facts.profile,
      profile: {
        checks: [{ check_id: "fixture-check" }],
        limits: { timeout_seconds: 20 },
      },
    }),
    launchCaps: { executor_seconds: 1, verify_seconds: 1 },
  };
}

it("preserves the base digest pinned by existing grants", () => {
  expect(missionProtectedSetDigest()).toBe("eb07aa03104fc42c9b259e5dc26f7a8a4d2ee0d9c3a1c8b4b7dc56fd2cd89ee1");
  expect(matchMissionProtectedPath(".github/workflows/ci.yml")).toContain("ci.github");
});

it("protects paths from the root verification scope", () => {
  expect(checkLocalFailureRepairPaths(["tools/check.ts"], ["tools/*.ts"])).toBe("verify_protected_path");
});

it.each([
  "src/a.test.ts",
  "skills/verify/SKILL.md",
  ".github/workflows/ci.yml",
  "verification-profiles/fixture.json",
  "**/*.test.ts",
  ".github/**",
])("refuses protected file %s", (path) => {
  expect(checkLocalFailureRepairPaths([path])).toBe("verify_protected_path");
  const f = diagnosisFixture({ allowedPaths: [path], protectedDigest: missionProtectedSetDigest() });
  try {
    const r = eligibleRequest(f);
    expect(dispatchLocalFailureRepair(portsFor(f), r.request_id)).toMatchObject({ reason: "verify_protected_path" });
    expect(f.store.receipt(r.receipt_id!).consumed_by).toBeNull();
  } finally {
    f.close();
  }
});
it("refreshes the live session under the lock and recovers without reauthorization", () => {
  const f = diagnosisFixture({
    allowedPaths: ["src/a.ts"],
    protectedDigest: missionProtectedSetDigest(),
  });
  try {
    const r = eligibleRequest(f);
    let revoked = true,
      calls = 0;
    const p = portsFor(f);
    p.access = {
      refresh: () => {
        expect(f.db.inTransaction).toBe(true);
        calls++;
        if (revoked) throw Error("revoked");
        return f.principal;
      },
    };
    expect(recoverLocalFailureDispatch(p, r.request_id)).toBeNull();
    expect(dispatchLocalFailureRepair(p, r.request_id)).toMatchObject({
      reason: "verify_grant_invalid",
    });
    revoked = false;
    const d = dispatchLocalFailureRepair(p, r.request_id);
    if (d.status !== "dispatched") throw Error(d.reason);
    expect(recoverLocalFailureDispatch(p, r.request_id)).toEqual(d);
    expect(dispatchLocalFailureRepair(p, r.request_id)).toEqual(d);
    expect(calls).toBe(2);
    const row = f.db
      .prepare("SELECT spec_json FROM engineering_contained_missions WHERE mission_id=?")
      .get(d.child_mission_id) as { spec_json: string };
    expect(JSON.parse(row.spec_json)).toMatchObject({
      start_commit: r.head_sha,
      publication: { preauthorized: false },
      local_failure_repair: {
        request_id: r.request_id,
        receipt_id: r.receipt_id,
      },
    });
    expect(row.spec_json).not.toContain("ci_repair");
  } finally {
    f.close();
  }
});

it.each([
  { locations: undefined },
  { locations: ["src/lib/a.ts"] },
])("dispatches within the root globs with locations $locations", ({ locations }) => {
  const allowed = ["src/**", "lib/*.ts"];
  const f = diagnosisFixture({ allowedPaths: allowed, protectedDigest: missionProtectedSetDigest() });
  try {
    const r = eligibleRequest(f);
    const result = dispatchLocalFailureRepair({ ...portsFor(f), ...(locations && { locations }) }, r.request_id);
    if (result.status !== "dispatched") throw Error(result.reason);
    const row = f.db
      .prepare("SELECT spec_json FROM engineering_contained_missions WHERE mission_id=?")
      .get(result.child_mission_id) as { spec_json: string };
    const spec = JSON.parse(row.spec_json);
    expect(spec.allowed_paths).toEqual(locations ?? allowed);
    for (const path of spec.allowed_paths) expect(spec.goal).toContain(JSON.stringify(path));
  } finally {
    f.close();
  }
});

it.each(["src-other/a.ts", "src/**", "src/../src/a.ts", "src/a.test.ts"])(
  "rolls back an unauthorized explicit location %s",
  (path) => {
    const f = diagnosisFixture({ allowedPaths: ["src/**"], protectedDigest: missionProtectedSetDigest() });
    try {
      const r = eligibleRequest(f);
      const snapshot = () =>
        [
          "contained_missions",
          "mission_lineage",
          "host_receipts",
          "revision_chains",
          "local_failure_dispatches",
          "diagnosis_requests",
          "local_failure_intakes",
        ].map((table) => f.db.prepare("SELECT * FROM engineering_" + table).all());
      const before = snapshot();
      expect(dispatchLocalFailureRepair({ ...portsFor(f), locations: [path] }, r.request_id)).toMatchObject({
        status: "refused",
        reason: "verify_protected_path",
      });
      expect(snapshot()).toEqual(before);
    } finally {
      f.close();
    }
  },
);

async function withdraw(f: ReturnType<typeof diagnosisFixture>) {
  const { withdrawalVerificationFixture } = await import("@osstack/core/dist/bridge/verification-result-fixtures.js");
  const { parseVerificationResultV1 } = await import("@osstack/core/verification-intake");
  const parsed = parseVerificationResultV1(JSON.stringify(withdrawalVerificationFixture()));
  if (!parsed.ok) throw Error(parsed.code);
  f.source.record([{ source_kind: "check_run", object_id: 2, repository_id: f.v.repository_id, repository: f.v.repository,
    pr: f.v.pr, observed_head_sha: f.v.head_sha, app_id: 201, check_name: "fixture", response_digest: "e".repeat(64),
    contract_digest: "e".repeat(64), verdict: { ok: true }, result: parsed.result }], 2, 2);
}

async function publicationFixture() {
  const { ContainedMissionStore } = await import("@osstack/core");
  const { approveLocalFailureRepair, assertLocalFailureApproval } = await import("./contained-mission-local-failure-approval.js");
  const f = diagnosisFixture({ allowedPaths: ["src/**"], protectedDigest: missionProtectedSetDigest() });
  const r = eligibleRequest(f);
  const d = dispatchLocalFailureRepair(portsFor(f), r.request_id);
  if (d.status !== "dispatched") throw Error(d.reason);
  const id = d.child_mission_id, candidate = "d".repeat(40), tree = "e".repeat(40);
  const store = new ContainedMissionStore(f.attention, f.owner);
  const spec = JSON.parse(store.get(id).spec_json) as import("./contained-mission-runner.js").ContainedMissionSpec;
  const now = f.facts.now, actor = { ...f.principal, operator_scopes: f.principal.write_scopes };
  f.db.prepare("UPDATE engineering_contained_missions SET state='awaiting_decision',candidate_verified=1,candidate_head=?,candidate_tree=?,revision=revision+1 WHERE mission_id=?").run(candidate, tree, id);
  store.record(id, "halted", { reason: "publication_pending" }, now);
  const approve = () => approveLocalFailureRepair(store, actor, id, candidate, now);
  return { f, r, id, candidate, tree, store, spec, now, actor, approve, approveLocalFailureRepair, assertLocalFailureApproval };
}

it.each(["read_scopes", "write_scopes", "operator_scopes", "candidate", "state", "halt", "stop", "verified", "claim", "intent", "approval", "null-intent", "owner", "no-binding", "no-publication"] as const)(
  "refuses approval without writing for %s", async condition => {
    const { f, id, candidate, store, now, actor, approveLocalFailureRepair } = await publicationFixture();
    try {
      let head = candidate;
      if (condition.endsWith("_scopes")) Object.assign(actor, { [condition]: [] });
      if (condition === "no-binding" || condition === "no-publication") {
        const mission = store.get(id), spec = JSON.parse(mission.spec_json);
        delete spec[condition === "no-binding" ? "local_failure_repair" : "publication"];
        vi.spyOn(store, "readable").mockReturnValue({ ...mission, spec_json: JSON.stringify(spec) });
      }
      if (condition === "candidate") head = "c".repeat(40);
      if (condition === "halt") store.record(id, "halted", { reason: "other" }, now);
      if (condition === "approval" || condition === "intent") store.record(id, condition === "approval" ? "verify_repair_approval" : "verify_repair_push_intent", {}, now);
      if (condition === "null-intent") store.record(id, "verify_repair_push_intent", null, now);
      if (condition === "owner") f.attention.claimOwner("replacement");
      if (condition === "claim") vi.spyOn(store, "claim").mockReturnValue({ ...store.claim(id), state: "released" });
      const update = condition === "state" ? "state='revalidating'" : condition === "stop" ? "stop_obligation=1" : condition === "verified" ? "candidate_verified=0" : undefined;
      if (update) f.db.prepare("UPDATE engineering_contained_missions SET revision=revision+1," + update + " WHERE mission_id=?").run(id);
      const before = store.events(id);
      expect(() => approveLocalFailureRepair(store, actor, id, head, now)).toThrow("verify_repair_approval_refused");
      expect(store.events(id)).toEqual(before);
    } finally { f.close(); }
  },
);

it("binds one approval to the live operator, candidate and dispatch", async () => {
  const { f, id, store, spec, now, actor, approve, assertLocalFailureApproval } = await publicationFixture();
  try {
    const mission = approve();
    expect(mission.state).toBe("revalidating");
    expect(store.events(id).filter(row => row.kind === "verify_repair_approved")).toHaveLength(1);
    expect(() => approve()).toThrow("verify_repair_approval_refused");
    expect(() => assertLocalFailureApproval(store, mission, spec, () => actor, now)).not.toThrow();
    for (const refresh of [undefined, () => ({ ...actor, operator_scopes: [] })])
      expect(() => assertLocalFailureApproval(store, mission, spec, refresh, now)).toThrow("verify_publish_authority_invalid");
    expect(() => assertLocalFailureApproval(store, mission, spec, () => actor, now + 900000)).toThrow("verify_publish_authority_invalid");
    expect(() => assertLocalFailureApproval(store, mission, { ...spec, worktree_path: "/different" }, () => actor, now)).toThrow("verify_publish_authority_invalid");
    expect(() => assertLocalFailureApproval(store, { ...mission, candidate_tree: "c".repeat(40) }, spec, () => actor, now)).toThrow("verify_publish_authority_invalid");
  } finally { f.close(); }
});

it.each(["published_head", "published_base", "grant_json", "withdrawal"] as const)("propagates the %s approval fence", async field => {
  const { f, approve } = await publicationFixture();
  try {
    if (field === "withdrawal") await withdraw(f);
    else f.db.prepare("UPDATE engineering_revision_chains SET revision=revision+1," + field + "=?").run(field === "grant_json" ? JSON.stringify(f.facts.grant) + " " : "f".repeat(40));
    expect(approve).toThrow(field === "published_head" ? "verify_stale_head" : field === "published_base" ? "verify_base_changed" : field === "withdrawal" ? "verify_source_revoked" : "verify_publish_authority_invalid");
  } finally { f.close(); }
});

it.each(["success", "withdraw", "expired", "disabled", "stale", "base", "merge", "chained", "lease", "not-written", "missing", "intent", "malformed", "concurrent", "null-intent", "post-base", "host-missing", "host-target", "closed", "ref-stale", "ref-missing", "lost-status"] as const)(
  "publishes or reconciles one local repair: %s", async scenario => {
    const { publishLocalFailureRepair, reconcileLocalFailurePush } = await import("./contained-mission-local-failure-publish.js");
    const { f, id, store, spec, candidate, tree, now, actor, approve } = await publicationFixture();
    try {
      const approved = approve();
      const mission = store.transition(id, { if_revision: approved.revision, to: "delivering", event: { kind: "delivery_intent", payload: {} } }, now);
      const permit = { mission_id: id, revision: mission.revision, spec_digest: mission.spec_digest, head: candidate, tree };
      const input = { mission, permit, spec, body: "", signal: new AbortController().signal, beforeRemoteMutation: () => {} };
      const { branch, base } = spec.local_failure_repair!, repository = spec.publication!.repository;
      const old = spec.start_commit, third = "f".repeat(40), ref = "refs/heads/" + branch;
      let pushes = 0, remote = scenario === "stale" || scenario === "ref-stale" ? third : old, missing = false;
      let process: import("@osstack/core").HostProcessRecord | undefined;
      const commands: string[][] = [];
      const deps: Parameters<typeof publishLocalFailureRepair>[1] = {
        store, now: () => now + (scenario === "expired" ? 900000 : 0), enabled: () => scenario !== "disabled",
        repository, refresh: () => actor, host: { recordForIntent: () => scenario === "host-missing" ? undefined : process },
        readPr: async () => missing ? null : { state: scenario === "closed" ? "closed" : "open", head: { sha: scenario === "ref-stale" ? old : scenario === "malformed" && pushes ? "" : remote }, base: { sha: scenario === "base" || (pushes && scenario === "post-base") ? third : base } },
        runner: { gated: true, run: async (command, args, options) => {
          expect(command).toBe("git");
          commands.push([...args]);
          let stdout = "", exitCode = 0;
          if (args.includes("ls-remote")) stdout = scenario === "ref-missing" ? "" : remote + "\t" + ref;
          else if (args.includes("remote")) stdout = "https://github.com/" + repository + ".git";
          else if (args.includes("rev-list")) stdout = candidate + " " + (scenario === "merge" ? old + " " + third : scenario === "chained" ? third : old);
          else {
            expect(args.slice(-5)).toEqual(["push", "--porcelain", "--force-with-lease=" + ref + ":" + old, "origin", candidate + ":" + ref]);
            const row = store.events(id).find(e => e.kind === "verify_repair_push_intent");
            expect(JSON.parse(row!.payload_json).intent_id).toBe(options.intentId);
            if (scenario === "withdraw") {
              await withdraw(f);
            }
            f.db.transaction(() => options.gate!.fence()).immediate();
            pushes++;
            remote = scenario === "lease" ? third : (scenario === "not-written" || scenario === "lost-status") ? old : candidate;
            exitCode = remote === candidate ? 0 : 1;
            missing = scenario === "missing";
            process = { op_id: "test", intent_id: options.intentId, mission_id: id, state: "stopped", released_at: now,
              remote_target: scenario === "host-target" ? "other" : repository + "#" + ref, kind: "git_push", exit_code: scenario === "lost-status" ? null : exitCode } as import("@osstack/core").HostProcessRecord;
            if (scenario === "lost-status") throw Error("transport closed");
          }
          return { stdout, stderr: "", exitCode };
        } },
      };
      if (scenario === "intent") store.record(id, "verify_repair_push_intent", { candidate: third }, now);
      if (scenario === "null-intent") store.record(id, "verify_repair_push_intent", null, now);
      const publish = () => publishLocalFailureRepair(input, deps);
      if (scenario === "concurrent") {
        await Promise.allSettled([publish(), publish()]);
        expect(store.events(id).filter(e => e.kind === "verify_repair_push_intent")).toHaveLength(1);
        expect(await reconcileLocalFailurePush(id, deps)).toBe("confirmed");
      } else if (scenario === "missing") {
        const { ContainedMissionRunner } = await import("./contained-mission-runner.js");
        const unused = async (): Promise<never> => { throw Error("unexpected port"); };
        store.record(id, "candidate_committed", { head_commit: candidate, tier: "T0" }, now);
        store.record(id, "verify_intent", { candidate }, now);
        store.record(id, "verify_receipt", { exit_code: 0, cancelled: false }, now);
        const runner = new ContainedMissionRunner({ store, now: deps.now, createWorkspace: unused, resumeWorkspace: unused,
          qualify: unused, execute: unused, readFile: unused, commit: unused, cumulativeDiff: unused, restoreWorkspace: unused,
          worktreeDiff: unused, commitWorktree: unused, verify: unused, publish: unused,
          remoteWriteReleasedSince: () => !!process?.released_at, localFailurePublication: { publish: input => publishLocalFailureRepair(input, deps) } });
        const halted = await runner.step(id);
        expect(halted.state).toBe("awaiting_decision");
        expect(JSON.parse(store.events(id).at(-1)!.payload_json).reason).toBe("verify_push_uncertain");
        expect(await runner.step(id)).toEqual(halted);
      } else if (scenario === "success") {
        expect(await publish()).toMatchObject({ pushed_commit: candidate, pr: { reused: true }, stop_proof_scope: "app_isolated" });
        await publish();
      } else {
        const errors: Record<string, string> = { withdraw: "verify_source_revoked", base: "verify_base_changed", lease: "verify_stale_head",
          stale: "verify_stale_head", "not-written": "verify_push_not_written", missing: "verify_push_uncertain", malformed: "verify_push_uncertain", "post-base": "verify_base_changed", "ref-stale": "verify_stale_head",
          "host-missing": "verify_push_uncertain", "host-target": "verify_push_uncertain", "ref-missing": "verify_stale_head", "lost-status": "verify_push_uncertain" };
        await expect(publish()).rejects.toThrow(errors[scenario] ?? "verify_publish_authority_invalid");
        if (scenario === "lease") await expect(publish()).rejects.toThrow("verify_stale_head");
      }
      if (scenario === "merge" || scenario === "chained") expect(store.events(id).some(e => e.kind === "verify_repair_push_intent")).toBe(false);
      if (scenario === "intent") expect(await reconcileLocalFailurePush(id, deps)).toBe("unknown");
      if (scenario === "post-base") expect(await reconcileLocalFailurePush(id, deps)).toBe("base_changed");
      if (scenario === "lease" || scenario === "not-written") expect(await reconcileLocalFailurePush(id, deps)).toBe(scenario === "lease" ? "stale_head" : "not_written");
      if (scenario === "missing" || scenario === "success") {
        commands.length = 0;
        if (missing) expect(await reconcileLocalFailurePush(id, deps)).toBe("unknown");
        missing = false;
        expect(await reconcileLocalFailurePush(id, deps)).toBe("confirmed");
        expect(commands.every(args => args.includes("ls-remote"))).toBe(true);
        expect(store.events(id).filter(e => e.kind === "verify_repair_push_confirmed")).toHaveLength(1);
      }
      if (scenario === "missing") expect(store.get(id).state).toBe("awaiting_decision");
      const released = ["success", "lease", "not-written", "missing", "malformed", "concurrent", "post-base", "host-missing", "host-target", "lost-status"];
      expect(pushes).toBe(released.includes(scenario) ? 1 : 0);
    } finally { f.close(); }
  },
);
