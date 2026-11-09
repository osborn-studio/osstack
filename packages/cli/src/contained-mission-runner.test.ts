import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AttentionStore, ContainedMissionStore, HostProcessStore, createScratchDirSync, openDb, type ContainedMission } from "@osstack/core";
import type { CodexProxyRun, CodexQualification } from "@osstack/agents";
import { afterEach, describe, expect, it } from "vitest";
import { ContainedMissionRunner, type ContainedMissionPorts, type ContainedMissionSpec } from "./contained-mission-runner.js";
import { parseMissionMarkers } from "./contained-mission-marker.js";
import { approveSandboxCiRepair, assertSandboxCiApproval } from "./contained-mission-github-ci-approval.js";
import { publishSandboxCiRepair } from "./contained-mission-github-ci-publish.js";
import { createSandboxCiObserver, createSandboxCiReader } from "./contained-mission-github-ci.js";
import { createSandboxCiMerge } from "./contained-mission-sandbox-ci-merge.js";
import { remoteTargetOf } from "./contained-mission-remote-writes.js";
import type { HostProcessRecord } from "@osstack/core";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const START = "a".repeat(40);
// Built by concatenation so this file itself never trips a secret scanner.
const FAKE_TOKEN = "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const PATCH = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-hi\n+hello\n";
const qualified: CodexQualification = { qualified: true, version: "codex-cli 0.160.1", identity_sha256: "f".repeat(64), profile: ":read-only",
  results: { parent: { write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" }, escaped_child: { write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" } },
  host_observed_writes: [], reasons: [] };
const run = (over: Partial<CodexProxyRun> = {}): CodexProxyRun => ({
  launch: { pid: 4242, pgid: 4242, started_at: 1 }, exit_code: 0, signal: null, timed_out: false, cancelled: false,
  stop: { stop_proof: "group_empty+sandbox_inherited", pgid: 4242, signals: [], confirmed_at: 2 },
  patch: { ok: true, text: PATCH, bytes: PATCH.length }, stdout: "done", stderr: "", stdout_truncated: false, stderr_truncated: false, ...over,
});

function setup(over: Partial<ContainedMissionPorts> = {}, specOver: Partial<ContainedMissionSpec> = {}) {
  const root = realpathSync(createScratchDirSync("tests", "contained-runner"));
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const store = new ContainedMissionStore(attention, owner);
  const files = new Map<string, string>([["src/a.txt", "hi\n"]]);
  const calls = { execute: [] as string[], commit: [] as unknown[], verify: 0, cumulative: [] as unknown[], publish: [] as Array<{ head: string; body: string }> };
  // Default cumulative diff: concatenate every turn's patch (enough for the fakes' single-file edits).
  const turns: string[] = [];
  let clock = 1000; let head = START; let verifyExit = 0; let cumulativeText: string | undefined;
  const ports: ContainedMissionPorts = {
    store, now: () => ++clock,
    createWorkspace: async () => ({ worktree: join(root, "wt"), gitDir: join(root, "repo", ".git"), head: START, configDigest: "sha256:" + "0".repeat(64) }),
    resumeWorkspace: async () => ({ worktree: join(root, "wt"), gitDir: join(root, "repo", ".git"), head: START, configDigest: "sha256:" + "0".repeat(64) }),
    qualify: async () => qualified,
    execute: async input => { calls.execute.push(input.prompt); input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 }); return run(); },
    readFile: async (_wt, p) => files.get(p) ?? null,
    commit: async input => { calls.commit.push(input); head = (head === START ? "b" : "c").repeat(40); return { head, tree: "d".repeat(40) }; },
    verify: async () => { calls.verify++; return { exit_code: verifyExit, output: verifyExit === 0 ? "ok" : "1 failed", cancelled: false, evidence: "docker-removed:x", stopped: true }; },
    cumulativeDiff: async input => { calls.cumulative.push(input); return cumulativeText ?? PATCH; },
    publish: async input => {
      calls.publish.push({ head: input.permit.head, body: input.body });
      input.beforeRemoteMutation("push"); input.beforeRemoteMutation("pr_create");
      return { pushed_commit: input.permit.head, pr: { number: 7, url: "https://github.com/o/r/pull/7", reused: false }, base_head: "e".repeat(40) };
    },
    restoreWorkspace: async () => {}, worktreeDiff: async () => ({ diff: PATCH, tree: "d".repeat(40), unsafe: [] }), commitWorktree: async () => ({ head: "e".repeat(40), tree: "d".repeat(40) }),
    ...over,
  };
  const spec: ContainedMissionSpec = { goal: "fix it", repo_path: join(root, "repo"), base_ref: "main", start_commit: START, branch: "osstack/m/1",
    worktree_path: join(root, "wt"), allowed_paths: ["src/**"], verify: { argv: ["pnpm", "test"] }, max_repair_cycles: 1, ...specOver };
  const mission = store.authorize({ principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [] },
    { scope_id: scope.scope_id, spec: spec as unknown as Record<string, unknown>, claim: { repo_identity: "repo", branch: spec.branch, worktree_identity: spec.worktree_path } }, 1000);
  const runner = new ContainedMissionRunner(ports);
  const kinds = () => store.events(mission.mission_id, 0, 500).map(e => e.kind);
  const allPayloads = () => store.events(mission.mission_id, 0, 500).map(e => e.payload_json).join("\n");
  void turns;
  return { store, runner, mission, calls, kinds, allPayloads, setVerifyExit: (n: number) => { verifyExit = n; }, setCumulative: (t: string) => { cumulativeText = t; } };
}
async function drive(f: ReturnType<typeof setup>, steps: number): Promise<ContainedMission> {
  let m = f.store.get(f.mission.mission_id);
  for (let i = 0; i < steps; i++) m = await f.runner.step(m.mission_id);
  return m;
}

describe("ContainedMissionRunner", () => {
  it("dispatches one repair and rechecks the latest CI attempt before accepting merge readback", async () => {
    const repository = "osborn-studio/osstack-bridge-sandbox";
    const branch = "osstack/mission/ci-seed";
    const f = setup({
      assertGithubCiScope: () => {},
      admitGithubCiCandidate: async () => {},
      publish: async ({ permit }) => ({ pushed_commit: permit.head, base_head: START,
        pr: { number: 7, url: `https://github.com/${repository}/pull/7`, reused: false } }),
    }, {
      branch, verification_mode: "github_actions", verify: { argv: [] }, max_repair_cycles: 0,
      allowed_paths: ["src/**", "PROBE_FAIL"],
      publication: { remote: "origin", repository, base: "main", draft: false, preauthorized: true },
    });
    const root = await drive(f, 5);
    expect(root.state, f.kinds().join(", ")).toBe("pr_opened");
    const spec = JSON.parse(root.spec_json) as ContainedMissionSpec;
    mkdirSync(spec.repo_path);
    const head = root.candidate_head!;
    const fixed = "c".repeat(40);
    const merge = "f".repeat(40);
    let currentHead = head;
    let merged = false;
    let pending = false;
    let attempt = 1;
    let mergeRequests = 0;
    let ciReadSignal: AbortSignal | undefined;
    let mergeSignal: AbortSignal | undefined;
    const observations: string[] = [];
    const repo = { id: 1446327922, full_name: repository };
    const app = { id: 15368 };
    const suite = { id: 19, app, head_sha: head };
    const check = { id: 41, name: "check", app, head_sha: head, check_suite: { id: suite.id }, status: "completed", conclusion: "failure" };
    const scope = root.scope_id;
    const actor = { principal_id: "human", client_session_id: "cli", read_scopes: [scope], write_scopes: [scope], stop_scopes: [], operator_scopes: [scope] };
    const mergeService = createSandboxCiMerge({ store: f.store, scopeId: scope, enabled: () => true, now: () => 2000,
      ci: createSandboxCiReader(), github: () => { throw Error("no network adapters in this closure fixture"); } });
    const observer = createSandboxCiObserver({
      store: f.store, scopeId: scope, enabled: () => true, now: () => 2000, log: line => observations.push(line), refresh: () => actor,
      worktreesRoot: join(spec.repo_path, "worktrees"),
      merge: {
        request: async (_root, _child, _target, signal) => { mergeRequests++; mergeSignal = signal; },
        acceptsMerge: mergeService.acceptsMerge,
      },
      ci: {
        now: () => new Date(2000),
        rest: async (path, { signal }) => {
          ciReadSignal = signal;
          observations.push(path);
          if (path.endsWith("/pulls/7")) return { ok: true, body: { number: 7, state: merged ? "closed" : "open", merged,
            head: { sha: currentHead, ref: branch, repo }, base: { sha: merged ? merge : START, ref: "main", repo }, user: { id: 352680398, type: "Bot" },
            ...(merged ? { merge_commit_sha: merge, merged_by: { id: 352681958, type: "Bot" } } : {}) } };
          if (path.endsWith(`/git/commits/${merge}`)) return { ok: true, body: { sha: merge, parents: [{ sha: START }] } };
          if (path.includes("/contents/")) return { ok: true, body: { sha: "562d683c3e9ab500aea73f09278a00d4cc266db1", type: "file" } };
          if (path.includes("/check-suites?")) return { ok: true, body: { total_count: 1, check_suites: [{ ...suite, head_sha: currentHead }] } };
          if (path.includes("/check-runs?")) return { ok: true, body: { total_count: 1, check_runs: [{
            ...check, head_sha: currentHead, conclusion: currentHead === head ? "failure" : "success",
          }] } };
          return { ok: false };
        },
        latestAttempt: async query => ({ ...query, complete: true, requests_used: 1,
          latest: { check_suite_id: suite.id, check_run_id: check.id, status: "completed", conclusion: "failure" } }),
        observeLatestJob: async query => ({ outcome: currentHead === head ? "failure" : pending ? "pending" : "success",
          run_id: currentHead === head ? 2 : 3, workflow_id: 407532337, attempt,
          check_run_id: check.id, check_suite_id: suite.id, job_id: check.id, job_name: query.name, runner_labels: ["ubuntu-latest"], matrix: {},
          workflow_path: ".github/workflows/ci.yml", head: currentHead, base: START, app_id: app.id }),
      },
    });
    try {
      await observer.scan();
      await observer.scan();
      const events = f.store.events(root.mission_id);
      expect(events.filter(event => event.kind === "ci_failure_observed"), observations.join("\n")).toHaveLength(1);
      const dispatched = events.filter(event => event.kind === "ci_repair_dispatched");
      expect(dispatched).toHaveLength(1);
      const child = f.store.get(JSON.parse(dispatched[0]!.payload_json).child as string);
      expect(child.state).toBe("authorized");
      expect(JSON.parse(child.spec_json)).toMatchObject({ start_commit: head, allowed_paths: ["PROBE_FAIL"],
        publication: { preauthorized: false }, ci_repair: { root: root.mission_id, branch, base: START, pr: 7, check_run_id: check.id } });
      const id = child.mission_id;
      const move = (to: ContainedMission["state"], candidate?: { head: string; tree: string; diff_digest: string }) => f.store.transition(id, {
        to, if_revision: f.store.get(id).revision, event: { kind: "fixture", payload: {} }, ...(candidate ? { candidate } : {}),
      }, 2000);
      move("workspace_ready"); move("executing");
      f.store.recordStopEvidence(id, f.store.get(id).revision, {}, 2000);
      move("candidate_ready", { head: fixed, tree: "d".repeat(40), diff_digest: "a".repeat(64) });
      move("verifying"); f.store.recordStopEvidence(id, f.store.get(id).revision, {}, 2000);
      move("verified"); move("revalidating"); move("delivering");
      const intent = { intent_id: "ci_fixture", candidate: fixed, previous: head, base: START, branch, pr: 7 };
      f.store.record(id, "ci_repair_push_intent", intent, 2000);
      const journal = new HostProcessStore(f.store.attention, f.store.owner, { clock: () => 2000 });
      const opId = "hp_fixture";
      journal.launching({ op_id: opId, mission_id: id, kind: "git_push", remote_target: remoteTargetOf(repository, branch),
        local_target: "/isolated/fixture", intent_id: intent.intent_id, argv_digest: "a".repeat(64), boot_id: "fixture",
        marker: { path: "/isolated/marker", dev: "1", ino: "1" } });
      journal.registered(opId, { pid: 4242, pgid: 4242, leader_start: null });
      journal.release(opId, () => {});
      journal.stopped(opId, { proof: "group_empty+marker_unheld", detail: {}, exit_code: 0 });
      f.store.record(id, "ci_repair_push_confirmed", { ...intent, op_id: opId }, 2000);
      const digest = "e".repeat(64);
      const pr = { number: 7, url: `https://github.com/${repository}/pull/7`, reused: true };
      f.store.record(id, "ci_delivery_evidence", { head: fixed, base_head: START, evidence_digest: digest }, 2000);
      f.store.transition(id, { to: "pr_opened", if_revision: f.store.get(id).revision, event: {
        kind: "pr_opened", payload: { pr, evidence_digest: digest, verification_kind: "github_actions" },
      } }, 2000);
      const kinds = () => f.store.events(root.mission_id).map(event => event.kind);
      currentHead = fixed;
      await observer.scan();
      expect(kinds()).toContain("ci_repair_verified");
      expect(mergeRequests).toBe(1);
      expect(mergeSignal).toBeDefined();
      expect(mergeSignal).not.toBe(ciReadSignal);
      f.store.record(id, "ci_auto_grant_reserved", {}, 2000);
      pending = true;
      attempt = 2;
      merged = true;
      await observer.scan();
      expect(kinds()).not.toContain("ci_pr_merged_observed");
      expect(kinds()).toContain("ci_pr_merge_unverified");
      pending = false;
      await observer.scan();
      expect(kinds()).not.toContain("ci_pr_merged_observed");
      expect(kinds().filter(kind => kind === "ci_repair_verified")).toHaveLength(1);
      attempt = 1;
      const handoff = { id: "82", expiresAt: 3000,
        binding: { repository, repositoryId: repo.id, pr: 7, head: fixed, base: START, branch } };
      f.store.record(root.mission_id, "ci_app_e_merge_reserved", handoff, 2000);
      await observer.scan();
      expect(kinds()).not.toContain("ci_pr_merged_observed");
      f.store.record(root.mission_id, "ci_app_e_merge_released", handoff, 2000);
      await observer.scan();
      const closed = f.store.events(root.mission_id).find(event => event.kind === "ci_pr_merged_observed");
      expect(JSON.parse(closed!.payload_json)).toMatchObject({ pr: 7, head: fixed, merge_commit_sha: merge,
        handoff_comment_id: 82, app_id: 5620091 });
    } finally { await observer.stop(); }
  });

  it("opens an admitted GitHub Actions Mission without a container receipt or App B check", async () => {
    let checks = 0;
    const f = setup({
      assertGithubCiScope: () => {},
      admitGithubCiCandidate: async () => {},
      publishVerifyCheck: async () => { checks++; return { check_run_id: 1, created: true }; },
    }, {
      branch: "osstack/mission/ci-seed",
      verification_mode: "github_actions", verify: { argv: [] }, max_repair_cycles: 0,
      publication: { remote: "origin", repository: "osborn-studio/osstack-bridge-sandbox", base: "main", draft: false, preauthorized: true },
    });
    const m = await drive(f, 5);
    expect(m.state).toBe("pr_opened");
    expect(f.calls.verify).toBe(0);
    expect(checks).toBe(0);
    expect(f.kinds()).toContain("ci_candidate_admitted");
    expect(f.kinds()).toContain("ci_delivery_evidence");
    expect(f.kinds()).not.toContain("verify_receipt");
    expect(f.kinds()).not.toContain("delivery_evidence");
    expect(f.calls.publish[0]?.body).toContain("GitHub Actions");
    await expect(f.runner.retryVerifyCheck(m.mission_id)).rejects.toThrow("github_ci_has_no_local_verify_check");
  });

  it("fails closed before opening a GitHub Actions Mission without a configured scope", async () => {
    const f = setup({}, {
      branch: "osstack/mission/ci-seed",
      verification_mode: "github_actions", verify: { argv: [] }, max_repair_cycles: 0,
      publication: { remote: "origin", repository: "osborn-studio/osstack-bridge-sandbox", base: "main", draft: false, preauthorized: true },
    });
    const m = await drive(f, 1);
    expect(m.state).toBe("awaiting_decision");
    expect(f.allPayloads()).toContain("github_ci_scope_unavailable");
    expect(f.calls.publish).toHaveLength(0);
  });

  it("requires a fresh operator approval for the exact repair commit after the local sandbox proposal", async () => {
    const deletion = "diff --git a/PROBE_FAIL b/PROBE_FAIL\ndeleted file mode 100644\n--- a/PROBE_FAIL\n+++ /dev/null\n@@ -1 +0,0 @@\n-ci pilot\n";
    const f = setup({
      assertGithubCiScope: () => {},
      admitGithubCiCandidate: async () => {},
      readFile: async (_worktree, path) => path === "PROBE_FAIL" ? "ci pilot\n" : null,
      cumulativeDiff: async () => deletion,
      execute: async input => {
        input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 });
        return run({ patch: { ok: true, text: deletion, bytes: deletion.length } });
      },
    }, {
      branch: "osstack/mission/ci-repair", allowed_paths: ["PROBE_FAIL"],
      verification_mode: "github_actions", verify: { argv: [] }, max_repair_cycles: 0,
      publication: { remote: "origin", repository: "osborn-studio/osstack-bridge-sandbox", base: "main", draft: false },
      ci_repair: { root: "cm_00000000-0000-4000-8000-000000000001", pr: 7, branch: "osstack/mission/ci-seed", base: "e".repeat(40), check_run_id: 9 },
    });
    const m = await drive(f, 4);
    expect(m.state).toBe("awaiting_decision");
    expect(f.calls.publish).toHaveLength(0);
    expect(f.calls.verify).toBe(0);
    await expect(f.runner.decide(m.mission_id, { kind: "approve_publication" })).rejects.toThrow("ci_repair_candidate_approval_required");
    const actor = { principal_id: "human", client_session_id: "cli", read_scopes: [m.scope_id], write_scopes: [m.scope_id], stop_scopes: [], operator_scopes: [m.scope_id] };
    expect(() => approveSandboxCiRepair(f.store, { ...actor, operator_scopes: [] }, m.mission_id, m.candidate_head!, 2000)).toThrow("permission_denied");
    expect(() => approveSandboxCiRepair(f.store, actor, m.mission_id, "f".repeat(40), 2000)).toThrow("ci_repair_approval_refused");
    const approved = approveSandboxCiRepair(f.store, actor, m.mission_id, m.candidate_head!, 2000);
    expect(approved.state).toBe("revalidating");
    const spec = JSON.parse(approved.spec_json) as ContainedMissionSpec;
    expect(() => assertSandboxCiApproval(f.store, approved, spec, () => actor, 2001)).not.toThrow();
    expect(() => assertSandboxCiApproval(f.store, approved, spec, () => actor, 2000 + 15 * 60_000)).toThrow("ci_repair_approval_invalid");
    expect(() => assertSandboxCiApproval(f.store, approved, spec, () => ({ ...actor, write_scopes: [] }), 2001)).toThrow("permission_denied");
    expect(() => assertSandboxCiApproval(f.store, { ...approved, candidate_head: START }, spec, () => actor, 2001)).toThrow("ci_repair_approval_invalid");
  });

  it.each([false, true])("only releases a single leased CI repair, with revoked=%s", async revoked => {
    const deletion = "diff --git a/PROBE_FAIL b/PROBE_FAIL\ndeleted file mode 100644\n--- a/PROBE_FAIL\n+++ /dev/null\n@@ -1 +0,0 @@\n-ci pilot\n";
    const f = setup({
      assertGithubCiScope: () => {},
      admitGithubCiCandidate: async () => {},
      readFile: async () => "ci pilot\n",
      cumulativeDiff: async () => deletion,
      execute: async input => {
        input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 });
        return run({ patch: { ok: true, text: deletion, bytes: deletion.length } });
      },
    });
    const repository = "osborn-studio/osstack-bridge-sandbox";
    const branch = "osstack/mission/ci-original";
    const base = "e".repeat(40);
    const spec = { ...(JSON.parse(f.mission.spec_json) as ContainedMissionSpec), branch: "osstack/mission/repair",
      worktree_path: "/tmp/fake-ci-worktree", allowed_paths: ["PROBE_FAIL"], max_repair_cycles: 0,
      verification_mode: "github_actions", verify: { argv: [] },
      publication: { repository, remote: "origin", base: "main", draft: false },
      ci_repair: { root: f.mission.mission_id, pr: 7, branch, base, check_run_id: 42 },
    } satisfies ContainedMissionSpec;
    const scope = f.mission.scope_id;
    const actor = { principal_id: "human", client_session_id: "cli", read_scopes: [scope], write_scopes: [scope], stop_scopes: [], operator_scopes: [scope] };
    let child = f.store.authorize(actor, { scope_id: scope, spec, claim: { repo_identity: "repo", branch: spec.branch, worktree_identity: spec.worktree_path } }, 1001);
    f.store.record(f.mission.mission_id, "ci_repair_dispatched", { child: child.mission_id }, 1001);
    for (let i = 0; i < 4; i++) child = await f.runner.step(child.mission_id);
    const candidate = child.candidate_head!;
    child = approveSandboxCiRepair(f.store, actor, child.mission_id, candidate, 2000);
    child = f.store.transition(child.mission_id, { if_revision: child.revision, to: "delivering", event: { kind: "delivery_intent", payload: {} } }, 2001);
    let pushed = 0;
    let atRelease = false;
    let remote = START;
    let stopped: HostProcessRecord | undefined;
    const repo = { id: 1446327922, full_name: repository };
    const pushInput = { mission: child, spec, permit: { mission_id: child.mission_id, revision: child.revision, head: candidate,
      tree: child.candidate_tree!, spec_digest: child.spec_digest }, body: "", beforeRemoteMutation: () => {}, signal: new AbortController().signal };
    const deps: Parameters<typeof publishSandboxCiRepair>[1] = {
      store: f.store, now: () => 2002, enabled: () => true,
      refresh: () => revoked && atRelease ? { ...actor, write_scopes: [] } : actor,
      host: { recordForIntent: () => stopped },
      readPr: async () => ({ number: 7, state: "open", merged: false, head: { sha: remote, ref: branch, repo }, base: { sha: base, ref: "main", repo }, user: { id: 352680398, type: "Bot" } }),
      runner: { gated: true, run: async (command, args, options) => {
        expect(command).toBe("git");
        if (args.includes("remote")) return { stdout: `https://github.com/${repository}.git\n`, stderr: "", exitCode: 0 };
        if (args.includes("ls-remote")) return { stdout: `${remote}\trefs/heads/${branch}\n`, stderr: "", exitCode: 0 };
        expect(args).toContain(`--force-with-lease=refs/heads/${branch}:${START}`);
        expect(args).toContain(`${candidate}:refs/heads/${branch}`);
        atRelease = true;
        options.gate!.fence();
        pushed++;
        remote = candidate;
        stopped = { state: "stopped", released_at: 2002, mission_id: child.mission_id, kind: "git_push",
          remote_target: `${repository}#refs/heads/${branch}`, op_id: "test-push" } as HostProcessRecord;
        return { stdout: "", stderr: "", exitCode: 0 };
      } },
    };
    if (revoked) {
      await expect(publishSandboxCiRepair(pushInput, deps)).rejects.toThrow("permission_denied");
      expect(pushed).toBe(0);
      expect(remote).toBe(START);
    } else {
      await expect(publishSandboxCiRepair(pushInput, deps)).resolves.toMatchObject({ pushed_commit: candidate, pr: { number: 7, reused: true } });
      await expect(publishSandboxCiRepair(pushInput, deps)).resolves.toMatchObject({ pushed_commit: candidate });
      expect(pushed).toBe(1);
      expect(f.store.events(child.mission_id).filter(e => e.kind === "ci_repair_push_intent")).toHaveLength(1);
      expect(f.store.events(child.mission_id).filter(e => e.kind === "ci_repair_push_confirmed")).toHaveLength(1);
    }
  });

  it("drives a Mission to verified, then waits for a publication decision", async () => {
    const f = setup();
    let m = await drive(f, 3);
    expect(m).toMatchObject({ state: "verified", candidate_head: "b".repeat(40), candidate_verified: 1, stop_obligation: 0 });
    expect(f.calls.commit).toEqual([expect.objectContaining({ expectedHead: START, files: [{ path: "src/a.txt", action: "write", content: "hello\n" }] })]);
    const kinds = f.kinds();
    expect(kinds.indexOf("executor_started")).toBeLessThan(kinds.indexOf("executor_output"));
    expect(kinds).toEqual(expect.arrayContaining(["qualification_probe", "executor_launch_intent", "executor_stopped", "t0_intent", "candidate_committed", "verify_intent", "verify_receipt", "t0_receipt"]));
    const receipt = JSON.parse(f.store.events(m.mission_id, 0, 500).find(e => e.kind === "t0_receipt")!.payload_json);
    expect(receipt).toMatchObject({ head_before: START, head_after: "b".repeat(40), verify_command: ["pnpm", "test"], verify_exit: 0 });
    m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("awaiting_decision");
    m = await f.runner.decide(m.mission_id, { kind: "approve_publication" });
    expect(m.state).toBe("revalidating");
  });

  it("stops before persisting anything when a channel carries a secret, and stores only redacted text", async () => {
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); return run({ stdout: `read ~/.config/gh/hosts.yml: ${FAKE_TOKEN}` }); } });
    const m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision");
    expect(f.calls.commit).toEqual([]);
    expect(f.allPayloads()).not.toContain(FAKE_TOKEN);
    expect(f.allPayloads()).toContain("secret_detected");
  });

  it("never records a patch that carries a secret", async () => {
    const leaking = `--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-hi\n+token=${FAKE_TOKEN}\n`;
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); return run({ patch: { ok: true, text: leaking, bytes: leaking.length } }); } });
    const m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision"); expect(f.calls.commit).toEqual([]);
    expect(f.allPayloads()).not.toContain(FAKE_TOKEN);
  });

  it("escalates a protected path to a decision without writing", async () => {
    const patch = "--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{\"scripts\":{}}\n";
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); return run({ patch: { ok: true, text: patch, bytes: patch.length } }); } }, { allowed_paths: ["**"] });
    const m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision"); expect(f.calls.commit).toEqual([]);
    expect(f.allPayloads()).toContain("tier_escalated");
    await expect(f.runner.decide(m.mission_id, { kind: "approve_publication" })).rejects.toThrow("CONTAINED_DECISION_NOT_ALLOWED");
    expect((await f.runner.decide(m.mission_id, { kind: "abandon" })).state).toBe("abandoned");
  });

  it("holds stop_unknown when the executor group was not proven empty", async () => {
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); const r = run(); delete (r as { stop?: unknown }).stop; return r; } });
    const m = await drive(f, 2);
    expect(m).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
    expect(f.calls.commit).toEqual([]);
  });

  it("clears the stop obligation when nothing was ever spawned", async () => {
    const f = setup({ execute: async () => { throw new Error("codex_proxy_spawn_failed: ENOENT"); } });
    const m = await drive(f, 2);
    expect(m).toMatchObject({ state: "awaiting_decision", stop_obligation: 0 });
  });

  it("does not execute when qualification fails", async () => {
    const f = setup({ qualify: async () => ({ ...qualified, qualified: false, reasons: ["HOST_OBSERVED_WRITE"] }) });
    const m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision"); expect(f.calls.execute).toEqual([]);
  });

  it("repairs within the budget, feeds back only the exit code and output, then asks for more", async () => {
    const f = setup(); f.setVerifyExit(1);
    let m = await drive(f, 3);
    expect(m.state).toBe("verify_failed");
    m = await f.runner.step(m.mission_id);
    expect(m).toMatchObject({ state: "candidate_ready", repair_cycles: 1 });
    expect(f.calls.execute[1]).toContain("failed verification (exit 1)");
    m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision");
    m = await f.runner.decide(m.mission_id, { kind: "extra_repair" });
    expect(m).toMatchObject({ state: "candidate_ready", repair_cycles: 2 });
  });

  it("states the proxy patch protocol on every executor turn", async () => {
    const f = setup(); f.setVerifyExit(1);
    await drive(f, 4);
    expect(f.calls.execute).toHaveLength(2);
    for (const prompt of f.calls.execute) { expect(prompt).toContain("unified diff"); expect(prompt.trimEnd()).toMatch(/END-OF-PATCH/); expect(prompt).toContain("fix it"); }
  });

  it("never writes a path that only appears inside hunk text", async () => {
    const smuggle = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1,3 @@\n-hi\n+hello\n+--- /dev/null\n++++ b/package.json\n";
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); return run({ patch: { ok: true, text: smuggle, bytes: smuggle.length } }); } });
    const m = await drive(f, 2);
    expect(m.state).toBe("candidate_ready");
    const files = (f.calls.commit[0] as { files: Array<{ path: string }> }).files;
    expect(files.map(x => x.path)).toEqual(["src/a.txt"]);
  });

  it("does not commit after a cancel that arrives during the host write", async () => {
    let unblock!: () => void; let reading!: () => void;
    const reached = new Promise<void>(resolve => { reading = resolve; });
    const f = setup({ readFile: async () => { reading(); await new Promise<void>(resolve => { unblock = resolve; }); return "hi\n"; } });
    let m = await f.runner.step(f.mission.mission_id);
    const pending = f.runner.step(m.mission_id);
    await reached;
    m = await f.runner.cancel(m.mission_id);
    expect(m.state).toBe("cancel_requested");
    unblock();
    m = await pending;
    expect(m.state).toBe("cancelled");
    expect(f.calls.commit).toEqual([]);
  });

  it("classifies the cumulative diff since start_commit, not one repair turn", async () => {
    const f = setup({}, { caps: { maxChangedLines: 3 } }); f.setVerifyExit(1);
    let m = await drive(f, 3);
    expect(m.state).toBe("verify_failed");
    const big = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1,4 @@\n-hi\n+h1\n+h2\n+h3\n+h4\n";
    f.setCumulative(big);
    m = await f.runner.step(m.mission_id);
    const intents = f.store.events(m.mission_id, 0, 500).filter(e => e.kind === "t0_intent").map(e => JSON.parse(e.payload_json) as { tier: string });
    expect(intents.map(i => i.tier)).toEqual(["T0", "T1"]);
    m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision");
    // A later turn whose own patch is clean but whose cumulative diff reaches a protected path.
    f.setCumulative("--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{\"x\":1}\n");
    m = await f.runner.decide(m.mission_id, { kind: "extra_repair" });
    expect(m.state).toBe("awaiting_decision");
    expect(f.allPayloads()).toContain('"cumulative":true');
    expect(f.calls.commit).toHaveLength(2);
  });

  it("keeps the stop obligation when the verifier cannot prove its container stopped", async () => {
    const f = setup({ verify: async () => ({ exit_code: 0, output: "ok", cancelled: false, evidence: "", stopped: false }) });
    const m = await drive(f, 3);
    expect(m).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
    await expect(f.runner.cancel(m.mission_id).then(x => x.state)).resolves.toBe("cancel_requested");
    const thrown = setup({ verify: async () => { throw new Error("docker_unreachable"); } });
    expect(await drive(thrown, 3)).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
  });

  it("waits for workspace creation to settle before a cancel completes", async () => {
    let finish!: () => void;
    const f = setup({ createWorkspace: async () => { await new Promise<void>(resolve => { finish = resolve; }); return { worktree: "w", gitDir: "g", head: START, configDigest: "d" }; } });
    const pending = f.runner.step(f.mission.mission_id);
    await new Promise(resolve => setTimeout(resolve, 10));
    const requested = await f.runner.cancel(f.mission.mission_id);
    expect(requested.state).toBe("cancel_requested");
    finish();
    expect((await pending).state).toBe("cancelled");
  });

  it("treats an unstopped qualification probe as stop_unknown", async () => {
    const f = setup({ qualify: async () => ({ ...qualified, qualified: false, reasons: ["PROBE_GROUP_NOT_STOPPED"] }) });
    const m = await drive(f, 2);
    expect(m).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
    expect(f.calls.execute).toEqual([]);
  });

  it("records stop evidence even when an output floods the secret scanner", async () => {
    const flood = Array.from({ length: 2000 }, (_, i) => `${FAKE_TOKEN.slice(0, -4)}${String(i).padStart(4, "0")}`).join("\n");
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); return run({ stdout: flood }); } });
    const m = await drive(f, 2);
    expect(m).toMatchObject({ state: "awaiting_decision", stop_obligation: 0 });
    const output = JSON.parse(f.store.events(m.mission_id, 0, 500).find(e => e.kind === "executor_output")!.payload_json) as { secret_hits: unknown[]; secret_hit_count: number };
    expect(output.secret_hits).toHaveLength(32); expect(output.secret_hit_count).toBe(2000);
  });

  it("re-probes before every repair turn and halts when the Codex build changed", async () => {
    let probes = 0; let identity = "f".repeat(64);
    const f = setup({ qualify: async () => { probes++; return { ...qualified, identity_sha256: identity }; } }, { max_repair_cycles: 2 });
    f.setVerifyExit(1);
    let m = await drive(f, 3);
    expect(m.state).toBe("verify_failed"); expect(probes).toBe(1);
    m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("candidate_ready"); expect(probes).toBe(2);
    m = await drive(f, 1);
    expect(m.state).toBe("verify_failed");
    identity = "e".repeat(64);
    m = await f.runner.step(m.mission_id);
    expect(m).toMatchObject({ state: "awaiting_decision", repair_cycles: 1 });
    expect(f.allPayloads()).toContain("executor_identity_changed");
    expect(f.calls.execute).toHaveLength(2);
  });

  it("cancels a live executor and settles once it is proven stopped", async () => {
    let release!: () => void;
    const f = setup({ execute: async input => {
      input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 });
      await new Promise<void>(resolve => { release = resolve; input.signal.addEventListener("abort", () => resolve()); });
      return run({ cancelled: true, patch: { ok: false, reason: "PATCH_MISSING" } });
    } });
    let m = await f.runner.step(f.mission.mission_id);
    const pending = f.runner.step(m.mission_id);
    await new Promise(resolve => setTimeout(resolve, 10));
    m = await f.runner.cancel(m.mission_id);
    expect(m.state).toBe("cancel_requested");
    m = await pending; release();
    expect(m).toMatchObject({ state: "cancelled", stop_obligation: 0 });
  });
});

describe("ContainedMissionRunner publication (M7)", () => {
  const publication = { remote: "origin", repository: "o/r", base: "main", draft: true };
  const toPending = async (f: ReturnType<typeof setup>) => { let m = await drive(f, 3); m = await f.runner.step(m.mission_id); return m; };

  it("opens the PR only after approval and re-validation, and records authoritative evidence", async () => {
    const f = setup({}, { publication });
    let m = await toPending(f);
    expect(m.state).toBe("awaiting_decision"); expect(f.calls.publish).toEqual([]);
    m = await f.runner.decide(m.mission_id, { kind: "approve_publication" });
    expect(m.state).toBe("revalidating");
    m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("pr_opened");
    expect(f.calls.publish).toEqual([{ head: "b".repeat(40), body: expect.stringContaining("OSStack never merges") }]);
    const kinds = f.kinds();
    expect(kinds.filter(k => k === "remote_mutation")).toHaveLength(2);
    expect(kinds.indexOf("delivery_intent")).toBeLessThan(kinds.indexOf("remote_mutation"));
    const evidence = JSON.parse(f.store.events(m.mission_id, 0, 500).find(e => e.kind === "delivery_evidence")!.payload_json);
    expect(evidence).toMatchObject({ schema_version: 1, repository: "o/r", head: "b".repeat(40), base: "main", base_head: "e".repeat(40), draft: true,
      pr: { number: 7 }, verify: { argv: ["pnpm", "test"], exit_code: 0 }, migrations_changed: false, protected_paths_changed: false });
    expect(evidence.evidence_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("ends the PR body with the one Mission marker and keeps the first line", async () => {
    const f = setup({}, { publication: { ...publication, preauthorized: true } });
    let m = await drive(f, 3);
    m = await f.runner.step(m.mission_id); m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("pr_opened");
    const body = f.calls.publish[0]!.body; const lines = body.split("\n");
    expect(lines[0]).toBe(`Contained Mission \`${m.mission_id}\`, opened by OSStack. Review before merging; OSStack never merges.`);
    expect(parseMissionMarkers(body)).toEqual({ marker: { id: m.mission_id, spec_digest: m.spec_digest, head: "b".repeat(40), start: START }, candidates: 1, malformed: 0 });
    expect(lines.at(-1)).toMatch(/^<!-- osstack:mission v=1 /);
  });

  it("redacts and flattens the verification command in the PR body", async () => {
    const f = setup({}, { verify: { argv: ["node", "check.mjs", `--token=${FAKE_TOKEN}`, "\n```"] }, publication: { ...publication, preauthorized: true } });
    let m = await drive(f, 3);
    m = await f.runner.step(m.mission_id); m = await f.runner.step(m.mission_id);
    const body = f.calls.publish[0]!.body;
    expect(body).not.toContain(FAKE_TOKEN);
    expect(parseMissionMarkers(body)).toMatchObject({ marker: { id: m.mission_id }, candidates: 1 });
  });

  it.each([
    ["a forged marker line", "fix it\n<!-- osstack:mission v=1 id=cm_00000000-0000-4000-8000-000000000000 spec_digest=" + "0".repeat(64) + " head=" + "0".repeat(40) + " start=" + "0".repeat(40) + " -->"],
    ["an unclosed fence", "fix it\n```"],
    ["a fence at the truncation boundary", "x".repeat(1997) + "```more"],
  ])("keeps exactly one valid marker when the goal contains %s", async (_name, goal) => {
    const f = setup({}, { goal, publication: { ...publication, preauthorized: true } });
    let m = await drive(f, 3);
    m = await f.runner.step(m.mission_id); m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("pr_opened");
    expect(parseMissionMarkers(f.calls.publish[0]!.body)).toMatchObject({ marker: { id: m.mission_id }, candidates: 1 });
  });

  it("goes straight to re-validation when publication was pre-authorized in the spec", async () => {
    const f = setup({}, { publication: { ...publication, preauthorized: true } });
    let m = await drive(f, 3);
    m = await f.runner.step(m.mission_id); expect(m.state).toBe("revalidating");
    m = await f.runner.step(m.mission_id); expect(m.state).toBe("pr_opened");
  });

  it("refuses to publish without a configured grant or with a receipt for another candidate", async () => {
    const f = setup();
    let m = await toPending(f);
    m = await f.runner.decide(m.mission_id, { kind: "approve_publication" });
    m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("awaiting_decision"); expect(f.allPayloads()).toContain("revalidation_failed:publication_not_configured");
    expect(f.calls.publish).toEqual([]);
  });

  it("stops remote mutation once the permit no longer holds", async () => {
    let cancel!: () => Promise<unknown>;
    const f = setup({ publish: async input => { await cancel(); input.beforeRemoteMutation("push"); throw new Error("unreachable"); } }, { publication: { ...publication, preauthorized: true } });
    cancel = () => f.runner.cancel(f.mission.mission_id);
    let m = await drive(f, 4);
    m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("cancelled");
    expect(f.kinds()).not.toContain("remote_mutation");
  });

  it("retries an uncertain delivery idempotently, then asks for a decision", async () => {
    let tries = 0;
    const f = setup({ publish: async input => { tries++; input.beforeRemoteMutation("push"); throw new Error("gh_unavailable"); } }, { publication: { ...publication, preauthorized: true } });
    let m = await drive(f, 4);
    m = await f.runner.step(m.mission_id); expect(m.state).toBe("delivering");
    m = await f.runner.step(m.mission_id); m = await f.runner.step(m.mission_id);
    expect(tries).toBe(3);
    m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("awaiting_decision"); expect(f.allPayloads()).toContain("publication_failed:attempts_exhausted");
    expect((await f.runner.decide(m.mission_id, { kind: "approve_publication" })).state).toBe("revalidating");
  });

  it("asks for a decision when publication fails before any remote mutation", async () => {
    const f = setup({ publish: async () => { throw new Error("CONTAINED_REPO_CONFIG_CHANGED"); } }, { publication: { ...publication, preauthorized: true } });
    let m = await drive(f, 4);
    m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("awaiting_decision"); expect(f.allPayloads()).toContain("publication_failed:CONTAINED_REPO_CONFIG_CHANGED");
  });

  it("halts for a decision with publication_failed:BRIDGE_DISABLED when the bridge kill switch refuses publication", async () => {
    let calls = 0;
    const f = setup({ publish: async () => { calls++; throw new Error("BRIDGE_DISABLED"); } }, { publication: { ...publication, preauthorized: true } });
    let m = await drive(f, 4);
    m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("awaiting_decision"); expect(f.allPayloads()).toContain("publication_failed:BRIDGE_DISABLED");
    expect(calls).toBe(1);
  });
});

describe("ContainedMissionRunner long histories", () => {
  it("keeps the delivery retry bound when the Mission has more than one page of events", async () => {
    let tries = 0;
    const f = setup({ publish: async input => { tries++; input.beforeRemoteMutation("push"); throw new Error("gh_unavailable"); } },
      { publication: { remote: "origin", repository: "o/r", base: "main", draft: true, preauthorized: true } });
    let m = await drive(f, 4);
    for (let i = 0; i < 600; i++) f.store.record(m.mission_id, "noise", { i }, 5000 + i);
    for (let i = 0; i < 4; i++) m = await f.runner.step(m.mission_id);
    expect(tries).toBe(3);
    expect(m.state).toBe("awaiting_decision");
  });
});

describe("ContainedMissionRunner verify check (bridge)", () => {
  const publication = { remote: "origin", repository: "o/r", base: "main", draft: true, preauthorized: true };
  const toOpened = async (f: ReturnType<typeof setup>) => { let m = await drive(f, 3); m = await f.runner.step(m.mission_id); return f.runner.step(m.mission_id); };

  it("records verify_check_published after the PR opened", async () => {
    const seen: string[] = [];
    const f = setup({ publishVerifyCheck: async m => { seen.push(m.state); return { check_run_id: 101, created: true }; } }, { publication });
    const m = await toOpened(f);
    expect(m.state).toBe("pr_opened"); expect(seen).toEqual(["pr_opened"]);
    const event = f.store.events(m.mission_id, 0, 500).find(e => e.kind === "verify_check_published")!;
    expect(JSON.parse(event.payload_json)).toEqual({ check_run_id: 101, created: true, head: "b".repeat(40) });
    expect(f.kinds().indexOf("pr_opened")).toBeLessThan(f.kinds().indexOf("verify_check_published"));
  });

  it("keeps the Mission pr_opened and records verify_check_failed when the check port fails", async () => {
    const f = setup({ publishVerifyCheck: async () => { throw new Error(`CONTAINED_VERIFY_CHECK_HTTP:403 ${FAKE_TOKEN}`); } }, { publication });
    const m = await toOpened(f);
    expect(m.state).toBe("pr_opened"); expect(f.store.get(m.mission_id).state).toBe("pr_opened");
    const event = f.store.events(m.mission_id, 0, 500).find(e => e.kind === "verify_check_failed")!;
    expect(JSON.parse(event.payload_json)).toEqual({ code: "CONTAINED_VERIFY_CHECK_HTTP" });
    expect(f.kinds()).not.toContain("verify_check_published");
    expect(f.allPayloads()).not.toContain(FAKE_TOKEN);
  });

  it("records no check event without the port", async () => {
    const f = setup({}, { publication });
    const m = await toOpened(f);
    expect(m.state).toBe("pr_opened");
    expect(f.kinds().filter(k => k.startsWith("verify_check"))).toEqual([]);
  });

  it("a ledger failure while recording the outcome never fails delivery", async () => {
    const f = setup({ publishVerifyCheck: async () => { throw new Error("CONTAINED_VERIFY_CHECK_NETWORK"); } }, { publication });
    const realRecord = f.store.record.bind(f.store);
    f.store.record = ((id: string, kind: string, ...rest: unknown[]) => { if (kind.startsWith("verify_check")) throw new Error("ledger"); return (realRecord as (...a: unknown[]) => unknown)(id, kind, ...rest); }) as typeof f.store.record;
    const m = await toOpened(f);
    expect(m.state).toBe("pr_opened");
  });

  it("retryVerifyCheck republishes for a pr_opened Mission and rejects other states or a missing port", async () => {
    let calls = 0;
    const f = setup({ publishVerifyCheck: async () => { calls++; return { check_run_id: 5, created: calls === 1 }; } }, { publication });
    await expect(f.runner.retryVerifyCheck(f.mission.mission_id)).rejects.toThrow("mission_not_pr_opened");
    await toOpened(f);
    expect(await f.runner.retryVerifyCheck(f.mission.mission_id)).toEqual({ check_run_id: 5, created: false });
    expect(f.kinds().filter(k => k === "verify_check_published")).toHaveLength(2);
    const bare = setup({}, { publication }); await toOpened(bare);
    await expect(bare.runner.retryVerifyCheck(bare.mission.mission_id)).rejects.toThrow("bridge_not_configured");
  });
});
