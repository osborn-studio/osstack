import { RevisionChainStore, ContainedMissionStore } from "@osstack/core";
import { dispatchRevision } from "./contained-mission-revision.js";
import { readPullRequest } from "./contained-mission-bridge-reader.js";
import { scriptedTransport } from "./contained-mission-bridge-shadow.testkit.js";
import { changesRequested, PUBLISHER, REVIEWER } from "./contained-mission-revision.testkit.js";
import { createHash } from "node:crypto";
import type { DeliveryCommandRunner } from "@osstack/github";
import { verifyBridgeLedger } from "./contained-mission-bridge-ledger.js";
import { ContainedMissionHost } from "./contained-mission-host.js";
import { HostProcessKit } from "./contained-mission-host-process.js";
import type { ContainedMissionHostPorts } from "./contained-mission-ports.js";
import { createLocalFailurePublicationPort } from "./contained-mission-local-failure-publication-port.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkLocalFailureRepairPaths,
  dispatchLocalFailureRepair,
  recoverLocalFailureDispatch,
  type LocalFailureDispatchPorts,
} from "./contained-mission-local-failure-dispatch.js";
import { diagnosisFixture, diagnosisRenewal, eligibleRequest } from "@osstack/core/dist/state/diagnosis-fixtures.js";
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
    // The ledger accepts a host proof only from a settled, passed recheck run (migration 63).
    const { LocalFailureRecheckRunStore } = await import("@osstack/core/verification-intake");
    const { localFailureBindingFromLedger } = await import("@osstack/core");
    f.db.prepare("UPDATE engineering_contained_missions SET state='failed',stop_obligation=0,revision=revision+1 WHERE mission_id=?").run(id);
    const grantJson = f.db.prepare("SELECT grant_json FROM engineering_revision_chains WHERE chain_id=?").pluck().get(chain.chain_id) as string;
    const runs = new LocalFailureRecheckRunStore(f.store, () => now);
    const reserved = runs.reserve({ recheck_id: row.recheck_id, tree_sha: "a".repeat(40), grant_id: JSON.parse(grantJson).grant_id,
      grant_digest: createHash("sha256").update(grantJson).digest("hex"), invocation_id: randomUUID(), journal_ref: "recheck",
      container_cap_seconds: 12, now }).run;
    const running = runs.start(reserved.run_id, reserved.revision);
    runs.settleStopped(running.run_id, running.revision, { container_used_seconds: 2, run_identity_digest: "4".repeat(64),
      receipt: { ...localFailureBindingFromLedger(running), version: 1, started_at: running.started_at!, finished_at: running.started_at!,
        outcome: "passed", checks: [{ check_id: row.failed_check_id, category: "test", exit_code: 0, result_digest: "1".repeat(64) }],
        bounded_redacted_summary: "fixture", evidence_digest: "2".repeat(64),
        stop: { proven: true, proof_ref: "stop", proof_digest: "3".repeat(64) } } });
    expect(ledger.evaluate({ recheck_id: row.recheck_id, now,
      result,
      actions: { head_sha: candidate, attempt: 2, complete: true, conclusion: "success", digest },
      host: runs.hostProof(row.recheck_id)! }).state).toBe("recheck_passed");
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

it.each([
  { first: "review", rounds: 1 }, { first: "local", rounds: 1 }, { first: "local", rounds: 2 },
] as const)("shares $rounds round(s) with $first first on one signed V2 chain", async ({ first, rounds }) => {
  const f = diagnosisFixture({ rounds, allowedPaths: ["src/**"], protectedDigest: missionProtectedSetDigest() });
  try {
    const p = portsFor(f);
    const chains = new RevisionChainStore(f.attention, f.owner);
    const missions = new ContainedMissionStore(f.attention, f.owner);
    const chain = () => chains.get(f.facts.chain_id);
    const count = () => f.db.prepare("SELECT COUNT(*) AS n FROM engineering_contained_missions").get();
    const r = eligibleRequest(f);
    const local = () => dispatchLocalFailureRepair(p, r.request_id);
    const review = () => dispatchRevision({
      chains, missions, access: p.access, keys: p.keys, now: p.now, launchCaps: p.launchCaps,
      worktreesRoot: f.root, enabled: () => true, protectedSetDigest: missionProtectedSetDigest,
      registry: { publisher: [PUBLISHER], reviewers: [REVIEWER] },
      readPr: async ref => {
        const head = chain().published_head;
        const pr = await readPullRequest(scriptedTransport(() => ({ state: "OPEN", head, base_ref: f.v.base_ref,
          base_sha: f.v.base_sha, author: PUBLISHER, reviews: [changesRequested(77, head)] })).transport, ref);
        if (pr.complete) Object.assign(pr.pr, { headRefName: f.v.branch, headRepository: f.v.repository });
        return pr;
      },
    }, f.facts.chain_id);
    // As in the revision rig's finishRound, settle the child without touching the shared counter.
    const finish = (id: string) => {
      f.db.prepare("UPDATE engineering_contained_missions SET state='failed',revision=revision+1 WHERE mission_id=?").run(id);
      missions.releaseClaim(id, "revision_settled", f.facts.now);
    };
    if (first === "review") {
      const child = await review();
      if (child.status !== "dispatched") throw Error(JSON.stringify(child));
      expect(chain().rounds_used).toBe(1);
      expect(local()).toMatchObject({ status: "refused", reason: "verify_chain_busy" });
      finish(child.child_mission_id);
      chains.voidReservation(f.facts.chain_id, chain().revision, r.head_sha, "child_halted", f.facts.now);
      f.db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',stop_reason=NULL,revision=revision+1 WHERE chain_id=?").run(f.facts.chain_id);
      expect(local()).toMatchObject({ status: "refused", reason: "verify_repair_limit" });
      expect(count()).toEqual({ n: 2 });
      return;
    }
    const child = local();
    if (child.status !== "dispatched") throw Error(child.reason);
    expect(chain().rounds_used).toBe(1);
    if (rounds === 2) expect(await review()).toEqual({ status: "conflict", code: "chain_busy" });
    finish(child.child_mission_id);
    if (rounds === 1) {
      expect(await review()).toEqual({ status: "no_reserve", reason: "stop" });
      expect(count()).toEqual({ n: 2 });
    } else {
      const second = await review();
      expect(second).toMatchObject({ status: "dispatched", round: 2 });
      expect(chain().rounds_used).toBe(2);
      if (second.status !== "dispatched") throw Error(JSON.stringify(second));
      finish(second.child_mission_id);
      chains.voidReservation(f.facts.chain_id, chain().revision, r.head_sha, "published", f.facts.now);
      f.db.prepare("UPDATE engineering_revision_chains SET state='awaiting_review',published_head=?,stop_reason=NULL,revision=revision+1 WHERE chain_id=?")
        .run("d".repeat(40), f.facts.chain_id);
      expect(await review()).toEqual({ status: "no_reserve", reason: "stop" });
      expect(count()).toEqual({ n: 3 });
    }
  } finally { f.close(); }
});

it.each(["waiting", "approved"] as const)("handles grant expiry with a %s repair candidate", async state => {
  const { ContainedMissionRunner } = await import("./contained-mission-runner.js");
  const { publishLocalFailureRepair } = await import("./contained-mission-local-failure-publish.js");
  const { f, id, store, spec, actor, candidate, tree, approveLocalFailureRepair } = await publicationFixture();
  try {
    const expiry = f.facts.grant.expires_at;
    let clock = state === "waiting" ? expiry : expiry - 1;
    const approve = () => approveLocalFailureRepair(store, actor, id, candidate, clock);
    const approvals = () => store.events(id).filter(event => event.kind === "verify_repair_approval");
    const renew = () => diagnosisRenewal(f, clock).replace();
    if (state === "waiting") {
      expect(approve).toThrow("verify_publish_authority_invalid");
      expect(store.get(id).state).toBe("awaiting_decision");
      renew();
      expect(approvals()).toHaveLength(0);
    }
    const approved = approve();
    expect(approvals()).toHaveLength(1);
    const mission = store.transition(id, { if_revision: approved.revision, to: "delivering",
      event: { kind: "delivery_intent", payload: {} } }, clock);
    store.record(id, "candidate_committed", { head_commit: candidate, tier: "T0" }, clock);
    store.record(id, "verify_intent", { candidate }, clock);
    store.record(id, "verify_receipt", { exit_code: 0, cancelled: false, evidence: "fixture" }, clock);
    clock = expiry;
    const repository = spec.publication!.repository, ref = "refs/heads/" + spec.local_failure_repair!.branch;
    let head = spec.start_commit, pushes = 0;
    let process: import("@osstack/core").HostProcessRecord | undefined;
    const deps: Parameters<typeof publishLocalFailureRepair>[1] = {
      store, now: () => clock, repository, enabled: () => true, refresh: () => actor,
      host: { recordForIntent: () => process },
      readPr: async () => ({ state: "open", head: { sha: head }, base: { sha: spec.local_failure_repair!.base } }),
      runner: { gated: true, run: async (_command, args, options) => {
        let stdout = "";
        if (args.includes("ls-remote")) stdout = head + "\t" + ref;
        else if (args.includes("remote")) stdout = "https://github.com/" + repository + ".git";
        else if (args.includes("rev-list")) stdout = candidate + " " + spec.start_commit;
        else {
          expect(args.slice(-5)).toEqual(["push", "--porcelain", "--force-with-lease=" + ref + ":" + head, "origin", candidate + ":" + ref]);
          f.db.transaction(() => options.gate!.fence()).immediate();
          pushes++;
          head = candidate;
          process = { op_id: "test", intent_id: options.intentId, mission_id: id, state: "stopped", released_at: clock,
            remote_target: repository + "#" + ref, kind: "git_push", exit_code: 0 } as import("@osstack/core").HostProcessRecord;
        }
        return { stdout, stderr: "", exitCode: 0 };
      } },
    };
    const unused = async (): Promise<never> => { throw Error("unexpected port"); };
    const runner = new ContainedMissionRunner({ store, now: deps.now, createWorkspace: unused, resumeWorkspace: unused,
      qualify: unused, execute: unused, readFile: unused, commit: unused, cumulativeDiff: unused, restoreWorkspace: unused,
      worktreeDiff: unused, commitWorktree: unused, verify: unused, publish: unused,
      localFailurePublication: { publish: input => publishLocalFailureRepair(input, deps) } });
    const result = await runner.step(id);
    if (state === "waiting") {
      expect(result.state).toBe("pr_opened");
      expect(new RevisionChainStore(f.attention, f.owner).get(f.input.chain_id).published_head).toBe(candidate);
      expect(pushes).toBe(1);
    } else {
      expect(result.state).toBe("awaiting_decision");
      expect(JSON.parse(store.events(id).at(-1)!.payload_json).reason).toBe("verify_publish_authority_invalid");
      expect(renew).toThrow("grant_renewal_busy");
      expect(approve).toThrow("verify_repair_approval_refused");
      expect(runner.decideImmediate(result, { kind: "abandon" }).state).toBe("abandoned");
      renew();
      expect(approve).toThrow("verify_repair_approval_refused");
      const permit = { mission_id: id, revision: mission.revision, head: candidate, tree, spec_digest: mission.spec_digest };
      await expect(publishLocalFailureRepair({ mission, permit, spec, body: "", signal: new AbortController().signal,
        beforeRemoteMutation: () => {} }, deps)).rejects.toThrow("verify_publish_authority_invalid");
      expect(approvals()).toHaveLength(1);
      expect(pushes).toBe(0);
    }
  } finally { f.close(); }
});

describe("attached local-failure publisher and startup recovery", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { for (const close of cleanups.splice(0)) close(); });

  async function fixtureWithRemote(remote: string) {
    // Dispatch copies the authorized root's remote to the child.
    const authorize = ContainedMissionStore.prototype.authorize;
    const root = vi.spyOn(ContainedMissionStore.prototype, "authorize").mockImplementationOnce(function (this: ContainedMissionStore, principal, input, now) {
      const publication = input.spec.publication as Record<string, unknown>;
      return authorize.call(this, principal, { ...input, spec: { ...input.spec, publication: { ...publication, remote } } }, now);
    });
    try { return await publicationFixture(); } finally { root.mockRestore(); }
  }

  async function setup(options: { otherRemote?: boolean; exitCode?: number; unavailable?: boolean } = {}) {
    const { f, id, store, spec, candidate, now, actor, approve } = await (options.otherRemote ? fixtureWithRemote("upstream") : publicationFixture());
    cleanups.push(f.close);
    const { base, branch } = spec.local_failure_repair!, repository = spec.publication!.repository, old = spec.start_commit;
    approve();
    store.record(id, "candidate_committed", { head_commit: candidate, tier: "T0" }, now);
    store.record(id, "verify_intent", { candidate }, now);
    store.record(id, "verify_receipt", { exit_code: 0, cancelled: false, evidence: "fixture" }, now);

    const state = { clock: now, enabled: true, withdraw: false, readable: true, hideAfterRelease: false,
      remote: old, prBase: base, repository, branch, pushes: 0 };
    const kit = new HostProcessKit(store, { markerDir: f.root }, () => state.clock);
    const unexpected = async (): Promise<never> => { throw Error("unexpected port"); };
    const run = vi.fn<DeliveryCommandRunner["run"]>(async (_command, args, opts) => {
      let stdout = "";
      const ref = "refs/heads/" + branch;
      if (args.includes("ls-remote")) stdout = state.remote + "\t" + ref;
      else if (args.includes("remote")) stdout = "https://github.com/" + repository + ".git";
      else if (args.includes("rev-list")) stdout = candidate + " " + old;
      else {
        expect(args.slice(-5)).toEqual(["push", "--porcelain", "--force-with-lease=" + ref + ":" + old, "origin", candidate + ":" + ref]);
        const gate = opts.gate!, op = "hp_fixture";
        kit.hp.launching({ op_id: op, mission_id: id, kind: "git_push", remote_target: gate.remoteTarget, local_target: spec.worktree_path,
          intent_id: opts.intentId!, argv_digest: "a".repeat(64), boot_id: "fixture", marker: { path: "/fixture/marker", dev: "1", ino: "1" } });
        kit.hp.registered(op, { pid: 12345, pgid: 12345, leader_start: "fixture" });
        if (state.withdraw) await withdraw(f);
        try { kit.hp.release(op, gate.fence); }
        catch (error) { kit.hp.stopped(op, { proof: "never_released", detail: {} }); throw error; }
        state.pushes++;
        state.remote = candidate;
        state.readable = !state.hideAfterRelease;
        kit.hp.stopped(op, { proof: "group_empty+marker_unheld", detail: {}, exit_code: options.exitCode ?? null });
        if (options.exitCode === undefined) throw Error("lost process status");
        return { stdout, stderr: "", exitCode: options.exitCode };
      }
      return { stdout, stderr: "", exitCode: 0 };
    });
    const check = vi.fn(async () => ({ check_run_id: 7, created: true }));
    const ports: ContainedMissionHostPorts = { store, hostProcesses: kit, now: () => state.clock, publishVerifyCheck: check,
      verify: unexpected, publish: unexpected, verificationStopped: unexpected, createWorkspace: unexpected, resumeWorkspace: unexpected,
      qualify: unexpected, execute: unexpected, readFile: unexpected, commit: unexpected, cumulativeDiff: unexpected,
      restoreWorkspace: unexpected, worktreeDiff: unexpected, commitWorktree: unexpected,
      remoteWriteReleasedSince: (key, since) => kit.remoteReleasedSince(key, since),
      revisionPublicationAdapters: async () => ({ runner: { gated: true, run }, localGit: unexpected, preflight: unexpected }) };
    const host = new ContainedMissionHost({ ports });
    const resume = vi.spyOn(host, "resumeConfirmedLocalPublication");
    const readPr = vi.fn(async (repo: string, number: number, _signal: AbortSignal) => {
      expect([repo, number]).toEqual([repository, spec.local_failure_repair!.pr]);
      if (!state.readable) throw Error("read unavailable");
      return { repository: state.repository.toUpperCase(), state: "OPEN" as const, headRefName: state.branch, headRefOid: state.remote,
        baseRefName: "main", baseRefOid: state.prBase, url: "fixture" };
    });
    const log = vi.fn();
    const port = await createLocalFailurePublicationPort({ missions: store, ports, host, repository: options.unavailable ? "" : repository,
      readPr, log, now: ports.now, enabled: () => state.enabled, access: { refresh: () => actor } });
    const chains = new RevisionChainStore(f.attention, f.owner);
    const chain = () => chains.get(f.facts.chain_id);
    const events = (kind: string) => store.events(id).filter(e => e.kind === kind);
    const confirmations = () => chains.events(chain().chain_id).filter(e => e.kind === "local_repair_push_confirmed");
    const step = () => host.runner.step(id);
    const uncertain = async () => {
      state.hideAfterRelease = true;
      const halted = await step();
      expect(halted.state).toBe("awaiting_decision");
      expect(JSON.parse(events("halted").at(-1)!.payload_json).reason).toBe("verify_push_uncertain");
      expect(await step()).toEqual(halted);
      expect(state.pushes).toBe(1);
      return halted;
    };
    return { id, f, store, spec, old, state, candidate, now, actor, run, resume, check, chain, chains, events, confirmations,
      readPr, log, recover: port.recover, step, uncertain, signal: new AbortController().signal };
  }

  it("publishes one approved candidate", async () => {
    const t = await setup();
    expect((await t.step()).state).toBe("pr_opened");
    expect(t.state.pushes).toBe(1);
    expect(t.confirmations()).toHaveLength(1);
    expect(t.chain().published_head).toBe(t.candidate);
    expect(t.check).toHaveBeenCalledOnce();
  });

  it.each(["expired", "withdrawn", "disabled", "remote", "fork", "branch"])("refuses publication for %s", async why => {
    const t = await setup({ otherRemote: why === "remote" });
    if (why === "expired") t.state.clock += 900000;
    if (why === "withdrawn") t.state.withdraw = true;
    if (why === "disabled") t.state.enabled = false;
    if (why === "fork") t.state.repository = "fixture/fork";
    if (why === "branch") t.state.branch += "-other";
    expect((await t.step()).state).toBe("awaiting_decision");
    expect(t.state.pushes).toBe(0);
    expect(JSON.parse(t.events("halted").at(-1)!.payload_json).reason).toBe(why === "withdrawn" ? "verify_source_revoked" : "verify_publish_authority_invalid");
    if (why !== "withdrawn") expect(t.events("verify_repair_push_intent")).toHaveLength(0);
    if (why === "remote") {
      expect(t.run).not.toHaveBeenCalled();
      expect(t.readPr).not.toHaveBeenCalled();
    }
  });

  it("confirms a landed push once, resumes through the host and completes the commit audit", async () => {
    const t = await setup(), c = t.chain(), commits = [t.old];
    const baseline = t.chains.recordIntent(c.chain_id, c.revision, { kind: "open_pr", expected_old_head: JSON.parse(t.store.get(c.root_mission_id).spec_json).start_commit,
      branch: c.branch, expected_base_sha: c.published_base, new_head: t.old,
      binding: { commit_count: 1, range_sha256: createHash("sha256").update(JSON.stringify(commits)).digest("hex") } }, t.now).intent;
    t.chains.appendEvent(c.chain_id, "push_range", { intent_id: baseline.intent_id, commits }, t.now);
    t.chains.settleIntent(baseline.intent_id, "confirmed", t.now);
    const audit = () => verifyBridgeLedger({ chains: t.chains, missions: t.store, compare: async () => [...commits, t.candidate],
      remoteHead: async () => t.state.remote }, t.chain(), t.signal);
    await t.uncertain();
    expect(await audit()).toBe("reconciliation_incomplete");
    t.state.readable = true;
    await t.recover(t.signal);
    expect(t.readPr.mock.calls.some(([, , signal]) => signal === t.signal)).toBe(true);
    expect(t.resume).toHaveBeenCalledExactlyOnceWith(t.id);
    expect(t.store.get(t.id).state).toBe("pr_opened");
    expect(await audit()).toBe("matched");
    t.readPr.mockClear(); t.run.mockClear();
    await t.recover(t.signal);
    expect(t.readPr).not.toHaveBeenCalled();
    expect(t.run).not.toHaveBeenCalled();
    expect(t.resume).toHaveBeenCalledOnce();
    expect(t.events("verify_repair_push_confirmed")).toHaveLength(1);
    expect(t.confirmations()).toHaveLength(1);
    expect(t.state.pushes).toBe(1);
    expect(t.check).not.toHaveBeenCalled();
  });

  it.each(["unknown", "not_written", "stale_head", "base_changed"])("logs %s and preserves the child", async outcome => {
    const t = await setup(outcome === "not_written" ? { exitCode: 1 } : {});
    const halted = await t.uncertain();
    t.state.readable = true;
    t.state.remote = outcome === "stale_head" ? "f".repeat(40) : t.old;
    if (outcome === "base_changed") t.state.prBase = "f".repeat(40);
    const before = t.store.events(t.id);
    await t.recover(t.signal);
    expect(t.log.mock.calls).toEqual([[`osstack: local-failure route: reconcile ${t.id}: ${outcome}`]]);
    expect(t.resume).not.toHaveBeenCalled();
    expect(t.store.get(t.id)).toEqual(halted);
    expect(t.store.events(t.id)).toEqual(before);
    expect(t.confirmations()).toHaveLength(0);
    expect(t.state.pushes).toBe(1);
  });

  it("resumes an already confirmed child before any read on the next startup", async () => {
    const t = await setup();
    await t.uncertain();
    t.state.readable = true;
    t.resume.mockRejectedValueOnce(Error("CONTAINED_MISSION_BUSY"));
    await t.recover(t.signal);
    expect(t.store.get(t.id).state).toBe("awaiting_decision");
    expect(t.events("verify_repair_push_confirmed")).toHaveLength(1);
    expect(JSON.parse(t.events("halted").at(-1)!.payload_json).reason).toBe("verify_push_uncertain");
    t.readPr.mockClear(); t.run.mockClear(); t.resume.mockClear();
    await t.recover(t.signal);
    expect(t.resume).toHaveBeenCalledExactlyOnceWith(t.id);
    expect(t.readPr).toHaveBeenCalledOnce();
    expect(t.resume.mock.invocationCallOrder[0]!).toBeLessThan(t.readPr.mock.invocationCallOrder[0]!);
    expect(t.run.mock.calls.map(([, args]) => args[0])).toEqual(["ls-remote"]);
    expect(t.store.get(t.id).state).toBe("pr_opened");
    expect(t.state.pushes).toBe(1);
    expect(t.check).not.toHaveBeenCalled();
  });

  it("continues to the next Mission after a busy child", async () => {
    const t = await setup();
    await t.uncertain();
    const earlier = t.store.authorize(t.actor, { scope_id: t.store.get(t.id).scope_id, spec: { ...t.spec },
      claim: { repo_identity: "earlier", branch: "earlier", worktree_identity: "earlier" } }, t.now - 1);
    t.store.transition(earlier.mission_id, { if_revision: earlier.revision, to: "awaiting_decision", event: { kind: "halted", payload: { reason: "verify_push_uncertain" } } }, t.now);
    for (const kind of ["verify_repair_push_intent", "verify_repair_push_confirmed"]) t.store.record(earlier.mission_id, kind, {}, t.now);
    t.state.readable = true;
    t.readPr.mockClear(); t.run.mockClear();
    t.resume.mockImplementationOnce(async () => {
      expect(t.readPr).not.toHaveBeenCalled();
      expect(t.run).not.toHaveBeenCalled();
      throw Error("CONTAINED_MISSION_BUSY");
    });
    await t.recover(t.signal);
    expect(t.resume.mock.calls).toEqual([[earlier.mission_id], [t.id]]);
    expect(t.log.mock.calls).toEqual([[`osstack: local-failure route: resume ${earlier.mission_id}: CONTAINED_MISSION_BUSY`]]);
    expect(t.store.get(t.id).state).toBe("pr_opened");
    expect(t.state.pushes).toBe(1);
  });

  it("stops before reads on abort and skips remote reads and resume after an in-flight abort", async () => {
    const t = await setup();
    await t.uncertain();
    t.run.mockClear(); t.readPr.mockClear();
    await t.recover(AbortSignal.abort());
    expect(t.readPr).not.toHaveBeenCalled();
    const abort = new AbortController();
    t.readPr.mockImplementationOnce(async (_repo, _number, signal) => {
      expect(signal).toBe(abort.signal);
      abort.abort();
      throw Error("aborted");
    });
    await t.recover(abort.signal);
    expect(t.run).not.toHaveBeenCalled();
    expect(t.resume).not.toHaveBeenCalled();
    expect(t.confirmations()).toHaveLength(0);
  });

  it("does no recovery work without a ready port", async () => {
    const t = await setup({ unavailable: true });
    t.store.record(t.id, "verify_repair_push_intent", {}, t.now);
    await t.recover(t.signal);
    expect(t.log).toHaveBeenCalledOnce();
    expect(t.readPr).not.toHaveBeenCalled();
    expect(t.resume).not.toHaveBeenCalled();
    expect(t.run).not.toHaveBeenCalled();
  });
});
