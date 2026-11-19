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

it.each(["success", "changed-ledger", "withdraw", "expired", "disabled", "stale", "base", "merge", "chained", "lease", "not-written", "missing", "intent", "malformed", "concurrent", "null-intent", "post-base", "host-missing", "host-target", "closed", "ref-stale", "ref-missing", "lost-status"] as const)(
  "publishes or reconciles one local repair: %s", async scenario => {
    const { publishLocalFailureRepair, reconcileLocalFailurePush } = await import("./contained-mission-local-failure-publish.js");
    const { f, id, store, spec, candidate, tree, now, actor, approve } = await publicationFixture();
    try {
      const { RevisionChainStore } = await import("@osstack/core");
      const chains = new RevisionChainStore(f.attention, f.owner);
      const confirmations = () => chains.events(f.facts.chain_id).filter(e => e.kind === "local_repair_push_confirmed");
      const assertChainConfirmed = () => {
        expect(chains.get(f.facts.chain_id).published_head).toBe(candidate);
        expect(confirmations()).toHaveLength(1);
      };
      const approved = approve();
      const mission = store.transition(id, { if_revision: approved.revision, to: "delivering", event: { kind: "delivery_intent", payload: {} } }, now);
      const permit = { mission_id: id, revision: mission.revision, spec_digest: mission.spec_digest, head: candidate, tree };
      const input = { mission, permit, spec, body: "", signal: new AbortController().signal, beforeRemoteMutation: () => {} };
      const { branch, base } = spec.local_failure_repair!, repository = spec.publication!.repository;
      const old = spec.start_commit, third = "f".repeat(40), ref = "refs/heads/" + branch;
      let clock = now + (scenario === "expired" ? 900000 : 0);
      let pushes = 0, remote = scenario === "stale" || scenario === "ref-stale" ? third : old, missing = false;
      let process: import("@osstack/core").HostProcessRecord | undefined;
      const commands: string[][] = [];
      const deps: Parameters<typeof publishLocalFailureRepair>[1] = {
        store, now: () => clock, enabled: () => scenario !== "disabled",
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
            if (scenario === "changed-ledger") {
              f.db.prepare("UPDATE engineering_revision_chains SET revision=revision+1,published_head=? WHERE chain_id=?").run(third, f.facts.chain_id);
            }
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
        store.record(id, "verify_receipt", { exit_code: 0, cancelled: false, evidence: "fixture" }, now);
        const runner = new ContainedMissionRunner({ store, now: deps.now, createWorkspace: unused, resumeWorkspace: unused,
          qualify: unused, execute: unused, readFile: unused, commit: unused, cumulativeDiff: unused, restoreWorkspace: unused,
          worktreeDiff: unused, commitWorktree: unused, verify: unused, publish: unused,
          remoteWriteReleasedSince: () => !!process?.released_at, localFailurePublication: { publish: input => publishLocalFailureRepair(input, deps) } });
        const halted = await runner.step(id);
        expect(halted.state).toBe("awaiting_decision");
        expect(JSON.parse(store.events(id).at(-1)!.payload_json).reason).toBe("verify_push_uncertain");
        expect(await runner.step(id)).toEqual(halted);
        expect(await reconcileLocalFailurePush(id, deps)).toBe("unknown");
        expect(confirmations()).toHaveLength(0);
        missing = false;
        const afterPush = commands.length;
        expect(await reconcileLocalFailurePush(id, deps)).toBe("confirmed");
        assertChainConfirmed();
        expect(store.get(id).state).toBe("awaiting_decision");
        expect(await runner.resumeConfirmedLocalPublication(id)).toMatchObject({ state: "pr_opened" });
        const evidence = store.events(id).find(e => e.kind === "delivery_evidence");
        expect(JSON.parse(evidence!.payload_json)).toMatchObject({ branch, head: candidate });
        expect(commands.slice(afterPush).every(args => args.includes("ls-remote"))).toBe(true);
        expect(commands.filter(args => args.includes("push"))).toHaveLength(1);
        assertChainConfirmed();
      } else if (scenario === "success") {
        expect(await publish()).toMatchObject({ pushed_commit: candidate, pr: { reused: true }, stop_proof_scope: "app_isolated" });
        assertChainConfirmed();
        clock = now + 900000;
        await withdraw(f);
        const afterPush = commands.length;
        expect(await publish()).toMatchObject({ pushed_commit: candidate });
        expect(commands.slice(afterPush).map(args => args[0])).toEqual(["ls-remote"]);
        assertChainConfirmed();
      } else {
        const errors: Record<string, string> = { "changed-ledger": "verify_push_uncertain", withdraw: "verify_source_revoked", base: "verify_base_changed", lease: "verify_stale_head",
          stale: "verify_stale_head", "not-written": "verify_push_not_written", missing: "verify_push_uncertain", malformed: "verify_push_uncertain", "post-base": "verify_base_changed", "ref-stale": "verify_stale_head",
          "host-missing": "verify_push_uncertain", "host-target": "verify_push_uncertain", "ref-missing": "verify_stale_head", "lost-status": "verify_push_uncertain" };
        await expect(publish()).rejects.toThrow(errors[scenario] ?? "verify_publish_authority_invalid");
        if (scenario === "lease") await expect(publish()).rejects.toThrow("verify_stale_head");
      }
      if (scenario === "changed-ledger") {
        expect(await reconcileLocalFailurePush(id, deps)).toBe("unknown");
        expect(chains.get(f.facts.chain_id).published_head).toBe(third);
        expect(confirmations()).toHaveLength(0);
        expect(store.events(id).filter(e => e.kind === "verify_repair_push_confirmed")).toHaveLength(0);
      }
      if (scenario === "merge" || scenario === "chained") expect(store.events(id).some(e => e.kind === "verify_repair_push_intent")).toBe(false);
      if (scenario === "intent") expect(await reconcileLocalFailurePush(id, deps)).toBe("unknown");
      if (scenario === "post-base") expect(await reconcileLocalFailurePush(id, deps)).toBe("base_changed");
      if (scenario === "lease" || scenario === "not-written") expect(await reconcileLocalFailurePush(id, deps)).toBe(scenario === "lease" ? "stale_head" : "not_written");
      if (scenario === "missing" || scenario === "success") {
        commands.length = 0;
        expect(await reconcileLocalFailurePush(id, deps)).toBe("confirmed");
        assertChainConfirmed();
        expect(commands.every(args => args.includes("ls-remote"))).toBe(true);
        expect(store.events(id).filter(e => e.kind === "verify_repair_push_confirmed")).toHaveLength(1);
      }
      const released = ["success", "changed-ledger", "lease", "not-written", "missing", "malformed", "concurrent", "post-base", "host-missing", "host-target", "lost-status"];
      expect(pushes).toBe(released.includes(scenario) ? 1 : 0);
    } finally { f.close(); }
  },
);

it.each(["aborted", "owner", "claim", "state", "mission-id", "spec-digest", "worktree", "candidate-head", "candidate-tree", "stop"] as const)(
  "checks %s before reading back an existing local repair push", async condition => {
    const { publishLocalFailureRepair } = await import("./contained-mission-local-failure-publish.js");
    const { f, id, store, spec, candidate, tree, now, actor, approve } = await publicationFixture();
    try {
      const approved = approve();
      const mission = store.transition(id, { if_revision: approved.revision, to: "delivering", event: { kind: "delivery_intent", payload: {} } }, now);
      const { pr, branch, base } = spec.local_failure_repair!;
      store.record(id, "verify_repair_push_intent", {
        intent_id: "vrp_12345678-1234-1234-1234-123456789abc", pr, branch, base, previous: spec.start_commit, candidate,
      }, now);
      const permit = { mission_id: id, revision: mission.revision, spec_digest: mission.spec_digest, head: candidate, tree };
      const controller = new AbortController();
      if (condition === "aborted") controller.abort();
      if (condition === "owner") f.attention.claimOwner("replacement");
      if (condition === "claim") vi.spyOn(store, "claim").mockReturnValue({ ...store.claim(id), state: "released" });
      if (condition === "state") vi.spyOn(store, "get").mockReturnValue({ ...mission, state: "awaiting_decision" });
      if (condition === "mission-id") permit.mission_id = "other";
      if (condition === "spec-digest") permit.spec_digest = "other";
      if (condition === "worktree") spec.worktree_path += "-other";
      if (condition === "candidate-head") vi.spyOn(store, "get").mockReturnValue({ ...mission, candidate_head: "a".repeat(40) });
      if (condition === "candidate-tree") permit.tree = "a".repeat(40);
      if (condition === "stop") vi.spyOn(store, "get").mockReturnValue({ ...mission, stop_obligation: 1 });
      const readPr = vi.fn(async () => null);
      const run = vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "" }));
      const recordForIntent = vi.fn(() => undefined);
      const before = store.events(id);
      await expect(publishLocalFailureRepair(
        { mission, permit, spec, body: "", signal: controller.signal, beforeRemoteMutation: () => {} },
        { store, now: () => now, enabled: () => true, refresh: () => actor, repository: spec.publication!.repository, host: { recordForIntent }, readPr, runner: { gated: true, run } },
      )).rejects.toThrow("verify_publish_authority_invalid");
      expect(recordForIntent).not.toHaveBeenCalled();
      expect(readPr).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(store.events(id)).toEqual(before);
    } finally { f.close(); }
  },
);

it.each(["merged", "closed after withdrawal", "closed after supersession"] as const)(
  "projects local repair close-out until %s, then replays it", async terminal => {
  const { readLocalFailureCloseout } = await import("./contained-mission-local-failure-closeout.js");
  const { RevisionChainStore } = await import("@osstack/core");
  const { LocalFailureRecheckStore, parseVerificationResultV1, verificationDedupKey } = await import("@osstack/core/verification-intake");
  const { passedVerificationFixture } = await import("@osstack/core/dist/bridge/verification-result-fixtures.js");
  const { createHash, randomUUID } = await import("node:crypto");
  const { f, id, store, candidate, now } = await publicationFixture();
  try {
    const chains = new RevisionChainStore(f.attention, f.owner);
    const ledger = new LocalFailureRecheckStore(f.store);
    const { base_sha: base, branch, pr, repository } = f.v;
    store.record(id, "verify_repair_push_confirmed", { previous: f.v.head_sha, base, candidate, branch, pr }, now);
    const chain = chains.confirmLocalRepairPush({ child_mission_id: id, new_head: candidate }, now);
    const events = () => chains.events(chain.chain_id).filter(e => e.kind === "local_repair_closeout");
    const tables = ["contained_missions", "local_failure_dispatches", "local_failure_rechecks", "verification_sources"];
    const counts = () => tables.map(t => f.db.prepare("SELECT COUNT(*) FROM engineering_" + t).pluck().get());
    const snapshot: Pick<import("@osstack/core/verification-intake").VerificationGateInput, "pr" | "reviews" | "threads"> = {
      pr: { complete: true, state: "OPEN", head_oid: candidate, base_ref_name: chain.base_ref, base_tip_oid: base,
        merged_head_oid: null, merge_commit_oid: null, merge_base_oid: null, merged_by: null },
      threads: { complete: true, unresolved: 0 }, reviews: { complete: true, items: [] },
    };
    const readPr = vi.fn(async (target: {repository: string; pr: number}, signal: AbortSignal) => {
      expect(target).toEqual({ repository, pr }); expect(signal).toBeInstanceOf(AbortSignal);
      return snapshot;
    });
    const deps = { store, now: () => now, countedApprovers: [1], readPr };
    const read = () => readLocalFailureCloseout(deps, id);
    const writes = () => Number(f.db.prepare("SELECT total_changes()").pluck().get());
    let before = writes();
    await expect(readLocalFailureCloseout(deps, "absent")).rejects.toThrow("verify_closeout_unknown_child");
    expect(writes()).toBe(before); expect(readPr).not.toHaveBeenCalled();
    const initial = counts();
    const first = await read();
    expect(first).toMatchObject({ chain_id: chain.chain_id, pr, recheck_id: null, state: "reverify_pending", hold: true });
    expect(await read()).toEqual(first);
    expect(events()).toHaveLength(1); expect(writes()).toBe(before + 1); expect(counts()).toEqual(initial);
    readPr.mockRejectedValueOnce(Error("unreadable"));
    expect(await read()).toMatchObject({ state: "awaiting_decision", reason: "verify_merge_unverified" });
    const row = ledger.open({ child_mission_id: id, original_contract_text: f.input.contract_text, now });
    Object.assign(snapshot.pr, { state: "MERGED", merged_head_oid: candidate, merge_commit_oid: "e".repeat(40),
      merge_base_oid: base, merged_by: { type: "User", id: 2 } });
    expect(await read()).toMatchObject({ reason: "verify_merge_unverified", recheck_id: row.recheck_id });
    const wire = { ...passedVerificationFixture(), head_sha: candidate, result_id: randomUUID() };
    wire.dedup_key = verificationDedupKey(wire);
    function register(value: unknown, object_id: number) {
      const contract_text = JSON.stringify(value);
      const parsed = parseVerificationResultV1(contract_text);
      if (!parsed.ok) throw Error(parsed.code);
      const digest = createHash("sha256").update(contract_text).digest("hex");
      f.source.record([{ source_kind: "check_run", object_id, repository_id: f.v.repository_id, repository, pr,
        observed_head_sha: candidate, app_id: 201, check_name: "fixture", response_digest: digest, contract_digest: digest,
        verdict: { ok: true }, result: parsed.result }], now, now);
      return { contract_text, digest, source_seq: f.source.registration(parsed.result.result_id)!.registered.seq };
    }
    const result = register(wire, 2), digest = result.digest;
    // Issue the fixture proof in the same compiled core instance that evaluates it.
    const { issueHostRecheckProof } = await import("../../core/dist/bridge/recheck-host-proof.js");
    expect(ledger.evaluate({ recheck_id: row.recheck_id, now,
      result,
      actions: { head_sha: candidate, attempt: 2, complete: true, conclusion: "success", digest },
      host: issueHostRecheckProof({ receipt_id: "fixture", receipt_digest: digest, head_sha: candidate, base_sha: base,
        profile_digest: row.profile_digest, trusted_source_digest: row.trusted_source_digest, outcome: "passed" }) }).state).toBe("recheck_passed");
    let finalCounts = counts();
    before = writes();
    let prior = events().length;
    snapshot.pr.base_ref_name = "retargeted";
    expect(await read()).toMatchObject({ state: "awaiting_decision", reason: "verify_merge_unverified", hold: true,
      verified_base_sha: base, merged_onto_oid: base });
    snapshot.pr.base_ref_name = chain.base_ref;
    snapshot.pr.state = "OPEN";
    expect(await read()).toMatchObject({ reason: "verify_approval_required", hold: true,
      verified_base_sha: null, merged_onto_oid: null });
    snapshot.reviews.items = [{ review_id: 3, state: "APPROVED", submitted_at_ms: 1, commit_oid: candidate,
      author_type: "User", author_id: 1, author_can_push: true }];
    expect(await read()).toMatchObject({ state: "ready_for_human", reason: null, hold: false });
    if (terminal !== "merged") {
      expect(writes() - before).toBe(events().length - prior);
      expect(counts()).toEqual(finalCounts);
      // Revoke the accepted result during readPr. Projection must reload the ledger under the fence.
      readPr.mockImplementationOnce(async () => {
        const change = terminal === "closed after withdrawal"
          ? { outcome: "cancelled", checks: [], withdraws_result_id: wire.result_id, withdraw_reason_code: "revoked" }
          : { supersedes_result_id: wire.result_id };
        register({ ...wire, result_id: randomUUID(), attempt: 2, ...change }, 3);
        before = writes();
        prior = events().length;
        finalCounts = counts();
        return snapshot;
      });
      expect(await read()).toMatchObject({ state: "reverify_pending", reason: "verify_recheck_missing", hold: true });
    }
    snapshot.pr.state = terminal === "merged" ? "MERGED" : "CLOSED";
    snapshot.pr.merge_base_oid = "d".repeat(40);
    const last = await read();
    expect(last).toMatchObject({ state: terminal === "merged" ? "merged" : "closed_unmerged", reason: null, hold: true });
    const terminalBases = terminal === "merged" ? { verified_base_sha: base, merged_onto_oid: snapshot.pr.merge_base_oid } : { verified_base_sha: null, merged_onto_oid: null };
    if (terminal === "merged") expect(terminalBases.merged_onto_oid).not.toBe(base);
    expect(last).toMatchObject(terminalBases);
    expect(JSON.parse(events().at(-1)!.payload_json)).toMatchObject(terminalBases);
    const calls = readPr.mock.calls.length;
    expect(await read()).toEqual(last); expect(readPr).toHaveBeenCalledTimes(calls);
    expect(events().filter(e => JSON.parse(e.payload_json).state === last.state)).toHaveLength(1);
    expect(writes() - before).toBe(events().length - prior);
    expect(counts()).toEqual(finalCounts); expect(chains.get(chain.chain_id)).toEqual(chain);
    const legacy = JSON.parse(events().at(-1)!.payload_json);
    delete legacy.verified_base_sha;
    delete legacy.merged_onto_oid;
    chains.appendEvent(chain.chain_id, "local_repair_closeout", legacy, now);
    expect(await read()).toMatchObject({ state: last.state, verified_base_sha: null, merged_onto_oid: null });
    expect(readPr).toHaveBeenCalledTimes(calls);
  } finally { f.close(); }
});
